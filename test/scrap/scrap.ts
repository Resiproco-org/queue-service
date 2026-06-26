import { wait } from "@giveback007/util-lib";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const log = console.log;

setTimeout(async () => {
    rm("test.ts", { force: true })
    const { API_KEY } = process.env as { API_KEY: string };

    await wait(150)
    const healthRes = await fetch('http://localhost:3000/health')
    const data = await healthRes.json()
    log("HEALTHY:", data)

    const pdfDir = join(import.meta.dirname, '../../temp/pdfs');
    const files = (await readdir(pdfDir)).filter(f => f.toLowerCase().endsWith('.pdf'));
    log(`Found ${files.length} PDFs:`, files);

    const post = async (file: string) => {
        const buf = await readFile(join(pdfDir, file));
        const f = new File([buf], file, { type: 'application/pdf' });
        const formData = new FormData();
        formData.append('file', f, file);
        const res = await fetch('http://localhost:3000/jobs', {
            method: 'POST',
            headers: { 'x-api-key': API_KEY },
            body: formData,
        });
        const body = await res.json() as { id?: string; error?: any };
        log(`POST ${file} →`, res.status, body);
        return { file, id: body.id };
    };

    const results = await Promise.all(files.map(post));
    const jobs = results.filter(r => r.id) as { file: string; id: string }[];

    // poll until all done
    while (true) {
        const statuses = await Promise.all(jobs.map(async ({ file, id }) => {
            const r = await fetch(`http://localhost:3000/jobs/${id}`, { headers: { 'x-api-key': API_KEY } });
            const job = await r.json();
            return { file, id, job };
        }));
        for (const { file, job } of statuses) {
            if (job.status === 'completed' || job.status === 'failed')
                log(`[${job.status}] ${file}`, job.error ?? '');
        }
        if (statuses.every(s => s.job.status === 'completed' || s.job.status === 'failed')) break;
        await wait(2000);
    }

    // fetch results for completed jobs
    for (const { file, id } of jobs) {
        const status = await fetch(`http://localhost:3000/jobs/${id}`, { headers: { 'x-api-key': API_KEY } }).then(r => r.json());
        if (status.status !== 'completed') continue;
        const res = await fetch(`http://localhost:3000/jobs/${id}/result`, { headers: { 'x-api-key': API_KEY } });
        if (res.status === 200) {
            const result = await res.json();
            log(`RESULT ${file}:`, result.quotes?.length ?? 0, 'quotes');
        }
    }
})
