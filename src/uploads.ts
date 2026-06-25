import type { FastifyMultipartOptions } from '@fastify/multipart'
import type { FastifyInstance } from 'fastify'
import type { FastifyRequest } from 'fastify'

import fastifyMultipart from '@fastify/multipart'
import { createFilePaths, type FilePaths, type DataDirs } from './utils/file-paths.js'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'

export const registerMultipart = (
    app: FastifyInstance,
    opts: FastifyMultipartOptions = {}
) => app.register(fastifyMultipart, opts);

export function createFileUploadHandlers(
    dirs: DataDirs,
    allowedMimeTypes?: Set<string>,
) {
    return {
        onJobRequest: (req: FastifyRequest) =>
            receiveUpload(req, { dirs, allowedMimeTypes }),

        onDelete: async (paths: FilePaths) => removeTaskFiles(paths),
    };
}

export async function receiveUpload(
    req: FastifyRequest,
    opts: {
        dirs: DataDirs,
        allowedMimeTypes?: Set<string> | undefined,  // omit to allow any type
    },
): Promise<
    | { ok: true;  data: FilePaths }
    | { ok: false; error: { message: string }; status: number }
> {
    try {
        const data = await req.file();
        if (!data)
            return { ok: false, error: { message: 'no file provided' }, status: 400 };

        if (opts.allowedMimeTypes && !opts.allowedMimeTypes.has(data.mimetype))
            return { ok: false, error: { message: 'unsupported file type' }, status: 415 };

        const paths = createFilePaths(opts.dirs);

        await pipeline(data.file, createWriteStream(paths.tmpPath));
        await rename(paths.tmpPath, paths.uploadPath);

        return { ok: true, data: paths };
    } catch (err) {
        console.error(err);
        return { ok: false, status: 500, error: { message: 'Internal server error' } };
    }
}

export async function removeTaskFiles(paths: FilePaths): Promise<boolean> {
    await Promise.allSettled(
        [paths.tmpPath, paths.uploadPath, paths.outDir, paths.errDir]
            .map(f => rm(f, { recursive: true, force: true }))
    );
    return true;
}