import type { FastifyInstance, FastifyRequest } from 'fastify';

import { objExtract, time, type MaybePromise } from '@giveback007/util-lib';
import { JobStore } from '../job-store.js';
import { QueueManager } from '../queue-manager.js';
import { Limiter } from '../limiter.js';
import { isDone } from '../rules/general.rules.js';

type JobData<T> = 
    | { ok: true;   data: T;            error?: undefined;                      status?: undefined; } 
    | { ok: false;  data?: undefined;   error: { message: string } & AnyRec;    status: number; }

type JobResult<T> = 
    | { ok: true;   data: T;            error?: undefined;  jobId: string; }
    | { ok: false;  data?: undefined;   error: JobError;    jobId: string; }

function cleanUp<TJob extends Job>(
    jobs: JobStore<TJob>,
    jobTLL: number,
    cleanupIntv: number,
    persistence?: PersistenceAdapter<TJob>,
) {
    const cleanupTimer = setInterval(() => {
        const now = Date.now();
        jobs.forEach((job, id) => {
            if (!isDone(job)) return;

            const age = now - (job.completedAt ?? job.createdAt)
            if (age >= jobTLL) jobs.del(id)
        })

        if (!persistence) return;
        const idSet = new Set(jobs.toArr().map(([, x]) => x.id))
        persistence.cleanupOrphans(idSet);
    }, cleanupIntv)
    cleanupTimer.unref()

    return cleanupTimer;
}

/** `TBody` (post req) -> `TData` (pre-check &/or pre-process before job) -> `TResult` (result after job) */
export function jobQueueRoutesConcurrent<
    /** Define the '/jobs' POST req body */
    TBody extends AnyRec,
    /** Shape of the data before job. */
    TData,
    /** Final output after job */
    TResult,
    TJob extends Job<TData, TResult> = Job<TData, TResult>,
>(
    app: FastifyInstance,
    opts: {
        concurrency: number;
        /** Runs on `POST "/jobs"` request. Create data to pass to processing.  */
        onJobRequest: (req: FastifyRequest<{ Body: TBody }>) => MaybePromise<JobData<TData>>;
        /** Used to re-initialize all jobs in case of server reboot */
        process: (data: TData) => Promise<JobResult<TResult>>;
        /** Runs on DELETE `/jobs/:id` is called */
        onDelete?: (job: TJob) => MaybePromise<boolean>,
        persistence?: PersistenceAdapter<TJob>;
        jobTTL?: number;        // ms, default 72h
        cleanupIntv?: number;   // ms, default 15min
        apiKey?: string;
    } 
    // 
    // & ({
    //     type: 'time-batch';
    //     // msBatchAccumulate: number;
    //     // batchProcess: (job: TJob[]) => Promise<JobResult<TResult>[]>;
    // })
) {    
    if (opts.apiKey) {
        app.addHook('onRequest', async (req, reply) => {
            if (req.url === '/health') return;

            const apiKey = req.headers['x-api-key']
                || (req.query as Record<string, string>)['api_key'];

            if (apiKey !== opts.apiKey) {
                reply.code(401).send({ error: 'unauthorized' });
            }
        });
    }

    app.get('/health', (_, reply) => {
        reply.code(200)
        return { ok: true }
    })

    const jobs = new JobStore<TJob>(opts);
    const queue = new QueueManager(new Limiter(opts.concurrency));

    async function status(job: TJob | TJob[], status: TJob['status']) {
        if (Array.isArray(job)) {
            return Promise.all(job.map(x => jobs.setStatus(x.id, status)));
        } else {
            const id = typeof job === 'string' ? job : job.id;
            return jobs.setStatus(id, status)
        }
    }

    const queueJob = (job: TJob)  => queue.enqueue(async () => {
        await status(job, "processing");
        try {
            const result = await opts.process(job.data);
            if (result.ok) {
                job.result = result.data;
                await status(job, 'completed');
            } else {
                job.error = result.error;
                await status(job, 'failed');
            }
        } catch(err: any) {
            console.error(err);

            job.error = { message: "Internal Error", cause: err.cause || err };
            await status(job, 'failed');
        }
    })

    // -- // -- // -- // |+| // -- // -- // -- //

    // Step 1: Receive the job request and set in queue
    app.post<{ Body: TBody }>('/jobs', async (req, reply) => {
        const result = await opts.onJobRequest(req);
        if (!result.ok) {
            reply.code(result.status);
            return { error: result.error };
        }

        const job = await jobs.add(result.data);
        queueJob(job);

        reply.code(201);
        return { id: job.id };
    });

    // Step 2: Poll for job status
    app.get<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
        const job = jobs.get(req.params.id);
        if (!job) { 
            reply.code(404); 
            return { error: { message: 'not found' } };
        }

        return objExtract(job, ['id', 'status', 'createdAt', 'startedAt', 'completedAt']);
    });

    // Step 3: Get the job result
    app.get<{ Params: { id: string } }>('/jobs/:id/result', async (req, reply) => {
        const job = jobs.get(req.params.id);
        if (!job) { 
            reply.code(404); 
            return { error: { message: 'not found' } };
        }

        if (!isDone(job)) { 
            reply.code(202); 
            return { error: { message: 'not ready' } };
        }

        return job;
    });

    // Step 4: Cleanup/delete job data
    app.delete<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
        const job = jobs.get(req.params.id);
        if (!job) { 
            reply.code(404); 
            return { error: { message: 'not found' } }; 
        }

        const didDelete = await jobs.del(job.id);

        reply.code(200);
        return { success: didDelete };
    });

    // -- // -- // -- // |+| // -- // -- // -- //

    const JOB_TTL = opts.jobTTL ?? time.hrs(72);
    const CLEANUP_INTERVAL = opts.cleanupIntv ?? time.min(15);
    const cleanupTimer = cleanUp(jobs, JOB_TTL, CLEANUP_INTERVAL);

    app.addHook('onReady', async () => {
        // status is only persisted on "failed", "completed", and "pending"
        // so we only need to check on "pending" ("processing" status is not persisted, treated as "pending" again)
        const saved = await jobs.loadFromPersistence();
        saved.filter(j => j.status === 'pending').forEach(queueJob);
    });

    app.addHook('onClose', () => clearInterval(cleanupTimer))
}

/* Save this code to use when need to create a batch version: */
// case 'time-batch':
//     let batch: TJob[] = [];
//     let timeout: ReturnType<typeof setTimeout> | null = null;
//     const batchProcess = opts.batchProcess;
//     function processBatch() {
//         queue.enqueue(async () => {
//             const _batch = batch;
//             batch = [];

//             await status(_batch, 'processing');
//             const results = await batchProcess(_batch);
//             await Promise.all(results.map(async res => {
//                 const job = jobs.get(res.jobId)!
//                 if (res.ok) {
//                     job.result = res.data;
//                     await status(job, 'completed')
//                 } else {
//                     job.error = res.error;
//                     await status(job, 'failed')
//                 }
//             }));
//         })
//     }

//     return (job: TJob) => {
//         batch.push(job);

//         if (timeout) return;
//         timeout = setTimeout(processBatch, opts.msBatchAccumulate)

//     }