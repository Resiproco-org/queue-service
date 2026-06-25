// Not tested so I wont ship for now, leave this when need to implement and test:
// export class BatchProcessManager<T extends { id: string }, R = any> {
//     private batch: { resolve: (value: any) => void; data: T; }[] = [];
//     private flushTimer: ReturnType<typeof setTimeout> | null = null;
//     private queueManager: QueueManager<any>;
//     private msTimeAccumulate: number;
//     private processBatch: (batch: T[]) => 
//         Promise<{ id: string; res: R }[]> | { id: string; res: R }[]

//     constructor(
//         /** concurrency limiter */
//         limit: ILimiter,
//         /** wait time from initiation before executing processing */
//         msTimeAccumulate: number,
//         processBatch: typeof this.processBatch,
//     ) {
//         this.msTimeAccumulate = msTimeAccumulate;
//         this.processBatch = processBatch;
//         this.queueManager = new QueueManager(limit);
//     }

//     enqueue = (data: T) => {
//         const { resolve, promise } = promiseOut();
//         this.batch.push({ resolve, data });

//         this.scheduleFlush();
//         return promise;
//     }

//     private scheduleFlush = () => {
//         if (this.flushTimer) return;
        
//         this.flushTimer = setTimeout(() => {
//             this.queueManager.enqueue(async () => {
//                 this.flushTimer = null;
//                 const _batch = this.batch;
//                 this.batch = [];

//                 const map = new Map(_batch.map(x => [x.data.id, x]));
//                 const results = await this.processBatch(_batch.map(x => x.data));
//                 results.forEach(x => map.get(x.id)?.resolve(x.res));
//             })
//         }, this.msTimeAccumulate);
//     }
// }

export class QueueManager<T, Fn extends () => Promise<T> = () => Promise<T>> {
    private queue: (() => Promise<void>)[] = [];
    private limit: ILimiter;
    private opts: { 
        logger?: boolean, 
        loggerName?: string 
    };

    constructor(
        limit: typeof this.limit,
        opts: typeof this.opts = {}
    ) {
        this.limit = limit;
        this.opts = opts;
    }

    enqueue = (fn: Fn) => new Promise<T>((res, rej) => {
        this.queue.push(async () => {
            try {
                const result = await fn();
                res(result);
            } catch(error) {
                rej(new Error('QueueManager | processing queue item', { cause: error }))
            }
        });

        this.logState()
        this.drain();
    })

    private logState = () => {
        if (this.opts.logger)
            console.log(`(${this.opts.loggerName || ''}) In-Queue: ${this.queue.length} | ${this.limit.size}/${this.limit.nLimit}`);
    }

    private process = async (fn: () => Promise<void>) => {
        this.limit.acquire();
        this.logState();
        
        try {
            await fn();
        } catch(err) {
            // TODO: send to sentry
            console.error(err);
        } finally {
            this.limit.release();
            this.drain(); // ! <- Run Again After Release Of Limit
            this.logState();
        }
    }

    private drain = () => {
        while (!this.limit.isFull && this.queue.length) {
            const item = this.queue.shift()!;
            this.process(item)
        }
    }
}