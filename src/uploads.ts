import type { FastifyMultipartOptions } from '@fastify/multipart'
import type { FastifyInstance } from 'fastify'
import type { FastifyRequest } from 'fastify'

import fastifyMultipart from '@fastify/multipart'
import { createFilePaths, type FilePaths, type DataDirs } from './utils/file-paths.js'
import { fileExists, fileType } from './utils/general.utils.js'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { cp, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

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

        onDelete: async (paths: FilePaths) => removeJobFiles(paths),

        onError: async (paths: FilePaths) => copyFilesToErrDir(paths),
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
    const paths = createFilePaths(opts.dirs);
    try {
        const data = await req.file();
        if (!data)
            return { ok: false, error: { message: 'no file provided' }, status: 400 };

        if (opts.allowedMimeTypes && !opts.allowedMimeTypes.has(data.mimetype))
            return { ok: false, error: { message: 'unsupported file type' }, status: 415 };

        await pipeline(data.file, createWriteStream(paths.tmpPath));

        const sniffed = await fileType(paths.tmpPath);
        if (sniffed) paths.mime = sniffed.mime;

        if (opts.allowedMimeTypes && (!sniffed || !opts.allowedMimeTypes.has(sniffed.mime)))
            return { ok: false, error: { message: 'unsupported file type' }, status: 415 };

        await rename(paths.tmpPath, paths.uploadPath);

        return { ok: true, data: paths };
    } catch (err) {
        console.error(err);
        return { ok: false, status: 500, error: { message: 'Internal server error' } };
    } finally {
        rm(paths.tmpPath, { force: true })
    }
}

export async function removeJobFiles(paths: FilePaths): Promise<boolean> {
    await Promise.allSettled(
        [paths.tmpPath, paths.uploadPath, paths.outDir]
            .map(f => rm(f, { recursive: true, force: true }))
    );
    return true;
}

/** Copy the original upload + processing output into the job's errDir for debugging. */
export async function copyFilesToErrDir(paths: FilePaths): Promise<void> {
    const copyIfExists = async (from: string, to: string, recursive = false) => {
        if (await fileExists(from)) await cp(from, to, { recursive });
    };

    await Promise.allSettled([
        copyIfExists(paths.uploadPath, join(paths.errDir, 'uploaded')),
        copyIfExists(paths.outDir, join(paths.errDir, 'out'), true),
    ]);
}