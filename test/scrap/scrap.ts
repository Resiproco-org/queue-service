import { wait } from "@giveback007/util-lib";

const log = console.log;

setTimeout(async () => {
    await wait(250)
    const res1 = await fetch('http://localhost:3000/health')
    const data = await res1.json()

    log(data)

    const API_KEY = process.env.API_KEY!


    const res2 = await fetch(`http://localhost:3000/jobs`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'test-1' })
    })
    const { id } = await res2.json()

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
