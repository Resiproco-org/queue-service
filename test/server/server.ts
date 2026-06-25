import Fastify from "fastify";

import type { FilePaths } from "../../src/utils/file-paths.js";
import { PersistenceViaJsonFiles, jobQueueRoutesConcurrent } from "../../src/index.js";
import { createFileUploadHandlers, registerMultipart } from "../../src/uploads.js";

import { DIRS, MAX_UPLOAD_FILE_SIZE, MIME } from "./consts.config.js";


const log = console.log;

setTimeout(async () => {
    const { API_KEY } = process.env as { API_KEY: string };
    if (!API_KEY) throw new Error("NO 'API_KEY' SET!");

    const app = Fastify();
    await registerMultipart(app, {
        limits: { fileSize: MAX_UPLOAD_FILE_SIZE, files: 1 }
    })

    const uploadHandler = createFileUploadHandlers(DIRS, MIME.allowed);

    jobQueueRoutesConcurrent<
        {},
        FilePaths,
        { id: string, start: number, end: number }
    >(app, {
        concurrency: 150,
        persistence: new PersistenceViaJsonFiles(DIRS.PERSISTENCE),
        onJobRequest: uploadHandler.onJobRequest,
        onDelete: (job) => uploadHandler.onDelete(job.data),
        process: async (data) => {
            try {
                // For now: maybe use pdfjs or just read the file and say "not implemented"
                return { ok: false, jobId: data.id, error: { message: 'PDF processing not implemented yet' } };
            } catch (err) {
                return { ok: false, jobId: data.id, error: { message: 'processing error', cause: err } };
            }
        },
        apiKey: API_KEY,
    })

    const listeningOn = await app.listen({ port: 3000, host: "0.0.0.0" });
    log(`Listening on: ${listeningOn}`)
})