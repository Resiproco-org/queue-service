import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileTypeFromFile, type FileTypeResult } from "file-type";

export const ensureDir = (path: string) => mkdir(path, { recursive: true });

export const readJsonFile = async (filePath: string) =>
    JSON.parse(await readFile(filePath, 'utf-8'))

export const writeJson = (path: string, data: any, format = false) =>
    writeFile(path, JSON.stringify(data, null, format ? 4 : undefined));

export async function fileExists(path: string) {
    try {
        await access(path, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

/** Sniff a file's type from its contents (not the request header). Returns null on failure. */
export async function fileType(path: string): Promise<FileTypeResult | null> {
    try {
        return (await fileTypeFromFile(path)) ?? null;
    } catch {
        return null;
    }
}

/**
 * Turn any thrown value into a plain JSON-serializable object.
 *
 * - `Error` instances → `{ name, message, stack?, code?, cause?, ...own props }`
 * - plain objects      → own enumerable props only (no synthesized name/message)
 * - primitives         → `{ message: String(value) }`
 * - circular refs      → `"[Circular]"`
 * - `.cause` chain     → recursed (bounded by the WeakSet seen-guard)
 */
export function serializeError(err: any): any {
    if (err == null) return null;
    if (typeof err !== 'object') return { message: String(err) };

    const seen = new WeakSet<object>();
    const go = (e: any): any => {
        if (e == null) return null;
        if (typeof e !== 'object') return { message: String(e) };
        if (seen.has(e)) return '[Circular]';
        seen.add(e);

        const isError = e instanceof Error;
        const er: any = e;
        const out: {
            name?: string; message?: string; stack?: string;
            code?: any; cause?: any; [k: string]: any;
        } = {};
        if (isError) {
            out.name = er.name ?? er?.constructor?.name ?? 'Error';
            out.message = er.message ?? String(er);
            if (typeof er['stack'] === 'string') out.stack = er['stack'];
            if (er['code'] != null) out.code = er['code'];
        }

        const skip = new Set(['name', 'message', 'stack', 'cause', 'code']);
        for (const k of Object.keys(er)) {
            if (skip.has(k)) continue;
            const v = er[k];
            out[k] = (v != null && typeof v === 'object') ? go(v) : v;
        }
        if (er['cause'] != null) {
            const c = er['cause'];
            out['cause'] = (c != null && typeof c === 'object') ? go(c) : c;
        }
        return out;
    };
    return go(err);
}