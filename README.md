# Job Queue Service Lib
Job queue toolkit for Fastify with concurrency control, persistence, and auto-cleanup.

```bash
pnpm add @resiproco/queue-service
```

---

## 1. Minimal server

```ts
import Fastify from 'fastify'
import { jobQueueRoutesConcurrent } from '@resiproco/queue-service'

const app = Fastify()

jobQueueRoutesConcurrent(app, {
    concurrency: 5,
    onJobRequest: (req) => ({ ok: true, data: req.body }),
    process: async (data) => ({ ok: true, jobId: data.id, data }),
})

await app.listen({ port: 3000 })
```

That's it. `GET /health` is ready, `POST /jobs` accepts any body and echoes it back.

---

## 2. Full example (all options)

```ts
import Fastify from 'fastify'
import { jobQueueRoutesConcurrent, PersistenceViaJsonFiles } from '@resiproco/queue-service'
import { numRandInt, wait } from '@giveback007/util-lib'
import { join } from 'node:path'

const app = Fastify()

jobQueueRoutesConcurrent<
    { id: string },                                   // TBody  — POST body shape
    { id: string, start: number },                    // TData  — what process() receives
    { id: string, start: number, end: number }        // TResult — what process() returns
>(app, {
    concurrency: 150,
    onJobRequest: (req) => ({ ok: true, data: { id: req.body.id, start: Date.now() } }),
    process: async (data) => {
        await wait(numRandInt(1, 12) * 1000)
        return { ok: true, jobId: data.id, data: { ...data, end: Date.now() } }
    },
    persistence: new PersistenceViaJsonFiles(join(import.meta.dirname, 'jobs')),
    apiKey: process.env.API_KEY,
    jobTTL: 12 * 60 * 60 * 1000,       // delete completed/failed jobs after 12h
    cleanupIntv: 5 * 60 * 1000,        // sweep every 5 minutes
    onDelete: async (job) => {
        console.log(`job ${job.id} deleted`)
        return true
    },
})

await app.listen({ port: 3000 })
```

This includes everything: typed generics, concurrency limiting, disk persistence with atomic writes, API key auth, auto-cleanup of expired jobs, and a delete hook.

---

## 3. Typed job processing

Use generics to define the request body, the data shape (what the job works with), and the result.

```ts
import { numRandInt, wait } from '@giveback007/util-lib'

jobQueueRoutesConcurrent<
    { fileUrl: string },                         // TBody  — POST request body
    { fileUrl: string },                         // TData  — shape passed to process()
    { fileUrl: string, sizeBytes: number }       // TResult — shape returned by process()
>(app, {
    concurrency: 150,
    onJobRequest: (req) => ({ ok: true, data: { fileUrl: req.body.fileUrl } }),
    process: async (data) => {
        await wait(numRandInt(1, 12) * 1000)    // simulate work
        return { ok: true, jobId: data.fileUrl, data: { ...data, sizeBytes: 42 } }
    },
})
```

**Flow:** `POST /jobs` body → `onJobRequest` converts to `TData` → `process()` computes `TResult`.

The client polls with:

```ts
// POST a job
const { id } = await fetch('http://localhost:3000/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileUrl: 'https://example.com/doc.pdf' }),
}).then(r => r.json())

// poll status
let job
while (true) {
    job = await fetch(`http://localhost:3000/jobs/${id}`).then(r => r.json())
    if (job.status === 'completed' || job.status === 'failed') break
    await wait(1500)
}

// get result
const result = await fetch(`http://localhost:3000/jobs/${id}/result`).then(r => r.json())
console.log(result)
```

---

## 4. Persistence (survive server restarts)

Jobs persist to disk with atomic writes. On server reboot, pending jobs are re-queued automatically.

```ts
import { PersistenceViaJsonFiles } from '@resiproco/queue-service'
import { join } from 'node:path'

jobQueueRoutesConcurrent(app, {
    concurrency: 150,
    onJobRequest: (req) => ({ ok: true, data: req.body }),
    process: async (data) => ({ ok: true, jobId: data.id, data }),
    persistence: new PersistenceViaJsonFiles(join(import.meta.dirname, 'jobs')),
})
```

Each job writes to `jobs/{id}.persist.temp` then atomically renames to `jobs/{id}.persist.json` — no partial writes. When a job is deleted, both the `.persist.json` and any stale `.persist.temp` are removed.

If the server crashes, pending jobs are re-queued from the persisted files on the next start. Processing jobs are reset to pending (since their status was never persisted mid-flight).

---

## 5. API key auth

```ts
jobQueueRoutesConcurrent(app, {
    // ...
    apiKey: process.env.API_KEY,
})
```

Every route except `/health` requires `x-api-key` or `?api_key=...` to match. Unauthorized requests get 401.

---

## 6. Auto-cleanup of old jobs

Completed and failed jobs are automatically deleted after a configurable TTL.

```ts
jobQueueRoutesConcurrent(app, {
    // ...
    jobTTL: 12 * 60 * 60 * 1000,     // delete jobs older than 12 hours
    cleanupIntv: 5 * 60 * 1000,       // check every 5 minutes
})
```

Defaults: `jobTTL` = 72h, `cleanupIntv` = 15min. Orphaned persistence files (belonging to no in-memory job) are also swept up on the same interval.

---

## 7. Concurrency primitives

The low-level primitives are exported for standalone use.

### `Limiter`

```ts
import { Limiter } from '@resiproco/queue-service'

const limit = new Limiter(3)

limit.acquire()
limit.acquire()
limit.acquire()
limit.isFull // true

// do work...

limit.release()
limit.isFull // false
```

### `LimiterWithTime`

Limits both concurrent and max-per-minute operations.

```ts
import { LimiterWithTime } from '@resiproco/queue-service'

const limit = new LimiterWithTime(5, 100)  // 5 concurrent, 100 per minute

limit.acquire()
// limit.isFull checks both concurrent count AND the per-minute rate
```

### `QueueManager`

A FIFO queue that drains under a limiter. No more than N items run at once; the rest wait.

```ts
import { QueueManager, Limiter } from '@resiproco/queue-service'

const queue = new QueueManager(new Limiter(3))

queue.enqueue(() => heavyTask())
queue.enqueue(() => heavyTask())
// 4th call waits until one of the first 3 finishes
```

### `BatchProcessManager`

Accumulates items over a time window, then flushes them as a batch.

```ts
import { BatchProcessManager, Limiter } from '@resiproco/queue-service'

const manager = new BatchProcessManager(
    new Limiter(2),
    1000,                                               // accumulate for 1s
    async (batch) => batch.map(x => ({ id: x.id, res: 'done' })),
)

const result1 = await manager.enqueue({ id: 'a' })
const result2 = await manager.enqueue({ id: 'b' })
```

### `JobStore`

In-memory job lifecycle manager with optional persistence.

```ts
import { JobStore, PersistenceViaJsonFiles } from '@resiproco/queue-service'

const store = new JobStore({ persistence: new PersistenceViaJsonFiles('./data') })

const job = await store.add({ url: 'https://...' })    // status: pending
await store.setStatus(job.id, 'processing')
await store.setStatus(job.id, 'completed')

store.get(job.id)?.status // 'completed'
await store.del(job.id)  // also removes persisted file
```

On server restart, rebuild the store from persistence:

```ts
const saved = await store.loadFromPersistence()
// re-queue any jobs that were still pending when the server went down
saved.filter(j => j.status === 'pending').forEach(queueJob)
```

---

## 8. File uploads

For services that accept file uploads (`multipart/form-data`), the lib provides a pipeline for receiving, validating, and cleaning up files.

### Quick start

```ts
import Fastify from 'fastify'
import {
    jobQueueRoutesConcurrent, createFileUploadHandlers,
    initDataDirs, mimeConfig, registerMultipart,
    PersistenceViaJsonFiles
} from '@resiproco/queue-service'

const DIRS = await initDataDirs('./data')
const MIME = mimeConfig({ 'application/pdf': 'pdf' } as const)

const app = Fastify()
await registerMultipart(app, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } })

const upload = createFileUploadHandlers(DIRS, MIME.allowed)

jobQueueRoutesConcurrent(app, {
    concurrency: 5,
    persistence: new PersistenceViaJsonFiles(DIRS.PERSISTENCE),
    onJobRequest: upload.onJobRequest,   // receives file, streams to disk
    process: async (data) => ({ ok: true, jobId: data.id, data: {} }),
    onDelete: (job) => upload.onDelete(job.data),  // removes all task files
})
```

The client sends a multipart POST:

```ts
import { readFile } from 'node:fs/promises'

const pdf = await readFile('./document.pdf')
const file = new File([pdf], 'document.pdf', { type: 'application/pdf' })

const form = new FormData()
form.append('file', file, 'document.pdf')

const { id } = await fetch('http://localhost:3000/jobs', {
    method: 'POST',
    headers: { 'x-api-key': '...' },
    body: form,  // fetch sets multipart boundary automatically
}).then(r => r.json())
```

### `createFileUploadHandlers(dirs, allowedMimeTypes?)`

Factory that returns the `onJobRequest` + `onDelete` pair wired together.

```ts
import { createFileUploadHandlers } from '@resiproco/queue-service'

const upload = createFileUploadHandlers(DIRS, MIME.allowed)
// → { onJobRequest: (req) => ..., onDelete: (paths: FilePaths) => ... }
```

`onDelete` accepts `FilePaths` directly — pass it through in your opts:
```ts
onDelete: (job) => upload.onDelete(job.data),
```

When `allowedMimeTypes` is omitted, any file type is accepted.

### `receiveUpload(req, opts)`

The standalone file-receive pipeline. Use inside a custom `onJobRequest` when you need extra validation or logic.

```ts
import { receiveUpload } from '@resiproco/queue-service'

onJobRequest: async (req) => receiveUpload(req, { dirs: DIRS }),
```

Internally it:
1. Reads the multipart file via `req.file()`
2. Validates against `allowedMimeTypes` (if provided)
3. Generates file paths via `createFilePaths(dirs)`
4. Streams the file to `<uploadDir>/<id>.temp`
5. Atomically renames `.temp` → `<uploadDir>/<id>.uploaded`

Returns `{ ok: true, data: FilePaths }` on success, or `{ ok: false, error, status }` on failure.

```ts
type FilePaths = {
    id:         string   // job id, also the file's UUID
    tmpPath:    string   // .temp — only exists mid-write
    uploadPath: string   // .uploaded — the renamed file
    outDir:     string   // results directory for this task
    errDir:     string   // error context directory
}
```

### `removeTaskFiles(paths)`

Deletes all file artifacts for a task. Used inside `onDelete` to clean up when a job is removed (manually or via TTL sweep).

```ts
import { removeTaskFiles } from '@resiproco/queue-service'

// in jobQueueRoutesConcurrent opts:
onDelete: (job) => removeTaskFiles(job.data),
```

Calls `rm -rf` on `tmpPath`, `uploadPath`, `outDir`, and `errDir`. Uses `force: true` and `Promise.allSettled` — missing files are silently skipped, no errors thrown.

### `registerMultipart(app, opts?)`

Registers `@fastify/multipart` on the app. A thin wrapper for convenience — equivalent to `app.register(fastifyMultipart, opts)`.

```ts
import { registerMultipart } from '@resiproco/queue-service'

await registerMultipart(app, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } })
```

The multipart plugin **must** be registered before calling `jobQueueRoutesConcurrent` for `req.file()` to work inside `onJobRequest`.

---

## 9. Path & config utilities

### `createFilePaths(dirs, id?)`

Generates standardized file paths for a task. If `id` is omitted, a UUID is generated automatically.

```ts
import { createFilePaths } from '@resiproco/queue-service'

const paths = createFilePaths(DIRS)
// → { id: "abc123...", tmpPath, uploadPath, outDir, errDir }
```

### `initDataDirs(dataDir)`

Creates the directory structure for a service. Mutates and returns a `DataDirs` object with all subdirectories underneath `dataDir`.

```ts
import { initDataDirs } from '@resiproco/queue-service'

const DIRS = await initDataDirs('./data')
// → {
//   DATA:        "./data",
//   UPLOAD:      "./data/uploads",
//   RESULTS:     "./data/results",
//   ERRORS:      "./data/errors",
//   PERSISTENCE: "./data/persistence",
// }
```

Each directory is created with `mkdir -p` (recursive). Safe to call on every boot — existing directories are no-ops.

```ts
type DataDirs = {
    DATA:        string
    UPLOAD:      string   // where uploaded files land
    RESULTS:     string   // where processing output goes
    ERRORS:      string   // where error snapshots are saved
    PERSISTENCE: string   // where JobStore persists to
}
```

### `mimeConfig(map)`

Wraps a MIME-type-to-extension map into a reusable config object.

```ts
import { mimeConfig } from '@resiproco/queue-service'

const MIME = mimeConfig({
    'application/pdf': 'pdf',
    'image/jpeg':      'jpg',
    'image/png':       'png',
} as const)

MIME.map                          // the original map
MIME.allowed.has(data.mimetype)   // Set<string> for validation
MIME.extensions                   // ['pdf', 'jpg', 'png']
```

Use it with `receiveUpload` or `createFileUploadHandlers` to restrict which file types are accepted.

---

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Returns `{ ok: true }` (no auth) |
| `POST` | `/jobs` | Create a job. Pass body matching `TBody`. Returns `201 { id }`. |
| `GET` | `/jobs/:id` | Get job status. Returns `{ id, status, createdAt, startedAt, completedAt }`. |
| `GET` | `/jobs/:id/result` | Get the job result data (from `process()`). `202` if still in progress. |
| `DELETE` | `/jobs/:id` | Remove a completed or failed job. |

---

## `jobQueueRoutesConcurrent` options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `concurrency` | `number` | _(required)_ | Max simultaneous `process()` calls |
| `onJobRequest` | `(req) => JobData<TData>` | _(required)_ | Validates/transforms POST body into job data |
| `process` | `(data: TData) => Promise<JobResult<TResult>>` | _(required)_ | Runs the actual job work |
| `persistence` | `PersistenceAdapter` | `undefined` | Saves/loads jobs to survive restarts |
| `apiKey` | `string` | `undefined` | Require `x-api-key` header on all routes except `/health` |
| `onDelete` | `(job: TJob) => MaybePromise<boolean>` | `undefined` | Hook after a job is deleted |
| `jobTTL` | `number` (ms) | `72h` | Auto-delete completed/failed jobs after this time |
| `cleanupIntv` | `number` (ms) | `15min` | How often to run the cleanup sweep |

### `JobData<T>`

```ts
{ ok: true; data: T; }                              // success
|
{ ok: false; error: { message: string }; status: number } // reject
```

Return `ok: false` from `onJobRequest` to reject the POST with a custom HTTP status and error message.

### `JobResult<T>`

```ts
{ ok: true; data: T; jobId: string }                              // success
|
{ ok: false; error: { message: string; cause?: any }; jobId: string } // failure
```

---

## `PersistenceAdapter` interface

Implement this to back jobs with your own storage.

```ts
type PersistenceAdapter<TJob extends Job> = {
    save:            (job: TJob) => Promise<boolean>
    load:            () => Promise<TJob[]>
    delete:          (jobId: string) => Promise<boolean>
    cleanupOrphans:  (keepIds: Set<string>) => Promise<void>
}
```

The built-in `PersistenceViaJsonFiles` uses one JSON file per job in a directory, with atomic temp→rename writes.
