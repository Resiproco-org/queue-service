import Fastify from "fastify";
import { PersistenceViaJsonFiles, jobQueueRoutesConcurrent } from "../../src/";
import { numRandInt, wait } from "@giveback007/util-lib";
import { join } from "node:path";

const log = console.log;

setTimeout(async () => {
    const { API_KEY } = process.env as { API_KEY: string };
    if (!API_KEY) throw new Error("NO 'API_KEY' SET!");

    const app = Fastify()

    jobQueueRoutesConcurrent<
        { id: string },
        { id: string, start: number },
        { id: string, start: number, end: number }
    >(app, {
        concurrency: 150,
        onJobRequest: (req) => ({ ok: true, data: { id: req.body.id, start: Date.now() } }),
        persistence: new PersistenceViaJsonFiles(join(import.meta.dirname, '/tmp')),
        process: async (data) => {
            await wait(numRandInt(1, 12) * 1000);
            
            return { ok: true, jobId: data.id, data: { ...data, end: Date.now() } }
        },
        apiKey: API_KEY,
    })

    const listeningOn = await app.listen({ port: 3000, host: "0.0.0.0" });
    log(`Listening on: ${listeningOn}`)
})