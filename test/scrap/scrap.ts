import { wait } from "@giveback007/util-lib";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const log = console.log;

setTimeout(async () => {
    const { API_KEY } = process.env as { API_KEY: string };

    await wait(150)
    const healthRes = await fetch('http://localhost:3000/health')
    const data = await healthRes.json()
    log("HEALTHY:", data)

    const pdfPath = join(import.meta.dirname, '../../temp/pdfs/Cotización Auto - ASSA.pdf');
    const buf = await readFile(pdfPath);
    const file = new File([buf], 'Cotización Auto - ASSA.pdf', { type: 'application/pdf' });

    const formData = new FormData();
    formData.append('file', file, 'Cotizacion Auto INS.PDF');

    const res = await fetch('http://localhost:3000/jobs', {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
        body: formData,  // no content-type header — fetch sets boundary automatically
    });

    const { id } = await res.json()
    console.log("ID:", id)

    // poll until done
    while (true) {
        const status = await fetch(`http://localhost:3000/jobs/${id}`, { headers: { 'x-api-key': API_KEY } })
        const job = await status.json()
        log(job)
        if (job.status === 'completed' || job.status === 'failed') break
        await wait(1500)
    }

    await wait(2500);
    await fetch(`http://localhost:3000/jobs/${id}`, {
        method: "DELETE",
        headers: { 'x-api-key': API_KEY }
    })

})
