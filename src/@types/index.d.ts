type AnyRec<T = unknown> = Record<string, T>;
type JobError = { message: string; cause?: any };

type Job<TData = any, TResult = any> = {
    id: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    data: TData;
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    result?: TResult;
    error?: JobError;
}

type PersistenceAdapter<TJob extends Job> = {
    save: (job: TJob) => Promise<boolean>;
    load: () => Promise<TJob[]>;
    delete: (jobId: string) => Promise<boolean>;
    cleanupOrphans: (keepIds: Set<string>) => Promise<void>;
}

interface ILimiter {
    isFull: boolean;
    size: number;
    nLimit: number;
    acquire(): void;
    release(): void;
}