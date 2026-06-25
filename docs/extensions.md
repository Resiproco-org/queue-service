# Optional extensions (design ideas)

Patterns extracted from the preselar engine that may generalize to future
file-processing or debugging-heavy services.

---

## 1. `serveFile` — output-file download

**Engine ref:** `services/engine/src/routes/routes.ts:134-159`

`GET /tasks/:id/files/:file` — resolves file path, prevents path traversal
(`!filePath.startsWith(task.outDir)`), stats, streams with octet-stream
content-type.

### Option A — route factory

```ts
import { downloadFileRoute } from '@resiproco/queue-service/file'

downloadFileRoute(app, { resultsDir: './data/results' })
// Registers GET /tasks/:id/files/:file
```

**Recommendation:** Path-traversal guard is security-critical and easy to get
wrong by hand.  A route factory eliminates the risk once and for all.

### Option B — standalone function

```ts
import { serveFile } from '@resiproco/queue-service/file'

const file = serveFile(baseDir, taskId, fileName)
// → { stream: ReadStream, mimeType } or { error, status }
```

+ User decides route path, response shape
− User must remember path-traversal check every time

---

## 2. `loadErrorContext` — error-diagnostics endpoint

**Engine ref:** `services/engine/src/routes/routes.ts:93-109`

`GET /tasks/:id/error` — reads `<errDir>/<id>/error-context.json` from disk,
returns parsed JSON or 404.

### Option A — utility function

```ts
import { loadErrorContext } from '@resiproco/queue-service/file'

const ctx = await loadErrorContext('./data/errors', taskId)
// → { ... } or null
```

+ Trivial — 15 lines, doesn't justify a route factory
+ User wires it into whatever route shape they want

---

## 3. `cleanupDirs` — auto-cleanup of task file directories

Integrate file-dir cleanup into the existing `cleanUp()` interval so when a
completed/errored job ages out, its associated files are also removed.  Add an
optional `cleanupDirs` opt:

```ts
jobQueueRoutesConcurrent(app, {
    jobTTL: 7200000,
    cleanupDirs: ['./uploads', './results', './errors'],
})
```

---

## 4. `startFileCleanup` — multi-directory orphan sweep

**Engine ref:** `services/engine/src/utils/cleanup.utils.ts`

Two-phase cleanup:
1. Happy path — iterate in-memory tasks, delete old ones *(already in lib)*
2. Straggler sweep — `readdir()` upload & results dirs, `rm -rf` anything
   whose mtime exceeds `maxAge` and has no matching in-memory task

### Option A — standalone loop

```ts
import { startFileCleanup } from '@resiproco/queue-service/file'

startFileCleanup(taskStore, {
    dirs:     ['./uploads', './results', './errors'],
    maxAge:   2 * 60 * 60 * 1000,   // 2 h
    interval: 5 * 60 * 1000,         // 5 min
})
```

### Option B — extend existing lib cleanup

Add optional `cleanupDirs` to `jobQueueRoutesConcurrent` opts so the
already-running interval also sweeps orphan files.

---

## 5. `fileType` — file MIME detection with fallback

**Engine ref:** `services/engine/src/engine/engine.utils.ts:57-70`

Reads a file, detects MIME type via `file-type`, falls back to a caller-provided
MIME if detection fails (e.g., on Linux without `shared-mime-info`), validates
against an allowlist, and categorizes into `pdf | docx | img`.

```ts
import { fileType } from '@resiproco/queue-service'
import { ALLOWED_FILES } from './consts.config'

const info = await fileType(paths.uploadPath, allowedMimes, fallbackMime)
// → { type: { ext: 'pdf', mime: 'application/pdf' }, ext: 'pdf', ctg: 'pdf' }
// or null if type is unsupported
```

Useful alongside `receiveUpload` — `req.file()` reports the client-claimed MIME
(which can be wrong or empty).  `fileType` checks the actual file bytes.

---

## 6. `saveErrorSnapshot` — error forensic archiver

**Engine ref:** `services/engine/src/utils/errors.utils.ts:6-35`

When a job fails, copies all relevant task files (output dir, uploaded file,
temp file) into the job's `errDir` along with a full context JSON dump.  Pairs
with `errDir` in `FilePaths`.

```ts
import { saveErrorSnapshot } from '@resiproco/queue-service'

// inside process() on failure:
await saveErrorSnapshot({
    sources: [
        [paths.outDir,      'out'       ],
        [paths.uploadPath,  'uploaded'   ],
        [paths.tmpPath,     'temp'      ],
    ],
    context: { jobId, error, stage: 'ocr' },
})
```

+ Complete forensic snapshot for debugging failed processing
+ User can then serve it via `serveFile` / `loadErrorContext` later

---

## Priority

| # | Name | Priority | Reason |
|---|---|---|---|
| 1  | `serveFile` / `downloadFileRoute` | Medium | Security win (path traversal) |
| 2  | `loadErrorContext` | Low | Trivial; user can write it |
| 3  | `cleanupDirs` | Medium | Completes the file-cleanup story |
| 4  | `startFileCleanup` | Low | Existing TTL sweep covers 90 % |
| 5  | `fileType` | Medium | Addresses MIME detection blind spots in `receiveUpload` |
| 6  | `saveErrorSnapshot` | Medium | Completes the error/debugging story; pairs with `loadErrorContext` |
