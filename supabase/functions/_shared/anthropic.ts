/** Shared Anthropic (Claude) helpers for Edge Functions. Deno runtime.
 *
 * Mirrors the shape of `_shared/openai.ts` so the `ask` function can generate
 * answers with Claude. The only hard dependency for chat is the Anthropic key;
 * OpenAI is now only used opportunistically for embeddings/RAG. */

export const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

/** The chat model. Overridable via env; defaults to a confirmed-valid id. */
export const ANTHROPIC_MODEL =
  Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5";

export function requireAnthropic(): string {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY secret is not set");
  }
  return ANTHROPIC_API_KEY;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicChatOptions {
  /** Top-level system prompt (NOT a message with role "system"). */
  system: string;
  /** Conversation turns — only user/assistant roles, must start with a user turn. */
  messages: AnthropicMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

interface AnthropicTextBlock {
  type: string;
  text?: string;
}

/**
 * POST to the Anthropic Messages API and return the assistant's text, formed by
 * concatenating the text blocks of the response. Throws on any non-2xx status,
 * including the status code and response body for debugging.
 */
export async function anthropicChat(opts: AnthropicChatOptions): Promise<string> {
  const key = requireAnthropic();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    // NOTE: `temperature` is only included when a caller explicitly sets it.
    // Newer Claude models (e.g. claude-sonnet-5) reject `temperature` with a
    // 400 "deprecated for this model", so we must not send a default.
    body: JSON.stringify({
      model: opts.model ?? ANTHROPIC_MODEL,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages: opts.messages,
      ...(typeof opts.temperature === "number"
        ? { temperature: opts.temperature }
        : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic chat failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  const blocks = (data.content ?? []) as AnthropicTextBlock[];
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}
