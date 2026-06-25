import { mkdir, readFile } from "node:fs/promises";

export const ensureDir = (path: string) => mkdir(path, { recursive: true });

export const readJsonFile = async (filePath: string) => 
    JSON.parse(await readFile(filePath, 'utf-8'))