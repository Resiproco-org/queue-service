import { readFile } from "node:fs/promises";

export const readJsonFile = async (filePath: string) => 
    JSON.parse(await readFile(filePath, 'utf-8'))