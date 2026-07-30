/** Shared Anthropic (Claude) helpers for Edge Functions. Deno runtime.
 *
 * Mirrors the shape of `_shared/openai.ts` so every text feature can generate
 * with Claude. The only hard dependency for chat is the Anthropic key; OpenAI is
 * now only used for the three things Anthropic does not do — embeddings,
 * Whisper transcription and image generation.
 *
 * The strict-JSON helpers below replace OpenAI's `response_format:
 * {type: "json_object"}`. All the parsing they rely on lives in
 * `anthropicJson.ts`, which is pure and therefore unit-tested. */

import {
  alignToSchema,
  buildJsonToolRequest,
  JSON_TOOL_NAME,
  type JsonSchema,
  missingRequiredKeys,
  readJsonFromContent,
} from "./anthropicJson.ts";

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

/** What the provider says it charged for. Reported so the spend ceiling can be
 * reconciled against real usage instead of an estimate of call counts. */
export interface AnthropicUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Pull `usage` off a Messages API response, tolerating its absence. */
function readUsage(data: { usage?: unknown }): AnthropicUsage {
  const u = (data.usage ?? {}) as { input_tokens?: unknown; output_tokens?: unknown };
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens) };
}

interface AnthropicChatOptions {
  /** Top-level system prompt (NOT a message with role "system"). */
  system: string;
  /** Conversation turns — only user/assistant roles, must start with a user turn. */
  messages: AnthropicMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Receives the token counts the API reported. Never affects the answer. */
  onUsage?: (usage: AnthropicUsage) => void;
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
  /** Receives the token counts the API reported. Never affects the answer. */
  onUsage?: (usage: AnthropicUsage) => void;
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
  opts.onUsage?.(readUsage(data));
  const blocks = (data.content ?? []) as AnthropicTextBlock[];
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

interface AnthropicJsonOptions {
  /** The task, as the top-level system prompt. */
  system: string;
  /** The content of the single user turn. */
  user: string;
  /** Prose notes about the answer shape: ranges, examples, what to leave null. */
  schemaHint: string;
  /** The machine-checkable answer shape, as a JSON Schema object. */
  schema: JsonSchema;
  /** Images to reason over. Omit for a text-only call. */
  images?: AnthropicImage[];
  model?: string;
  maxTokens?: number;
  /** Receives the token counts the API reported. Never affects the answer. */
  onUsage?: (usage: AnthropicUsage) => void;
}

/**
 * Ask Claude for one JSON object and return it parsed — the replacement for
 * OpenAI's `chatJson` / `chatJsonVision`.
 *
 * THROWS when no JSON could be recovered, exactly as `JSON.parse` did on the
 * OpenAI path. Returning a half-empty object instead would let a broken answer
 * be written to the database as though it were a real one, which is the failure
 * this whole migration has to avoid; every caller already handles a throw.
 */
export async function anthropicChatJson<T>(
  opts: AnthropicJsonOptions,
): Promise<T> {
  const key = requireAnthropic();
  const images = opts.images ?? [];
  const content: unknown[] = [{ type: "text", text: opts.user }];
  for (const img of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data },
    });
  }

  // Token counts across every request made below, so a repaired answer is still
  // charged for what it really cost.
  const totals: AnthropicUsage = { inputTokens: 0, outputTokens: 0 };

  const ask = async (messages: { role: "user" | "assistant"; content: unknown }[]) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(
        buildJsonToolRequest({
          model: opts.model ?? ANTHROPIC_MODEL,
          // 8192, not 4096. Only tokens actually generated are billed, so a
          // ceiling with headroom costs nothing and a talk cut short costs a
          // feature.
          maxTokens: opts.maxTokens ?? 8192,
          system: opts.system,
          schemaHint: opts.schemaHint,
          schema: opts.schema,
          messages,
        }),
      ),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic JSON chat failed: ${res.status} ${text}`);
    }
    const data = await res.json();
    const usage = readUsage(data);
    totals.inputTokens = (totals.inputTokens ?? 0) + (usage.inputTokens ?? 0);
    totals.outputTokens = (totals.outputTokens ?? 0) + (usage.outputTokens ?? 0);
    opts.onUsage?.({ ...totals });
    const parsed = readJsonFromContent(data.content);
    const obj =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? alignToSchema(opts.schema, parsed as Record<string, unknown>)
        : null;
    return { obj, stopReason: data.stop_reason as string | undefined };
  };

  const first = await ask([{ role: "user", content }]);
  if (!first.obj) {
    throw new Error("Anthropic returned no parseable JSON object");
  }

  let answer = first.obj;
  let missing = missingRequiredKeys(opts.schema, answer);

  // ONE repair attempt. Live, a toolbox talk came back finished-looking — the
  // model ended its turn deliberately — carrying only its title, intro and
  // hazards, and its steps, do's and don'ts were simply not there. Asking again
  // for the fields that are short, with what already arrived in hand, gets the
  // rest far more cheaply than a failed feature costs. Once only: a model that
  // will not answer twice will not answer five times either.
  if (missing.length > 0) {
    const repair = await ask([
      { role: "user", content },
      {
        role: "assistant",
        content: `My answer so far: ${JSON.stringify(answer)}`,
      },
      {
        role: "user",
        content:
          `That answer is missing ${missing.join(", ")}. Call ${JSON_TOOL_NAME} ` +
          "once more with the COMPLETE answer — every field, including the ones " +
          "already given. Keep each field short enough that you can finish all " +
          "of them in one call.",
      },
    ]);
    if (repair.obj) answer = { ...answer, ...repair.obj };
    missing = missingRequiredKeys(opts.schema, answer);
  }

  // A HALF answer must fail as loudly as no answer. Live, a talk arrived with
  // part of its content, saved, and looked like any other talk in the list.
  // Refusing keeps the hollow row out of the database, and naming both what is
  // short and what did arrive is what turned this from a guess into a diagnosis.
  if (missing.length > 0) {
    const why =
      first.stopReason === "max_tokens"
        ? " because the reply hit the token ceiling and was cut off"
        : ` (stop_reason: ${String(first.stopReason ?? "unknown")})`;
    throw new Error(
      `Anthropic answer is incomplete${why}: missing ${missing.join(", ")}` +
        `; it sent ${Object.keys(answer).join(", ") || "nothing"}`,
    );
  }
  return answer as T;
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
  opts.onUsage?.(readUsage(data));
  const blocks = (data.content ?? []) as AnthropicTextBlock[];
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}
