class Task {
    constructor(bot) {
        this.bot = bot;
        this.done = false;
        this.hasFailed = false;
        this.name = 'BaseTask';
    }

    async run() {
        throw new Error('run() must be implemented');
    }

    isDone() {
        return this.done;
    }

    complete() {
        const lease = this.bot.actions?.context.getStore();
        if (lease && !this.bot.actions.valid(lease)) return;
        this.done = true;
        console.log(`Task ${this.name} completed.`);
    }

    fail(reason) {
        const lease = this.bot.actions?.context.getStore();
        if (lease && !this.bot.actions.valid(lease)) return;
        console.error(`Task ${this.name} failed: ${reason}`);
        this.failureReason = reason;
        this.done = true; // Fail also ends the task execution loop usually
        this.hasFailed = true;
    }
}

module.exports = Task;
