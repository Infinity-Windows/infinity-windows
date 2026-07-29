/**
 * Getting STRICT JSON out of Claude. Pure functions only — no `Deno`, no
 * `fetch` — so the browser test suite can exercise every branch of the parsing
 * that the app's features now depend on.
 *
 * OpenAI's chat API had `response_format: { type: "json_object" }`, which made
 * "the reply parses" someone else's problem. Anthropic has no identical flag, so
 * the guarantee is rebuilt here out of two things:
 *
 *  1. TOOL USE, forced. The model is given one tool whose input schema IS the
 *     answer shape and `tool_choice` that names it, so the reply arrives as a
 *     `tool_use` block whose `input` the API has already parsed into an object.
 *     There is no prose to strip and no fence to unwrap.
 *  2. A TOLERANT TEXT FALLBACK, for the day a model ignores the tool and just
 *     talks. `parseJsonLoose` unwraps a ```json fence or digs the first {...}
 *     span out of a chatty answer.
 *
 * The reason (1) is not merely tidier: a Claude reply can contain a `thinking`
 * block that has no `text` field at all. Concatenating `.text` across blocks
 * then yields "", and "" fails to parse — a live bug in this repo already. The
 * tool's `input` is immune, and the fallback below skips text-less blocks
 * instead of turning them into empty strings.
 */

/** The one tool every JSON call offers. The name is arbitrary but stable. */
export const JSON_TOOL_NAME = "emit_json";

/** One content block of an Anthropic Messages API reply. */
export interface AnthropicContentBlock {
  type?: string;
  /** Present on `text` blocks. ABSENT on `thinking` blocks — see the header. */
  text?: string;
  /** Present on `tool_use` blocks. */
  name?: string;
  /** Present on `tool_use` blocks: the arguments, already parsed by the API. */
  input?: unknown;
}

/**
 * Pull the first JSON value out of a chunk of model prose, tolerating a
 * ```json fence and a preamble before the object.
 */
export function parseJsonLoose(text: string): unknown {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * The answer object from a Messages API reply's content blocks, or null when
 * there isn't one. Prefers the forced tool call; falls back to text blocks.
 *
 * A `tool_use` block under any name is accepted as long as its input is an
 * object, because a wrong tool name is a far less likely mistake than a model
 * renaming its own call, and refusing it would throw away a perfectly good
 * answer. The configured name wins when several are present.
 */
export function readJsonFromContent(content: unknown): unknown {
  const blocks: AnthropicContentBlock[] = Array.isArray(content) ? content : [];

  let fallbackToolInput: unknown = null;
  for (const block of blocks) {
    if (!block || block.type !== "tool_use") continue;
    const input = block.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    if (block.name === JSON_TOOL_NAME) return input;
    if (fallbackToolInput === null) fallbackToolInput = input;
  }
  if (fallbackToolInput !== null) return fallbackToolInput;

  // No tool call. Join only the blocks that actually carry text, so a `thinking`
  // block contributes nothing rather than an empty string.
  const text = blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
  return parseJsonLoose(text);
}

/** A JSON Schema for the answer. Must describe an object at the top level. */
export type JsonSchema = Record<string, unknown>;

export interface AnthropicJsonMessage {
  role: "user" | "assistant";
  content: unknown;
}

export interface JsonToolRequestOptions {
  model: string;
  maxTokens: number;
  /** The task description, as the top-level system prompt. */
  system: string;
  /** Prose notes about the shape — ranges, examples, what to leave null. */
  schemaHint: string;
  /** The machine-checkable shape. Becomes the tool's `input_schema`. */
  schema: JsonSchema;
  messages: AnthropicJsonMessage[];
}

/**
 * The Messages API request body that forces exactly one JSON tool call.
 *
 * Deliberately has no `temperature` parameter and never emits the key:
 * `claude-sonnet-5` rejects `temperature` outright with an HTTP 400, which took
 * a feature down in production once already.
 */
export function buildJsonToolRequest(
  opts: JsonToolRequestOptions,
): Record<string, unknown> {
  return {
    model: opts.model,
    max_tokens: opts.maxTokens,
    system:
      `${opts.system}\n\nReturn your answer by calling the ${JSON_TOOL_NAME} ` +
      "tool exactly once. Put the entire answer in the tool input. Do not " +
      "write any prose, explanation or markdown, and do not wrap the JSON in " +
      `a code fence.\n\n${opts.schemaHint}`,
    messages: opts.messages,
    tools: [
      {
        name: JSON_TOOL_NAME,
        description:
          "Return the extracted/generated answer as JSON. " + opts.schemaHint,
        input_schema: opts.schema,
      },
    ],
    tool_choice: { type: "tool", name: JSON_TOOL_NAME },
  };
}
