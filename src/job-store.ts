import type { MaybePromise } from "@giveback007/util-lib";

import { randomUUID } from "node:crypto";
import { isDone } from "./rules/general.rules.js";

export class JobStore<TJob extends Job> {
    private jobs = new Map<string, TJob>();
    private persistence: PersistenceAdapter<TJob> | undefined;
    private onDelete: ((job: TJob) => MaybePromise<boolean>) | undefined;

    constructor(opts: {
        persistence?: PersistenceAdapter<TJob>,
        onDelete?: (job: TJob) => MaybePromise<boolean>,
    } = {}) {
        this.persistence = opts.persistence;
        this.onDelete = opts.onDelete;
    }

    get = (id: string) => this.jobs.get(id);
    set = (id: string, val: TJob) => this.jobs.set(id, val);
    del = async (id: string) => {
        const job = this.get(id);
        this.jobs.delete(id);
        
        await this.persistence?.delete(id);
        return job ? this.onDelete?.(job) : true;
    }
    get size() { return this.jobs.size; }

    forEach = (
        fn: (value: TJob, key: string, map: Map<string, TJob>) => any
    ) => this.jobs.forEach(fn);

    toArr = () => [...this.jobs];

    add = async (data: TJob['data']): Promise<TJob> => {
        const job = {
            id: randomUUID(),
            status: 'pending',
            createdAt: Date.now(),
            data
        } as TJob;

        this.jobs.set(job.id, job);
        await this.persistence?.save(job);

        return job;
    }

    /** Load jobs from persistence */
    loadFromPersistence = async () => {
        if (!this.persistence) return [];

        const saved = await this.persistence.load();
        for (const job of saved) this.jobs.set(job.id, job);

        return saved;
    }

    setStatus = async (id: string, status: TJob['status']) => {
        const job = this.jobs.get(id)
        if (!job) return false;

        job.status = status;
        if (isDone(job)) {
            job.completedAt = Date.now();
            if (this.persistence) return await this.persistence.save(job);
        } else if (status === 'processing') {
            job.startedAt = Date.now();
        }

        return true
    }
}