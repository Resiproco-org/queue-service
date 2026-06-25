import { join } from "node:path";
import { ensureDir } from "./general.utils.js";
import { randomUUID } from "node:crypto";

export type FilePaths = {
    /** file id (can be used as jobId) */
    id: string;
    /** .temp file path (only exists when file is being written into) */
    tmpPath: string;
    /** .upload file path, when .temp is done being written it's renamed to .upload */
    uploadPath: string;
    /** directory where all the files will be stored after processing */
    outDir: string;
    /** directory where errors with all file context can be stored long term */
    errDir: string;
}

export type DataDirs = {
    DATA: string;
    UPLOAD: string;
    RESULTS: string;
    ERRORS: string;
    PERSISTENCE: string;
}

export function createFilePaths(dirs: DataDirs, id: string = randomUUID()): FilePaths {
    const tmpPath = join(dirs.UPLOAD, `${id}.temp`);
    const uploadPath = join(dirs.UPLOAD, `${id}.uploaded`);
    const outDir = join(dirs.RESULTS, id);
    const errDir = join(dirs.ERRORS, id);

    return { tmpPath, uploadPath, outDir, errDir, id }
}

export async function initDataDirs(
    dataDir: string,
    dirs: DataDirs = {
        DATA: "",
        UPLOAD: "",
        RESULTS: "",
        ERRORS: "",
        PERSISTENCE: "",
    }
) {
    dirs.DATA = dataDir;
    dirs.RESULTS = join(dirs.DATA, 'results');
    dirs.UPLOAD = join(dirs.DATA, 'uploads');
    dirs.ERRORS = join(dirs.DATA, 'errors');
    dirs.PERSISTENCE = join(dirs.DATA, 'persistence');

    await Promise.all(Object.values(dirs).map(dir => ensureDir(dir)))
    return dirs;
}