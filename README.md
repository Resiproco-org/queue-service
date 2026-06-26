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
    errorsDir: './errors',
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
    errorsDir: join(import.meta.dirname, 'errors'),
    apiKey: process.env.API_KEY,
    jobTTL: 12 * 60 * 60 * 1000,       // delete completed/failed jobs after 12h
    cleanupIntv: 5 * 60 * 1000,        // sweep every 5 minutes
    onDelete: async (job) => {
        console.log(`job ${job.id} deleted`)
        return true
    },
    onError: async (job, error) => {
        console.log(`job ${job.id} failed`, error)
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
    errorsDir: './errors',
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
    errorsDir: './errors',
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
    errorsDir: DIRS.ERRORS,
    persistence: new PersistenceViaJsonFiles(DIRS.PERSISTENCE),
    onJobRequest: upload.onJobRequest,   // receives file, streams to disk
    process: async (data) => ({ ok: true, jobId: data.id, data: {} }),
    onDelete: (job) => upload.onDelete(job.data),  // removes all task files
    onError: (job, error) => upload.onError(job.data, error),  // copies files to the error dir
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

Factory that returns the `onJobRequest` + `onDelete` + `onError` trio wired together.

```ts
import { createFileUploadHandlers } from '@resiproco/queue-service'

const upload = createFileUploadHandlers(DIRS, MIME.allowed)
// → { onJobRequest, onDelete, onError }
```

`onDelete` and `onError` accept `FilePaths` directly — pass them through in your opts:
```ts
onDelete: (job) => upload.onDelete(job.data),
onError: (job, error) => upload.onError(job.data, error),
```

`onError` copies the original uploaded file (`uploadPath`) and any processing output (`outDir`) into the job's `errDir` (which is `errorsDir/<jobId>`) so a developer can inspect exactly what caused the failure. The error directory is **never auto-deleted** — see §10 Error storage.

When `allowedMimeTypes` is omitted, any file type is accepted.

### `receiveUpload(req, opts)`

The standalone file-receive pipeline. Use inside a custom `onJobRequest` when you need extra validation or logic.

```ts
import { receiveUpload } from '@resiproco/queue-service'

onJobRequest: async (req) => receiveUpload(req, { dirs: DIRS }),
```

Internally it:
1. Reads the multipart file via `req.file()`
2. Validates against `allowedMimeTypes` (if provided) from the client-supplied `Content-Type`
3. Generates file paths via `createFilePaths(dirs)`
4. Streams the file to `<uploadDir>/<id>.temp`
5. Sniffs the file's type from its contents via `file-type` — rejects with `415` if the sniffed type doesn't match `allowedMimeTypes`. The client `Content-Type` is never trusted alone.
6. Sets `paths.mime` to the sniffed MIME and atomically renames `.temp` → `<uploadDir>/<id>.uploaded`

Returns `{ ok: true, data: FilePaths }` on success, or `{ ok: false, error, status }` on failure.

```ts
type FilePaths = {
    id:         string   // job id, also the file's UUID
    tmpPath:    string   // .temp — only exists mid-write
    uploadPath: string   // .uploaded — the renamed file
    outDir:     string   // results directory for this task
    errDir:     string   // preserved forever, never auto-deleted
    mime?:      string   // sniffed MIME type (from file contents, not the header)
}
```

### `removeJobFiles(paths)`

Deletes the file artifacts for a task. Used inside `onDelete` to clean up when a job is removed (manually or via TTL sweep).

```ts
import { removeJobFiles } from '@resiproco/queue-service'

// in jobQueueRoutesConcurrent opts:
onDelete: (job) => removeJobFiles(job.data),
```

Calls `rm -rf` on `tmpPath`, `uploadPath`, and `outDir`. Uses `force: true` and `Promise.allSettled` — missing files are silently skipped, no errors thrown.

**`errDir` is never deleted** — error snapshots are retained for manual inspection. The error directory lives forever until a developer deliberately purges it.

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
    ERRORS:      string   // where failed job snapshots are saved (never auto-deleted)
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

### `serializeError(err)`

Turn any thrown value into a plain JSON-serializable object. Used internally by the queue on failures; exported for use in custom `process()` catch blocks.

```ts
import { serializeError } from '@resiproco/queue-service'

const e = new Error('boom'); e.cause = new TypeError('inner')
serializeError(e)
// → { name: 'Error', message: 'boom', stack: '...', cause: { name: 'TypeError', message: 'inner', stack: '...' } }
```

- `Error` instances → `{ name, message, stack?, code?, cause?, ...ownProps }`
- Plain objects → own enumerable props only
- Primitives → `{ message: String(value) }`
- Circular refs → `"[Circular]"`

### `fileType(path)`

Sniffs a file's type from its contents (not the request header). Returns `{ ext, mime } | null`.

```ts
import { fileType } from '@resiproco/queue-service'

const type = await fileType('./data/uploads/abc.uploaded')
// → { ext: 'pdf', mime: 'application/pdf' }
```

### `writeJson(path, data, format?)`

Writes JSON to disk. `format: true` produces pretty-printed (4-space) output.

### `fileExists(path)`

Returns `true` if the path exists, `false` otherwise. Non-throwing.

---

## 10. Error storage

Every failed job is written to disk as `<errorsDir>/<job.id>/job.json` — a full copy of the job object (same shape as the persistence JSON), including `error` (with `name`, `message`, `stack`, `cause`), `data`, `status`, and timestamps. This applies to both failure modes:

- `process()` throws → error is serialized via `serializeError` (preserves stack + cause chain)
- `process()` returns `{ ok: false, error }` → error is stored as-returned

The `onError` hook (optional) fires after `job.json` is written. For file-upload services, wire `upload.onError` to copy the original files into the same folder:

```ts
jobQueueRoutesConcurrent(app, {
    errorsDir: DIRS.ERRORS,
    // ...
    onError: (job, error) => upload.onError(job.data, error),
})
```

Result: a developer opens `<errorsDir>/<job.id>/` and finds `job.json` plus `uploaded` (the original file) and `out/` (any processing output) — everything needed to trace what went wrong.

**Error directories are never auto-deleted.** Not on manual `DELETE /jobs/:id`, not on TTL sweep. They live forever until a developer deliberately purges them.

---

## 11. OpenAI Responses API client

A rate-limited, retry-aware client for the [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses). Handles rolling rate limits (requests + tokens), retries transient failures, and extracts JSON-schema-constrained output.

### `OpenAIResponses`

```ts
import { OpenAIResponses } from '@resiproco/queue-service'

const openai = new OpenAIResponses({ apiKey: process.env.OPENAI_API_KEY })
```

### `createPrompt(model, opts)`

Returns a function `(promptText, files?) => Promise<result>` that enqueues a request with the configured schema, system prompt, and reasoning settings.

```ts
import type { OpenAISchema } from '@resiproco/queue-service'

const schema: OpenAISchema = {
    type: 'json_schema',
    name: 'insurance_quote',
    strict: true,
    schema: {
        type: 'object',
        properties: { quotes: { type: 'array', items: { /* ... */ } } },
        required: ['quotes'],
        additionalProperties: false,
    },
}

const extract = openai.createPrompt<{ quotes: any[] }>('gpt-5.4-nano-2026-03-17', {
    systemPrompt: 'Extract insurance quotes from the document.',
    jsonSchema: schema,
    reasoning: { effort: 'none' },
    estimatedTokens: 10_000,
})

// text-only
const result = await extract('Summarize this')

// with files
const result = await extract('', [
    { type: 'base64', filename: 'quote.pdf', data: base64String },
])
```

The result is `OpenAiTryFetchResult & { data: T }` on success, or `OpenAiTryFetchResult & { data?: null }` on failure.

### `FileInput`

```ts
type FileInput =
    | { type: 'base64';   filename: string; data: string; mime?: string }  // bare base64 or data URI
    | { type: 'file_id';  id: string }                                    // OpenAI file ID
    | { type: 'file_url'; url: string }                                   // public URL
    | { type: 'image_url'; url: string }                                   // image URL
    | { type: 'image_id';  id: string }                                   // OpenAI image file ID
```

### `OpenAISchema`

The flat Responses API `text.format` shape (not the nested Chat Completions wrapper):

```ts
type OpenAISchema = {
    type: 'json_schema'
    name: string
    description?: string
    strict: true
    schema: SchemaObject
}
```

### Standalone functions

| Export | Description |
|--------|-------------|
| `openAITryFetch(route, reqInit)` | Raw fetch + error classification. Returns `OpenAiTryFetchResult` with `ok`, `status`, `retryable`, `retryAfter`, `error`, `reason`. |
| `extractOutputText(res)` | Extracts the text content block from a Response. Returns `null` for refusals/incomplete/failed. |
| `extractOutputJson(res)` | Same as above, then `JSON.parse`s the text. Returns `null` on parse failure. |
| `openAiRequestOptionsFn(model, opts)` | Builds the `ReqInit` (method, headers, body) for a prompt. Used internally by `createPrompt`. |
| `getMsTime(time)` | Parses OpenAI `x-ratelimit-reset-*` headers (`"12ms"`, `"5s"`, `"1m30s"`) into milliseconds. |

---

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Returns `{ ok: true }` (no auth) |
| `POST` | `/jobs` | Create a job. Pass body matching `TBody`. Returns `201 { id }`. |
| `GET` | `/jobs/:id` | Get job status. Returns `{ id, status, createdAt, startedAt, completedAt, error? }`. |
| `GET` | `/jobs/:id/result` | Get the job result data (from `process()`). `202` if still in progress, `422 + { error }` if failed. |
| `DELETE` | `/jobs/:id` | Remove a completed or failed job. |

---

## `jobQueueRoutesConcurrent` options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `concurrency` | `number` | _(required)_ | Max simultaneous `process()` calls |
| `errorsDir` | `string` | _(required)_ | Directory where every failed job's full JSON (`job.json`) is written. **Never auto-cleaned.** |
| `onJobRequest` | `(req) => JobData<TData>` | _(required)_ | Validates/transforms POST body into job data |
| `process` | `(data: TData) => Promise<JobResult<TResult>>` | _(required)_ | Runs the actual job work |
| `persistence` | `PersistenceAdapter` | `undefined` | Saves/loads jobs to survive restarts |
| `apiKey` | `string` | `undefined` | Require `x-api-key` header on all routes except `/health` |
| `onDelete` | `(job: TJob) => MaybePromise<boolean>` | `undefined` | Hook after a job is deleted |
| `onError` | `(job: TJob, error: JobError) => MaybePromise<void>` | `undefined` | Hook after a job fails (both `ok:false` returns and thrown errors). Fires after `job.json` is written. |
| `jobTTL` | `number` (ms) | `72h` | Auto-delete completed/failed jobs after this time |
| `cleanupIntv` | `number` (ms) | `15min` | How often to run the cleanup sweep |

### `JobData<T>`

```ts
{ ok: true; data: T; }                              // success
|
{ ok: false; error: { message: string }; status: number } // reject
```

Return `ok: false` from `onJobRequest` to reject the POST with a custom HTTP status and error message.

### `JobError`

```ts
type JobError = {
    message: string
    name?: string
    stack?: string
    code?: any
    cause?: any
    [k: string]: any
}
```

When `process()` throws, the error is serialized via `serializeError` — `name`, `message`, `stack`, and `cause` chain are preserved as JSON-safe values. Circular references become `"[Circular]"`.

### `JobResult<T>`

```ts
{ ok: true; data: T; jobId: string }                // success
|
{ ok: false; error: JobError; jobId: string }       // failure
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
