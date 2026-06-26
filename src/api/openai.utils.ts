import type { OpenAiApiError, OpenAiResponse, OpenAiTryFetchResult, OutputMessage } from "../@types/openai.js";

import { msTime } from "@giveback007/util-lib";

export type SchemaProperty =
    | { type: "string"; enum?: string[] }
    | { type: "boolean" }
    | { type: "number" }
    | { type: "integer" }
    | { type: "array"; items: SchemaProperty }
    | SchemaObject;

export type SchemaObject = {
    type: "object";
    properties: Record<string, SchemaProperty>;
    required: string[];
    additionalProperties: false;
}

export type OpenAISchema = {
    type: "json_schema";
    name: string;
    description?: string;
    strict: true;
    schema: SchemaObject;
};

export type PromptReqOpts = {
    systemPrompt: string;
    jsonSchema: OpenAISchema;
    verbosity?: "low" | "medium" | "high";
    reasoning: {
        effort: 'none' | "minimal" | 'low' | 'medium' | 'high' | 'xhigh',
        summary?: null | "auto" | "detailed" | "concise",
    };
    estimatedTokens: number;
}

export type ReqInit = {
    method: 'POST';
    headers: {
        "Content-Type": "application/json";
        Authorization?: string;
    };
    body: string;
    estimatedTokens: number;
}

// Extract the schema-constrained text (or null for the 3 failure modes).
export function extractOutputText(res: OpenAiResponse): string | null {
    try {
        if (res.status === "failed" || res.status === "incomplete") return null;
        const msg = res.output.find((o): o is OutputMessage => o.type === "message");
        const block = msg?.content[0];
        if (!block || block.type === "refusal") return null;
        return block.text;
    } catch {
        return null;
    }
}

export function extractOutputJson(res: OpenAiResponse) {
    try {
        const text = extractOutputText(res);
        return text && JSON.parse(text);
    } catch {
        return null;
    }
}

const retryableHttp = (s: number) =>
    s === 408 || s === 409 || s === 429 || s >= 500;

// Retry-After is normally integer seconds; an HTTP-date → NaN → null.
function parseRetryAfter(res: Response): number | null {
    const v = Number(res.headers.get("retry-after"));
    return Number.isFinite(v) ? v : null;
}

export async function openAITryFetch(
    reqRoute: string,
    reqInit: ReqInit,
): Promise<OpenAiTryFetchResult> {
    let response: Response | null = null;
    try {
        response = await fetch(reqRoute, reqInit);
    } catch (err) {
        console.error("(OPEN-AI) network error", err);
        return { ok: false, status: 0, retryable: true, retryAfter: null, error: null, reason: "network", response };
    }

    const retryAfter = parseRetryAfter(response);

    // Transport error (non-2xx): body is { error: { message, type, code, param } }.
    if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: OpenAiApiError } | null;
        return {
            ok: false,
            status: response.status,
            retryable: retryableHttp(response.status),
            retryAfter,
            error: body?.error ?? null,
            reason: "http",
            response,
        };
    }

    // 200, but the body might not parse.
    const data = (await response.json().catch(() => null)) as OpenAiResponse | null;
    if (!data) {
        return { ok: false, status: response.status, retryable: true, retryAfter, error: null, reason: "parse", response };
    }

    // 200 + status:"failed" → ResponseError populated. Retry only transient codes.
    if (data.status === "failed") {
        const code = data.error?.code;
        return {
            ok: false,
            status: response.status,
            retryable: code === "server_error" || code === "rate_limit_exceeded",
            retryAfter,
            error: data.error ?? null,
            reason: "failed",
            response,
        };
    }

    // 200 + status:"incomplete" → truncated (max_output_tokens / content_filter). Deterministic, don't retry.
    if (data.status === "incomplete") {
        return { ok: false, status: response.status, retryable: false, retryAfter, error: null, reason: "incomplete", response };
    }

    // Usable. Refusal / empty-text is a content-level concern — caller runs extractOutputText.
    return { ok: true, data, response };
}

type InputContent =
    | { type: "input_file"; filename: string; file_data: string }
    | { type: "input_text"; text: string }
    | { type: "input_file"; file_id: string }
    | { type: "input_file"; file_url: string }
    | { type: "input_image"; file_id: string }
    | { type: "input_image"; image_url: string };

type InputMessage = {
    role: "user" | "developer";
    content: InputContent[];
};

export type FileInput =
    | { type: "base64"; filename: string; data: string; mime?: string }
    | { type: "file_id"; id: string }
    | { type: "file_url"; url: string }
    | { type: "image_url"; url: string }
    | { type: "image_id"; id: string };

function toContentBlock(f: FileInput): InputContent {
    switch (f.type) {
        case "file_id":
            return { type: "input_file", file_id: f.id };
        case "file_url":
            return { type: "input_file", file_url: f.url };
        case "base64": {
            const mime = f.mime ?? "application/pdf";
            // accept bare base64 or full data URI
            const data = f.data.startsWith("data:") ?
                f.data
                :
                `data:${mime};base64,${f.data}`;
            return { type: "input_file", filename: f.filename, file_data: data };
        }
        case "image_url":
            return { type: "input_image", image_url: f.url };
        case "image_id":
            return { type: "input_image", file_id: f.id };
    }
}

export function openAiRequestOptionsFn(
    llmModel: string,
    opts: PromptReqOpts,
) {
    const {
        verbosity = 'low',
        reasoning,
    } = opts;

    if (!reasoning.summary) reasoning.summary = null;

    const body = {
        model: llmModel,
        reasoning,
        store: false,
        tools: [],
        include: [],
        text: {
            format: opts.jsonSchema,
            verbosity,
        },
    }

    const getInputs = (
        text: string,
        files: FileInput[] = [],
    ) => {
        const input: InputMessage[] = [{
            role: "user",
            content: [
                ...files.map(f => toContentBlock(f)),
                { type: "input_text", text }
            ] }];

        if (opts.systemPrompt) input.unshift({
            role: "developer",
            content: [{ type: "input_text", text: opts.systemPrompt }]
        })

        return input;
    }

    return (inputText: string, files?: FileInput[]): ReqInit => ({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        estimatedTokens: opts.estimatedTokens,
        body: JSON.stringify({
            ...body,
            input: getInputs(inputText, files)
        }),
    })
}

export function getMsTime(time: string) {
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