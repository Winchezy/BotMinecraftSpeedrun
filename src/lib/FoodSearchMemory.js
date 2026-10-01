const fs = require('fs');
const path = require('path');

class FoodSearchMemory {
    constructor(bot) {
        this.bot = bot;
        this.entries = new Map();
        this.lastSave = 0;
        let lastPosition=null;
        const track=()=>{
            if (!bot.isFoodExploring || !bot.entity?.position ||
                lastPosition && lastPosition.distanceTo(bot.entity.position)<2) return;
            lastPosition=bot.entity.position.clone();
            this.markVisited(lastPosition);
        };
        bot.on?.('move',track);
        bot.once?.('end',()=>bot.removeListener?.('move',track));
        if (bot.username) {
            this.filename = path.join(__dirname, '../../.bot-state', `food-${bot.username.replace(/[^a-z0-9_-]/gi, '_')}.json`);
            try { this.entries = new Map(JSON.parse(fs.readFileSync(this.filename, 'utf8'))); } catch (_) { }
            this.prune();
            const timer = setInterval(() => this.save(true), 5000);
            timer.unref();
            bot.once?.('end', () => { clearInterval(timer); this.save(true); });
        }
    }

    namespace() {
        return `${this.bot._client?.socket?.remoteAddress}:${this.bot._client?.socket?.remotePort}:${this.bot.game?.dimension || 'overworld'}`;
    }

    sector(point) { return `${Math.floor(point.x / 8)},${Math.floor(point.y / 8)},${Math.floor(point.z / 8)}`; }
    visitedKey(point) { return `${this.namespace()}:visited:${this.sector(point)}`; }
    routeKey(origin, target) { return `${this.namespace()}:route:${this.sector(origin)}>${this.sector(target)}`; }

    allowed(origin, target, checkVisited = true, now = Date.now()) {
        return (this.entries.get(this.routeKey(origin, target)) || 0) <= now &&
            (!checkVisited || (this.entries.get(this.visitedKey(target)) || 0) <= now);
    }

    markVisited(point, now = Date.now()) { this.record(this.visitedKey(point), now + 60000, now); }
    markBlocked(origin, target, status = 'noPath', now = Date.now()) {
        const delay = status === 'danger' ? 20000 : status === 'noPath' ? 120000 : 30000;
        this.record(this.routeKey(origin, target), now + delay, now);
    }
    record(key, expires, now) { this.entries.set(key, expires); this.prune(now); this.save(); }
    prune(now = Date.now()) {
        for (const [key, expires] of this.entries) if (!Number.isFinite(expires) || expires <= now) this.entries.delete(key);
        while (this.entries.size > 512) this.entries.delete(this.entries.keys().next().value);
    }
    save(force = false) {
        if (!this.filename || !force && Date.now() - this.lastSave < 5000) return;
        try {
            fs.mkdirSync(path.dirname(this.filename), { recursive: true });
            fs.writeFileSync(this.filename + '.tmp', JSON.stringify([...this.entries]));
            fs.renameSync(this.filename + '.tmp', this.filename);
            this.lastSave = Date.now();
        } catch (error) { console.log(`[FoodSearchMemory] ${error.message}`); }
    }
}

module.exports = FoodSearchMemory;
