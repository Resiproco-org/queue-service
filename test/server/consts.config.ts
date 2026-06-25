import { initDataDirs } from "../../src/utils/file-paths.js";
import { mimeConfig } from "../../src/utils/mime.utils.js";

export const MAX_UPLOAD_FILE_SIZE = 15 * 1024 * 1024; // 15mb

export const MIME = mimeConfig({ 'application/pdf': 'pdf' } as const);

export const DIRS = await initDataDirs(import.meta.dirname + '/tmp');