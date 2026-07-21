/** Shared OpenAI helpers for Edge Functions. Deno runtime. */

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

export async function chatJson<T>(
  system: string,
  user: string,
  schemaHint: string,
): Promise<T> {
  const key = requireOpenAI();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system + "\n\nRespond with JSON only. " + schemaHint },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI chat failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned empty content");
  return JSON.parse(content) as T;
}

/**
 * JSON chat with optional image inputs (GPT-4o vision). Image URLs must be
 * publicly reachable or signed. Falls back to text-only when no images.
 */
export async function chatJsonVision<T>(
  system: string,
  user: string,
  schemaHint: string,
  imageUrls: string[] = [],
): Promise<T> {
  const key = requireOpenAI();
  const content: unknown[] = [{ type: "text", text: user }];
  for (const url of imageUrls) {
    content.push({ type: "image_url", image_url: { url, detail: "low" } });
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system + "\n\nRespond with JSON only. " + schemaHint },
        { role: "user", content },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI vision chat failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  const out = data.choices?.[0]?.message?.content;
  if (!out) throw new Error("OpenAI returned empty content");
  return JSON.parse(out) as T;
}

/**
 * Batch-embed texts with text-embedding-3-small (1536 dims). Returns one
 * vector per input, in the same order. The OpenAI embeddings endpoint accepts
 * an array input, so a whole chunk batch is one request.
 */
export async function embed(texts: string[]): Promise<number[][]> {
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
