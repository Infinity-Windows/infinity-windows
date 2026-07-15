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
