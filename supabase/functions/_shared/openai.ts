/**
 * Shared OpenAI helpers for Edge Functions. Deno runtime.
 *
 * DELIBERATELY NOT A CHAT CLIENT ANY MORE. Every word the app generates is
 * written by Claude (`_shared/anthropic.ts`). What is left here is the three
 * things Anthropic does not do at all:
 *
 *   • embeddings      — `embed`, text-embedding-3-small, 1536 dims. The company
 *                       brain's vectors are this shape, so changing it would
 *                       mean re-embedding every document.
 *   • transcription   — `whisperTranscribe`, for crew voice memos.
 *   • image generation — not here; `generate-toolbox-talk` calls it directly.
 *
 * `chatJson` / `chatJsonVision` used to live here and are gone on purpose:
 * leaving them behind is how a feature quietly ends up back on a second AI bill.
 * Use `anthropicChatJson` instead — it enforces strict JSON without OpenAI's
 * `response_format` flag.
 */

export const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
export const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
export const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

export function requireOpenAI(): string {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY secret is not set");
  }
  return OPENAI_API_KEY;
}

export function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("Origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
  };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** What the provider says it charged for, so the spend ceiling can be reconciled
 * against real token usage rather than an estimate of call counts. */
export interface OpenAiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export type UsageSink = (usage: OpenAiUsage) => void;

/** Pull `usage` off an embeddings response, tolerating its absence. */
function readUsage(data: { usage?: unknown }): OpenAiUsage {
  const u = (data.usage ?? {}) as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    inputTokens: num(u.prompt_tokens) ?? num(u.total_tokens),
    outputTokens: num(u.completion_tokens),
  };
}

/**
 * Batch-embed texts with text-embedding-3-small (1536 dims). Returns one
 * vector per input, in the same order. The OpenAI embeddings endpoint accepts
 * an array input, so a whole chunk batch is one request.
 */
export async function embed(
  texts: string[],
  onUsage?: UsageSink,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const key = requireOpenAI();
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texts,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI embeddings failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  onUsage?.(readUsage(data));
  const rows = (data.data ?? []) as Array<{ index: number; embedding: number[] }>;
  // Sort by index so the returned order always matches the input order.
  return rows
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((r) => r.embedding);
}

export async function whisperTranscribe(
  audio: Blob,
  filename: string,
): Promise<string> {
  const key = requireOpenAI();
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", "whisper-1");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Whisper failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return String(data.text ?? "");
}
