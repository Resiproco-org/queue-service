import Fastify from "fastify";

import type { FilePaths } from "../../src/utils/file-paths.js";
import type { OpenAISchema } from "../../src/api/openai.utils.js";
import { OpenAIResponses, PersistenceViaJsonFiles, jobQueueRoutesConcurrent } from "../../src/index.js";
import { createFileUploadHandlers, registerMultipart } from "../../src/uploads.js";

import carInsuranceJsonSchema from './tmp/schema.json' with { type: 'json' };
import { DIRS, MAX_UPLOAD_FILE_SIZE, MIME } from "./consts.config.js";
import { readFile } from "node:fs/promises";
import { SYSTEM_PROMPT } from "./tmp/system_prompt.js";

const log = console.log;

setTimeout(async () => {
    const { API_KEY, OPEN_AI_API } = process.env as { API_KEY: string; OPEN_AI_API: string };
    if (!API_KEY || !OPEN_AI_API) throw new Error("NO 'API_KEY' SET!");

    const openAI = new OpenAIResponses({ apiKey: OPEN_AI_API });
    const extractFromPdf = openAI.createPrompt("gpt-5.4-nano-2026-03-17", {
        estimatedTokens: 10_000,
        systemPrompt: SYSTEM_PROMPT,
        jsonSchema: carInsuranceJsonSchema as OpenAISchema,
        reasoning: { effort: "none" }
    })

    const app = Fastify();
    await registerMultipart(app, {
        limits: { fileSize: MAX_UPLOAD_FILE_SIZE, files: 1 }
    })

    const uploadHandler = createFileUploadHandlers(DIRS, MIME.allowed);

    jobQueueRoutesConcurrent<
        {},
        FilePaths,
        Record<string, any>
    >(app, {
        concurrency: 150,
        errorsDir: DIRS.ERRORS,
        persistence: new PersistenceViaJsonFiles(DIRS.PERSISTENCE),
        onJobRequest: uploadHandler.onJobRequest,
        onDelete: (job) => uploadHandler.onDelete(job.data),
        onError: (job) => uploadHandler.onError(job.data),
        process: async (data) => {
            try {
                const buf = await readFile(data.uploadPath);
                const base64 = buf.toString('base64');

                const result = await extractFromPdf("", [{ type: "base64", filename: "quote.pdf", data: base64 }])

                if (result.ok && result.data)
                    return { ok: true, data: result.data, jobId: data.id }
                else
                    return { ok: false, error: { message: result.error?.message || "Unknown Error", cause: result.error }, jobId: data.id }
            } catch (err) {
                return { ok: false, jobId: data.id, error: { message: 'processing error', cause: err } };
            }
        },
        apiKey: API_KEY,
    })

    const listeningOn = await app.listen({ port: 3000, host: "0.0.0.0" });
    log(`Listening on: ${listeningOn}`)
})