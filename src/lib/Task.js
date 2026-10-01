class Task {
    constructor(bot) {
        this.bot = bot;
        this.done = false;
        this.hasFailed = false;
        this.cancelled = false;
        this.name = 'BaseTask';
    }

    async run() {
        throw new Error('run() must be implemented');
    }

    isDone() {
        return this.done;
    }

    complete() {
        this.done = true;
        console.log(`Task ${this.name} completed.`);
    }

    fail(reason) {
        console.error(`Task ${this.name} failed: ${reason}`);
        this.done = true; // Fail also ends the task execution loop usually
        this.hasFailed = true;
    }

    // Appelé par l'Agent quand il abandonne la tâche (watchdog, interruption faim).
    // Le run() en cours n'est PAS stoppé par Promise.race : les boucles longues
    // doivent tester `this.cancelled` pour s'arrêter, sinon deux tâches pilotent le bot.
    cancel() {
        this.cancelled = true;
        this.done = true;
        this.hasFailed = true;
    }
}

module.exports = Task;
