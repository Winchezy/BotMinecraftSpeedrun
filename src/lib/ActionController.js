const { AsyncLocalStorage } = require('node:async_hooks');

class ActionInterrupted extends Error {
    constructor(reason) { super(reason); this.code = 'ACTION_INTERRUPTED'; }
}

// Une autorisation unique pour les commandes ; AsyncLocalStorage conserve son
// identite apres chaque await, meme quand l'ancien travail termine tardivement.
class ActionController {
    constructor(bot) {
        this.bot = bot;
        this.context = new AsyncLocalStorage();
        this.current = null;
        this.closed = false;
        this.original = {};
        this.install(bot, ['setControlState', 'clearControlStates', 'activateItem', 'deactivateItem', 'attack', 'stopDigging', 'closeWindow']);
        this.install(bot, ['dig', 'equip', 'look', 'lookAt', 'placeBlock', 'activateBlock', 'craft', 'consume',
            'waitForTicks', 'openFurnace', 'openChest', 'openContainer', 'openBlock', 'openEntity',
            'clickWindow', 'transfer', 'moveSlotItem', 'putAway', 'toss', 'tossStack'], true);
        this.install(bot.pathfinder, ['setGoal', 'setMovements', 'stop'], false, 'pathfinder');
        this.install(bot.pathfinder, ['goto'], true, 'pathfinder');
        this.install(bot.collectBlock, ['collect', 'cancelTask'], true, 'collectBlock');
        this.install(bot.pvp, ['attack', 'stop'], true, 'pvp');
        bot.on?.('death', () => { this.paused = true; this.cancel('Mort du bot'); });
        bot.on?.('spawn', () => { this.paused = false; });
        bot.on?.('end', () => { this.closed = true; this.cancel('Deconnexion'); });
    }

    install(object, names, asynchronous = false, prefix = 'bot') {
        if (!object) return;
        for (const name of names) {
            if (typeof object[name] !== 'function') continue;
            const original = object[name].bind(object);
            this.original[`${prefix}.${name}`] = original;
            object[name] = (...args) => {
                const lease = this.context.getStore();
                const error = this.closed || lease && !this.valid(lease) ?
                    new ActionInterrupted('Autorisation de commande interrompue') : null;
                if (error) {
                    if (asynchronous) return Promise.reject(error);
                    throw error;
                }
                if (!asynchronous) return original(...args);
                const action = Promise.resolve().then(() => {
                    if (lease && !this.valid(lease)) throw new ActionInterrupted('Action annulee avant execution');
                    return original(...args);
                });
                if (!lease) return action;
                return this.interruptible(action, lease);
            };
        }
    }

    valid(lease) { return !!lease && !lease.signal.aborted && this.current === lease; }

    interruptible(action, lease) {
        return new Promise((resolve, reject) => {
            const abort = () => reject(new ActionInterrupted(lease.signal.reason || 'Action interrompue'));
            if (lease.signal.aborted) { action.catch(() => {}); abort(); return; }
            lease.signal.addEventListener('abort', abort, { once: true });
            action.then(resolve, reject).finally(() => lease.signal.removeEventListener('abort', abort));
        });
    }

    stopActions() {
        // Les arrets viennent du controleur, jamais du contexte deja revoque.
        this.context.run(undefined, () => {
            try { this.bot.collectBlock?.targets?.clear(); } catch (_) {}
            try { this.bot.pvp?.forceStop(); } catch (_) {}
            try { if (this.bot.currentWindow) this.original['bot.closeWindow']?.(this.bot.currentWindow); } catch (_) {}
            for (const key of ['pathfinder.setGoal', 'bot.stopDigging', 'bot.deactivateItem', 'bot.clearControlStates']) {
                try {
                    const result = this.original[key]?.(...(key.endsWith('setGoal') ? [null] : []));
                    result?.catch?.(() => {});
                } catch (_) {}
            }
        });
    }

    acquire(owner, priority) {
        if (this.closed || this.paused) return null;
        if (this.current?.owner === owner) return this.current;
        if (this.current && this.current.priority >= priority) return null;
        if (this.current) {
            console.log(`[ActionController] ${this.current.owner} -> ${owner}`);
            this.cancel(`Priorite donnee a ${owner}`);
        }
        const abort = new AbortController();
        const lease = { owner, priority, abort, signal: abort.signal, movements: this.bot.pathfinder?.movements };
        this.current = lease;
        return lease;
    }

    cancel(reason) {
        const previous = this.current;
        this.current = null;
        previous?.abort.abort(reason);
        this.stopActions();
        if (previous?.movements) {
            this.context.run(undefined, () => {
                try { this.original['pathfinder.setMovements']?.(previous.movements); } catch (_) {}
            });
        }
    }

    release(lease) {
        if (!this.valid(lease)) return;
        this.current = null;
        lease.abort.abort('Activite terminee');
    }

    with(lease, action) {
        if (!this.valid(lease)) return Promise.reject(new ActionInterrupted('Activite interrompue'));
        return this.context.run(lease, action);
    }

    async run(owner, priority, action, { persistent = false } = {}) {
        const lease = this.acquire(owner, priority);
        if (!lease) return;
        try {
            return await this.interruptible(Promise.resolve(this.with(lease, action)), lease);
        } catch (error) {
            if (error.code !== 'ACTION_INTERRUPTED') throw error;
        } finally { if (!persistent) this.release(lease); }
    }
}

module.exports = ActionController;
