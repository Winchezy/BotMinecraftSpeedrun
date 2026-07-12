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
        this.done = true;
        console.log(`Task ${this.name} completed.`);
    }

    fail(reason) {
        console.error(`Task ${this.name} failed: ${reason}`);
        this.done = true; // Fail also ends the task execution loop usually
        this.hasFailed = true;
    }
}

module.exports = Task;
