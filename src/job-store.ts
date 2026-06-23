import { randomUUID } from "node:crypto";

export class JobStore<TJob extends Job> {
    private jobs = new Map<string, TJob>();
    private persistence?: PersistenceAdapter<TJob> | null;

    constructor(
        persistence: PersistenceAdapter<TJob> | null = null
    ) {
        this.persistence = persistence;
    }

    get = (id: string) => this.jobs.get(id);
    set = (id: string, val: TJob) => this.jobs.set(id, val);
    del = (id: string) => {
        this.jobs.delete(id);
        this.persistence?.delete(id);
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

    setStatus = async (id: string, status: TJob['status']) => {
        const job = this.jobs.get(id)
        if (!job) return false;

        job.status = status;
        const isDone = status === 'completed' || status === 'failed';
        if (isDone) {
            job.completedAt = Date.now();
            if (this.persistence) return await this.persistence.save(job);
        } else if (status === 'processing') {
            job.startedAt = Date.now();
        }

        return true
    }
}