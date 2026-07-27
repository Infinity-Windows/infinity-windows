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

/** A base64 image ready for an Anthropic image content block. */
export interface AnthropicImage {
  /** e.g. "image/jpeg" or "image/png". */
  mediaType: string;
  /** Raw base64 (no `data:` prefix). */
  data: string;
}

interface AnthropicVisionOptions {
  /** Top-level system prompt. */
  system: string;
  /** The instruction text shown alongside the image(s). */
  text: string;
  /** One or more images to transcribe/reason over. */
  images: AnthropicImage[];
  model?: string;
  maxTokens?: number;
}

/**
 * Split a `data:<mime>;base64,<data>` URL into an {@link AnthropicImage}.
 * Returns null when the string isn't a base64 data URL.
 */
export function dataUrlToImage(dataUrl: string): AnthropicImage | null {
  const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(dataUrl ?? "");
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

/**
 * Vision chat: send text + image content blocks to the Anthropic Messages API
 * and return the assistant's text. Uses the same model/headers as
 * {@link anthropicChat}; `claude-sonnet-5` supports image inputs. As with the
 * text helper, `temperature` is intentionally never sent (newer models reject
 * it). Throws on any non-2xx status with the body for debugging.
 */
export async function anthropicVisionChat(
  opts: AnthropicVisionOptions,
): Promise<string> {
  const key = requireAnthropic();
  const content: unknown[] = [{ type: "text", text: opts.text }];
  for (const img of opts.images) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType,
        data: img.data,
      },
    });
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model ?? ANTHROPIC_MODEL,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.system,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic vision chat failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  const blocks = (data.content ?? []) as AnthropicTextBlock[];
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
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
