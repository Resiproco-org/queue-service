export class Limiter implements ILimiter {
    private active = 0;
    private max: number;

    constructor(max: number) {
        this.max = max;
    }

    get size() { return this.active }
    get isFull() { return this.active >= this.max }
    get nLimit() { return this.max }

    acquire() {
        this.active++;
    }

    release() {
        this.active--;
    }

    setMaxConcurrent(n: number) {
        this.max = n;
    }
}

export class LimiterWithTime implements ILimiter {
    private active = 0;
    private timestamps: number[] = [];
    private maxConcurrent: number;
    private maxPerMinute: number;

    constructor(
        maxConcurrent: number,
        maxPerMinute: number,
    ) {
        this.maxConcurrent = maxConcurrent;
        this.maxPerMinute = maxPerMinute;
    }

    get size() { return this.active }
    get isFull() {
        this.pruneTimestamps();
        return this.active >= this.maxConcurrent
            || this.timestamps.length >= this.maxPerMinute;
    }
    get nLimit() { return this.maxConcurrent }

    acquire() {
        this.active++;
        this.timestamps.push(Date.now());
    }

    release() {
        this.active--;
    }

    setActive(n: number) {
        this.active = n;
    }

    setMaxConcurrent(n: number) {
        this.maxConcurrent = n;
    }

    setMaxPerMinute(n: number) {
        this.maxPerMinute = n;
    }

    private pruneTimestamps() {
        const cutoff = Date.now() - 60_000;
        
        let i = 0;
        while (i < this.timestamps.length && this.timestamps[i]! < cutoff) i++;
        if (i > 0) this.timestamps.splice(0, i);
    }
}