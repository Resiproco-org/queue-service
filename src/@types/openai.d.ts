// Types for the OpenAI Responses API (POST /v1/responses), raw-fetch oriented.
// Verified against openai/openai-openapi `Response` schema. Notes inline where
// the published spec lags or where SDK-only fields don't appear on raw fetch.

// Forward-compat helper: keeps literal autocomplete but still accepts any
// future string the server invents, without widening to bare `string`.
type OpenString<T extends string> = T | (string & {});


// ─────────────────────────────────────────────────────────────────────────
// TWO DIFFERENT ERROR SHAPES — do not conflate.
//
//  A) Transport error  → HTTP status is NON-2xx. Body has NO `object:"response"`.
//                        Shape: { error: { message, type, code, param } }
//
//  B) Response error    → HTTP status is 200, body IS a Response object whose
//                        `status === "failed"`, and its `error` field is set.
//                        Shape: { code: <enum>, message }   ← no type, no param
//
// (A) is what `res.ok === false` gives you. (B) lives inside a successful body.
// ─────────────────────────────────────────────────────────────────────────


// ── (A) Transport error — every non-2xx response body ───────────────────
export type OpenAiErrorType = OpenString<
    | "invalid_request_error"
    | "rate_limit_error"
    | "authentication_error"
    | "permission_error"
    | "not_found_error"
    | "server_error"
>;

export interface OpenAiApiError {
    message: string;
    type: OpenAiErrorType;
    code: string | null;   // often "" rather than null in practice — don't truthy-check
    param: string | null;  // same: may be ""
}

export interface OpenAiApiErrorBody {
    error: OpenAiApiError;
}


// ── (B) Response-level error — set when a 200 body has status:"failed" ───
// Closed enum in spec, but new codes appear, so kept forward-compatible.
export type ResponseErrorCode = OpenString<
    | "server_error"
    | "rate_limit_exceeded"
    | "invalid_prompt"
    | "vector_store_timeout"
    | "invalid_image"
    | "invalid_image_format"
    | "invalid_base64_image"
    | "invalid_image_url"
    | "image_too_large"
    | "image_too_small"
    | "image_parse_error"
    | "image_content_policy_violation"
    | "invalid_image_mode"
    | "image_file_too_large"
    | "unsupported_image_media_type"
    | "empty_image_file"
    | "failed_to_download_image"
    | "image_file_not_found"
>;

export interface ResponseError {
    code: ResponseErrorCode;
    message: string;
}


// ── Shared enums ─────────────────────────────────────────────────────────
export type ResponseStatus =
    | "completed"
    | "failed"        // → `error` populated
    | "incomplete"    // → `incomplete_details` populated
    | "in_progress"
    | "cancelled"
    | "queued";

// Reason narrowed by spec; forward-compatible for safety.
export type IncompleteReason = OpenString<"max_output_tokens" | "content_filter">;

export interface IncompleteDetails {
    reason: IncompleteReason;
}

export type ReasoningEffort =
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh";

// Response value reflects the tier actually used; may differ from the request.
export type ServiceTier = "auto" | "default" | "flex" | "scale" | "priority";


// ── Usage ────────────────────────────────────────────────────────────────
export interface ResponseUsage {
    input_tokens: number;
    input_tokens_details: { cached_tokens: number };
    output_tokens: number;
    output_tokens_details: { reasoning_tokens: number };
    total_tokens: number;
}


// ── Text / format config (echoed on the response) ───────────────────────
export type TextFormat =
    | { type: "text" }
    | { type: "json_object" }
    | {
          type: "json_schema";
          name: string;
          schema: Record<string, unknown>;
          strict?: boolean | null;
          description?: string;
      };

export interface ResponseTextConfig {
    format: TextFormat;
    verbosity: "low" | "medium" | "high" | null;
}

// ── tool_choice (request + echoed) ──────────────────────────────────────
export type ToolChoice =
    | "none"
    | "auto"
    | "required"
    | { type: string; [k: string]: unknown }; // e.g. { type:"function", name:"..." }


// ─────────────────────────────────────────────────────────────────────────
// The Response object — the 200 body.
//
// Required-by-spec fields are non-optional. Everything else is marked `?`:
// the spec lists those as optional even though a completed, non-streamed
// response usually returns them populated. Treat `?` as "don't crash if absent".
// ─────────────────────────────────────────────────────────────────────────
// Fields on every response regardless of status (config echo + identity).
interface ResponseBase {
    id: string;
    object: "response";
    /** unix seconds */
    created_at: number;
    model: string;
    instructions: string | InputItem[] | null;
    output: OutputItem[];
    parallel_tool_calls: boolean;
    metadata: Record<string, string>;
    tool_choice: ToolChoice;
    temperature: number;
    top_p: number;

    // echoed config — independent of status, optional per spec
    text?: ResponseTextConfig;
    tools?: Tool[];
    reasoning?: { effort: ReasoningEffort | null; summary: "auto" | "concise" | "detailed" | null };
    previous_response_id?: string | null;
    max_output_tokens?: number | null;
    max_tool_calls?: number | null;
    truncation?: "disabled" | "auto";
    service_tier?: ServiceTier;
    store?: boolean;
    background?: boolean;
    top_logprobs?: number;
    prompt_cache_key?: string | null;
    prompt_cache_retention?: "in_memory" | "24h" | null; // underscore, not "in-memory"
    safety_identifier?: string | null;
    user?: string | null;
    conversation?: { id: string } | null;

    // SDK-only — NOT present on raw fetch
    output_text?: string | null;
    // live-observed, not in published spec
    billing?: { payer: string };
}

export interface CompletedResponse extends ResponseBase {
    status: "completed";
    error: null;
    incomplete_details: null;
    usage: ResponseUsage;      // guaranteed
    completed_at: number;      // guaranteed
}

export interface FailedResponse extends ResponseBase {
    status: "failed";
    error: ResponseError;      // guaranteed non-null
    incomplete_details: null;
    usage?: ResponseUsage;     // may be absent if it failed pre-generation
    completed_at?: number | null;
}

export interface IncompleteResponse extends ResponseBase {
    status: "incomplete";
    error: null;
    incomplete_details: IncompleteDetails;  // guaranteed non-null
    usage: ResponseUsage;      // partial usage still reported
    completed_at?: number | null;
}

// Background mode only (background: true). Sync POSTs never see these.
export interface PendingResponse extends ResponseBase {
    status: "in_progress" | "queued";
    error: null;
    incomplete_details: null;
}

export interface CancelledResponse extends ResponseBase {
    status: "cancelled";
    error: null;
    incomplete_details: null;
}

export type OpenAiResponse =
    | CompletedResponse
    | FailedResponse
    | IncompleteResponse
    | PendingResponse
    | CancelledResponse;


// ─────────────────────────────────────────────────────────────────────────
// Output items — discriminated union on `type`.
// Order/length depend on the model. With reasoning enabled, a reasoning item
// can precede the message. NEVER index output[0] — find by type.
// ─────────────────────────────────────────────────────────────────────────
export type OutputItem =
    | OutputMessage
    | ReasoningItem
    | FunctionCall
    | WebSearchCall
    | FileSearchCall;

export interface OutputMessage {
    type: "message";
    id: string;
    role: "assistant";
    status: "in_progress" | "completed" | "incomplete";
    content: ContentBlock[];
}

export interface ReasoningItem {
    type: "reasoning";
    id: string;
    summary: { type: "summary_text"; text: string }[];
    encrypted_content?: string | null;
    status?: "in_progress" | "completed" | "incomplete";
}

export interface FunctionCall {
    type: "function_call";
    id?: string;          // present when returned via API
    call_id: string;
    name: string;
    arguments: string;    // JSON string — parse it
    status?: "in_progress" | "completed" | "incomplete";
}

export interface WebSearchCall {
    type: "web_search_call";
    id: string;
    status: "in_progress" | "searching" | "completed" | "failed";
    action: Record<string, unknown>; // { type:"search"|"open_page"|"find_in_page", ... }
}

export interface FileSearchCall {
    type: "file_search_call";
    id: string;
    queries: string[];
    status: "in_progress" | "searching" | "completed" | "incomplete" | "failed";
    results?: Record<string, unknown>[];
}


// ── Content blocks: text OR refusal (refusal replaces text entirely) ─────
export type ContentBlock = OutputText | OutputRefusal;

export interface OutputText {
    type: "output_text";
    text: string;          // your json_schema payload lands here, as a string
    annotations: Annotation[];
    logprobs?: LogProb[];
}

export interface OutputRefusal {
    type: "refusal";
    refusal: string;
}

export interface LogProb {
    token: string;
    bytes: number[];
    logprob: number;
    top_logprobs: { token: string; bytes: number[]; logprob: number }[];
}


// ── Annotations on output_text ──────────────────────────────────────────
export type Annotation =
    | { type: "url_citation"; url: string; title: string; start_index: number; end_index: number }
    | { type: "file_citation"; file_id: string; filename: string; index: number }
    | { type: "file_path"; file_id: string; index: number }
    | {
          type: "container_file_citation";
          container_id: string;
          file_id: string;
          filename: string;
          start_index: number;
          end_index: number;
      };


// ─────────────────────────────────────────────────────────────────────────
// Request-side helpers (kept here for one-file convenience).
// ─────────────────────────────────────────────────────────────────────────

// Input items — what you send, and what `instructions` can be an array of.
// Loosely typed; tighten if you construct rich multi-part inputs.
export interface InputItem {
    role?: "user" | "assistant" | "developer" | "system";
    type?: string;
    content?: unknown;
    [k: string]: unknown;
}

export type Tool =
    | FunctionTool
    | { type: "web_search" | "web_search_2025_08_26" }
    | { type: "file_search"; vector_store_ids: string[] }
    | { type: string; [k: string]: unknown }; // permissive fallback for other hosted tools

export interface FunctionTool {
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict: boolean;
}


// ─────────────────────────────────────────────────────────────────────────
// Convenience: what a raw fetch resolves to.
// ─────────────────────────────────────────────────────────────────────────
export type OpenAiTryFetchResult =
    | { ok: true; data: OpenAiResponse; response: Response | null }
    | {
        ok: false;
        status: number;            // 0 on network failure
        retryable: boolean;
        retryAfter: number | null; // seconds, from Retry-After header
        error: OpenAiApiError | ResponseError | null;
        reason: "network" | "http" | "parse" | "failed" | "incomplete" | "non-api-internal";
        response: Response | null;
    };