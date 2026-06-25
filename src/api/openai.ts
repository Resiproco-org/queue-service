import { msTime, wait } from "@giveback007/util-lib";

const MAX_RETRIES = 5;

type SchemaProperty =
    | { type: "string"; enum?: string[] }
    | { type: "boolean" }
    | { type: "number" }
    | { type: "integer" }
    | { type: "array"; items: SchemaProperty }
    | OpenAiSchemaObject;

export type OpenAiSchemaObject = {
    type: "object";
    properties: Record<string, SchemaProperty>;
    required: string[];
    additionalProperties: false;
}

export type PromptReqOpts = {
    openAiApiKey: string;
    systemPrompt: string;
    jsonSchema: {
        name: string;
        schema: OpenAiSchemaObject;
    }
    verbosity?: "low" | "medium" | "high",
    reasoning?: {
        effort: "minimal" | "low" | "medium" | "high",
        summary: null | "auto" | "detailed" | "concise",
    },
}

type ReqInit = {
    method: string;
    headers: {
        "Content-Type": string;
        Authorization: string;
    };
    body: string;
}

export function openAiRequestOptionsFn(
    llmModel: string,
    opts: PromptReqOpts,
) {
    const {
        verbosity = 'low',
        reasoning = { effort: "minimal", summary: null },
    } = opts;

    const body = {
        model: llmModel,
        reasoning,
        store: false,
        tools: [],
        include: [],
        text: {
            format: {
                type: "json_schema",
                strict: true,
                ...opts.jsonSchema
            },
            verbosity,
        },
    }

    const getInputs = (text: string) => {
        const input = [{
            role: "user",
            content: [{ type: "input_text", text }]
        }];

        if (opts.systemPrompt) input.unshift({
            role: "developer",
            content: [{ type: "input_text", text: opts.systemPrompt }]
        })

        return input
    }

    return (inputText: string): ReqInit => ({
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + opts.openAiApiKey
        },
        body: JSON.stringify({ ...body, input: getInputs(inputText) })
    })
}

function getMsTime(time: string) {
    if (/^\d+m[\d.]+s$/.test(time) || time.endsWith('m')) {
        const [_min, _sec] = time.split("m") as [string, string | undefined];
        const min = Number(_min), sec = Number(_sec?.replace("s", "")) || 0;
        return msTime.m * min + msTime.s * sec;
    } if (time.endsWith("ms")) {
        return Number(time.split("ms")[0]!);
    } else if (time.endsWith("s")) {
        return Number(time.split("s")[0]!) * 1000;
    } else {
        throw new Error("Unhandled timing")
    }
}

export class OpenAiRateLimiter {
    private limitDate = Date.now();
    private limitRequests = 500;
    private limitTokens = 200_000;

    private remainingRequests = 1;
    private remainingTokens = 50_000;
    
    private requestsInProcess = 0;
    private tokensInProcess = 0;

    private estimatedTokensPerRequest: number;

    constructor(estimatedTokensPerRequest: number) {
        this.estimatedTokensPerRequest = estimatedTokensPerRequest
    }

    log(queueLength: number) {
        console.log(`(OPEN-AI) In-Queue: ${queueLength} | ${this.remainingRequests}/${this.limitRequests} req, ${(this.remainingTokens).toLocaleString()} / ${this.limitTokens.toLocaleString()} tokens`);
    }

    semaphoreCanGo() {
        const remReq = this.remainingRequests - (this.requestsInProcess + 1);
        const remTkn = this.remainingTokens - (this.tokensInProcess + this.estimatedTokensPerRequest);
        return remReq >= 0 && remTkn >= 0;
    }

    acquire() {
        this.requestsInProcess++;
        this.tokensInProcess += this.estimatedTokensPerRequest;
    }

    release() {
        this.requestsInProcess--;
        this.tokensInProcess -= this.estimatedTokensPerRequest;
    }

    private requestReset: NodeJS.Timeout = setTimeout(() => null)
    private tokenReset: NodeJS.Timeout = setTimeout(() => null)
    private limit429: NodeJS.Timeout = setTimeout(() => null)
    updateRateLimit(res: Response) {
        try {
            if (res.status === 429) {
                console.log('(OPEN-AI) RATE LIMIT REACHED');
                this.remainingRequests = 0;
                this.remainingTokens = 0;

                console.log(res)

                clearTimeout(this.limit429);
                this.limit429 = setTimeout(() => {
                    this.remainingRequests = 1;
                    this.remainingTokens = this.estimatedTokensPerRequest + 1
                }, 15)
            } else if (res.status === 200) {
                const h = res.headers;
                const date = new Date(h.get('date')!);
                if (this.limitDate > date.getTime()) return;
                const isSameTime = this.limitDate === date.getTime();
                this.limitDate = date.getTime();
                
                // Date has precision by second
                // To be cautious take the lowest number if time is the same
                const _limitRequests = Number(h.get('x-ratelimit-limit-requests'));
                this.limitRequests = isSameTime ? Math.min(_limitRequests, this.limitRequests) : _limitRequests;
            
                const _limitTokens = Number(h.get('x-ratelimit-limit-tokens'));
                this.limitTokens = isSameTime ? Math.min(_limitTokens, this.limitTokens) : _limitTokens;
            
                const _remainingRequests = Number(h.get('x-ratelimit-remaining-requests'));
                this.remainingRequests = isSameTime ? Math.min(_remainingRequests, this.remainingRequests) : _remainingRequests;
            
                const _remainingTokens = Number(h.get('x-ratelimit-remaining-tokens'));
                this.remainingTokens = isSameTime ? Math.min(_remainingTokens, this.remainingTokens) : _remainingTokens;
            
                const resetRequests = h.get('x-ratelimit-reset-requests')!;
                const resetRequestsMs = getMsTime(resetRequests);
                clearTimeout(this.requestReset)
                this.requestReset = setTimeout(() => {
                    this.remainingRequests = this.limitRequests;
                }, resetRequestsMs)
            
                const resetTokens = h.get('x-ratelimit-reset-tokens')!;
                const resetTokensMs = getMsTime(resetTokens);
                clearTimeout(this.tokenReset)
                this.tokenReset = setTimeout(() => {
                    this.remainingTokens = this.limitTokens;
                }, resetTokensMs)
            } 
        } catch(err) {
            console.log(res)
            console.error(err)
            res.text().then(txt => console.log(txt))
        }
    }
}

export class OpenAiPromptQueue {
    private genPromptRequest: ReturnType<typeof openAiRequestOptionsFn>;
    private limiter: OpenAiRateLimiter;
    private isProcessingQueue = false;
    private queue: { reqInit: ReqInit, tries: number; resolve: (value: any) => void }[] = [];
    private responsesRoute: string;

    constructor(
        llmModel: string,
        opts: PromptReqOpts & {
            estimatedTokensPerRequest: number;
            openAiResponsesRoute?: string;
        },
    ) {
        this.limiter = new OpenAiRateLimiter(opts.estimatedTokensPerRequest);
        this.genPromptRequest = openAiRequestOptionsFn(llmModel, opts);
        this.responsesRoute = opts.openAiResponsesRoute || "https://api.openai.com/v1/responses";
    }

    private async processQueue() {
        if (this.isProcessingQueue || this.queue.length === 0) return;
        this.isProcessingQueue = true;

        while (this.queue.length) {
            const { reqInit, resolve, tries } = this.queue.shift()!;

            await wait(0);
            while(!this.limiter.semaphoreCanGo()) await wait(200);

            this.limiter.acquire();

            let response: Response | { ok: false }
            try {
                response = await fetch(this.responsesRoute, reqInit);
                this.limiter.updateRateLimit(response);
            } catch(err) {
                console.log(err)
                response = { ok: false }
            }
            
            this.limiter.release();

            let data: any;
            if (response.ok) try {
                data = await response.json()
            } catch {}

            if (response.ok && data) {
                resolve({ ok: true, data });
            } else if (tries < MAX_RETRIES) {
                await wait(2_500 * tries);
                this.queue.push({ reqInit, resolve, tries: tries + 1 });
            } else {
                resolve({ ok: false, error: { message: `Failed to fetch data ${tries} times` } });
            }

            this.limiter.log(this.queue.length)
        }

        this.isProcessingQueue = false;
    }

    enqueuePrompt<T>(promptText: string) {
        const reqInit = this.genPromptRequest(promptText);
        return new Promise<T>(resolve => {
            this.queue.push({ reqInit, resolve, tries: 1 })
            this.processQueue();
        })
    }
}