import type { OpenAiTryFetchResult } from "../@types/openai.js";

import { msTime, wait } from "@giveback007/util-lib";
import { extractOutputJson, getMsTime, openAiRequestOptionsFn, openAITryFetch, type PromptReqOpts, type ReqInit } from "./openai.utils.js";

const MAX_RETRIES = 5;

export class OpenAiRateLimiter {
    private limitDate = 0;
    private limitRequests = 500;
    private limitTokens = 200_000;

    private remainingRequests = 1;
    private remainingTokens = 50_000;
    
    private requestsInProcess = 0;
    private tokensInProcess = 0;

    log(queueLength: number) {
        console.log(`(OPEN-AI) In-Queue: ${queueLength} | ${this.remainingRequests}/${this.limitRequests} req, ${(this.remainingTokens).toLocaleString()} / ${this.limitTokens.toLocaleString()} tokens`);
    }

    semaphore = (estimatedTokens: number) => ({
        canGo: () => {
            const remReq = this.remainingRequests - (this.requestsInProcess + 1);
            const remTkn = this.remainingTokens - (this.tokensInProcess + estimatedTokens);
            return remReq >= 0 && remTkn >= 0;    
        },
        acquire: () => {
            this.requestsInProcess++;
            this.tokensInProcess += estimatedTokens;
        },
        release: () => {
            this.requestsInProcess--;
            this.tokensInProcess -= estimatedTokens;
        }
    })

    private requestReset: NodeJS.Timeout = setTimeout(() => null);
    private tokenReset: NodeJS.Timeout = setTimeout(() => null);
    private limit429: NodeJS.Timeout = setTimeout(() => null);
    private isLimit429 = false;
    updateRateLimit(res: Response) {
        try {
            if (res.status === 429) {
                console.log('(OPEN-AI) RATE LIMIT REACHED');
                this.remainingRequests = 0;
                this.remainingTokens = 0;

                console.log(res)

                clearTimeout(this.requestReset);
                clearTimeout(this.tokenReset);
                clearTimeout(this.limit429);
                this.isLimit429 = true;
                this.limit429 = setTimeout(() => {
                    this.isLimit429 = false;
                    this.remainingRequests = 1;
                    this.remainingTokens = this.limitTokens;
                }, msTime.s * 15) // More optimal for OpenAI rolling window
            } else if (res.status === 200) {
                if (this.isLimit429) return;

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

export class OpenAiPrompts {
    private queue: { 
        reqInit: ReqInit,
        resolve: (value: any) => void 
    }[] = [];
    private limiter: OpenAiRateLimiter;
    private isProcessingQueue = false;
    private responsesRoute: string;
    private apiKey: string;

    constructor(
        opts: {
            apiKey: string;
            openAiResponsesRoute?: string;
        },
    ) {
        // this.genPromptRequest = openAiRequestOptionsFn(llmModel, opts);
        this.limiter = new OpenAiRateLimiter();
        this.apiKey = opts.apiKey;
        this.responsesRoute = opts.openAiResponsesRoute || "https://api.openai.com/v1/responses";
    }

    private async processQueue() {
        if (this.isProcessingQueue || this.queue.length === 0) return;
        this.isProcessingQueue = true;

        while (this.queue.length) {
            const job = this.queue.shift()!;
            const semaphore = this.limiter.semaphore(job.reqInit.estimatedTokens)

            await wait(0);
            while(!semaphore.canGo()) await wait(500);
            this.runJob(job, semaphore)
        }

        this.isProcessingQueue = false;
    }

    private async runJob(
        job: { reqInit: ReqInit; resolve: (v: any) => void },
        sem: ReturnType<OpenAiRateLimiter['semaphore']>,
    ) {
        let tries = 0;
        try {
            sem.acquire();
            job.reqInit.headers.Authorization = "Bearer " + this.apiKey;
            
            let res: OpenAiTryFetchResult;
            while (true) {
                tries++;
                res = await openAITryFetch(this.responsesRoute, job.reqInit);
                if (res.response) this.limiter.updateRateLimit(res.response);

                if (res.ok || !res.retryable || tries >= MAX_RETRIES) break;

                const delayMs = res.retryAfter != null ? res.retryAfter * 1000 : 2_500 * tries;
                await wait(delayMs);
            }

            const data = res.ok ? extractOutputJson(res.data) : null;
            job.resolve({ ...res, data });
        } catch(err) {
            console.log(err);
            job.resolve({ ok: false, status: 0, retryable: false, retryAfter: null, error: null, reason: "non-api-internal" });
        } finally {
            sem.release();
            this.limiter.log(this.queue.length);
        }
    }

    genPromptRequest = <T>(
        llmModel: string,
        opts: PromptReqOpts,
    ) => {
        const systemPrompt = openAiRequestOptionsFn(llmModel, opts);
        return (promptText: string) => {
            const reqInit = systemPrompt(promptText)
            return this.enqueuePrompt<T>(reqInit);
        }
    }

    enqueuePrompt = <T>(reqInit: ReqInit) => new Promise<
        OpenAiTryFetchResult & { data: T }
        |
        OpenAiTryFetchResult & { data?: undefined | null }
    >(resolve => {
        this.queue.push({ reqInit, resolve })
        this.processQueue();
    })
}