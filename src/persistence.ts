import { writeFile, rename, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readJsonFile } from './general.utils.js';

export class PersistenceJsonFile<TJob extends Job> implements PersistenceAdapter<TJob> {
    private dir: string;

    constructor(dir: string) {
        this.dir = dir;
    }

    async save(job: TJob): Promise<boolean> {
        const tmp = join(this.dir, `${job.id}.tmp`)
        await writeFile(tmp, JSON.stringify(job));

        // rename file .tmp to .json (for corrupt/half-written files)
        await rename(tmp, join(this.dir, `${job.id}.json`))
        return true;
    }

    async load(): Promise<TJob[]> {
        const files = await readdir(this.dir);

        const jobs: TJob[] = []
        for (const f of files) {
            if (!f.endsWith('.json')) continue;
            try {
                jobs.push(await readJsonFile(join(this.dir, f)))
            } catch(err) {
                console.error(err);
            }
        }

        return jobs
    }

    async delete(jobId: string): Promise<boolean> {
        let didCleanUp = false;
        try {
            await unlink(join(this.dir, `${jobId}.tmp`))
            didCleanUp = true;
        } catch {}

        try {
            await unlink(join(this.dir, `${jobId}.json`))
            didCleanUp = true;
        } catch {}

        return didCleanUp
    }
}