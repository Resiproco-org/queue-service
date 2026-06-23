import { writeFile, rename, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readJsonFile } from './general.utils.js';

const TYPE_TEMP = '.persist.temp';
const TYPE_JSON = '.persist.json';

export class PersistenceViaJsonFiles<TJob extends Job> implements PersistenceAdapter<TJob> {
    private dir: string;

    constructor(dir: string) {
        this.dir = dir;
    }

    private temp = (id: string) => join(this.dir, `${id}${TYPE_TEMP}`);
    private json = (id: string) => join(this.dir, `${id}${TYPE_JSON}`);

    async save(job: TJob): Promise<boolean> {
        const tmp = this.temp(job.id)
        await writeFile(tmp, JSON.stringify(job));

        // rename file .temp to .json (for corrupt/half-written files)
        await rename(tmp, this.json(job.id))
        return true;
    }

    async load(): Promise<TJob[]> {
        const files = await readdir(this.dir);

        const jobs: TJob[] = []
        for (const f of files) {
            if (!f.endsWith(TYPE_JSON)) continue;
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
            await unlink(this.temp(jobId))
            didCleanUp = true;
        } catch {}

        try {
            await unlink(this.json(jobId))
            didCleanUp = true;
        } catch {}

        return didCleanUp
    }

    async cleanupOrphans(keepIds: Set<string>): Promise<void> {
        const files = (await readdir(this.dir)).filter(x => x.endsWith(TYPE_JSON) || x.endsWith(TYPE_TEMP))
        for (const f of files) {
            const id = f.replace(TYPE_TEMP, "").replace(TYPE_JSON, "");
            if (!keepIds.has(id)) try { await unlink(join(this.dir, f)) } catch {}
        }
    }
}