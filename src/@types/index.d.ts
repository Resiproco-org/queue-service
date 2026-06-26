type AnyRec<T = unknown> = Record<string, T>;
type JobError = { message: string; name?: string; stack?: string; code?: any; cause?: any } & AnyRec;

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

type JobData<T> = 
    | { ok: true;   data: T;            error?: undefined;                      status?: undefined; } 
    | { ok: false;  data?: undefined;   error: { message: string } & AnyRec;    status: number; }

type JobResult<T> = 
    | { ok: true;   data: T;            error?: undefined;  jobId: string; }
    | { ok: false;  data?: undefined;   error: JobError;    jobId: string; }

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