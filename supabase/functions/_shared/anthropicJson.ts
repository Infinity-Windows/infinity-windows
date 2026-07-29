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

/**
 * Read a list-of-strings field however the model chose to phrase it.
 *
 * A schema names the fields; it does not force their TYPE hard enough to rely
 * on. The observed failure was a talk whose title and intro arrived as strings
 * and whose four lists arrived as nothing the reader recognised, so every list
 * section rendered empty and the talk saved looking fine. `Array.isArray` said
 * no, and no was the end of it.
 *
 * A single string is a list of one, or a bulleted list the model wrote as prose.
 * Both are answers, so both are read rather than thrown away. Bullet markers are
 * stripped only from lines that came out of a string — an item that arrived
 * inside a real list is the model's own text and is left exactly as written, so
 * a hazard like "3/4 inch shims can walk out" keeps its measurement.
 */
export function toStringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split("\n")
      .map((line) => line.replace(/^\s*(?:[-•*]|\d+[.)])\s+/, "").trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? "").trim()).filter(Boolean);
}

const normalizeKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Fill a required field that arrived under a near-miss name.
 *
 * The schema asks for `key_hazards`; a model that answers `hazards` has answered
 * the question and failed the spelling test, and throwing away a full set of
 * hazards over an underscore is not a trade worth making. So a required key that
 * is missing is matched against what did arrive, ignoring case and punctuation,
 * and accepted when one name is the tail of the other — `hazards` for
 * `key_hazards`, `next_steps` for `steps`.
 *
 * Deliberately narrow. It only ever fills a key that is absent, never overwrites
 * one the model got right, and the tail has to be at least four characters, so
 * `dos` cannot be read as `donts` and no two short fields can collide. Anything
 * looser would silently answer one question with another, which is the failure
 * this file exists to prevent.
 */
export function alignToSchema(
  schema: JsonSchema,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const out = { ...value };
  for (const key of required) {
    if (typeof key !== "string") continue;
    if (out[key] !== undefined && out[key] !== null) continue;
    const want = normalizeKey(key);
    const match = Object.keys(out).find((k) => {
      if (required.includes(k)) return false;
      const got = normalizeKey(k);
      if (got === want) return true;
      const short = got.length < want.length ? got : want;
      const long = got.length < want.length ? want : got;
      return short.length >= 4 && long.endsWith(short);
    });
    if (match !== undefined) {
      out[key] = out[match];
      delete out[match];
    }
  }
  return out;
}

/**
 * Which of the schema's top-level `required` keys are absent from the answer.
 *
 * This is the guard against a HALF answer, which is a nastier failure than no
 * answer and the one that actually happened: a toolbox talk came back with its
 * title and opening paragraph and no hazards, no steps, no do's and no don'ts.
 * It saved, it looked like a talk in the list, and its whole body was missing.
 * Nothing threw, because every field the code read was simply `undefined` and
 * `undefined` cleans up into an empty list.
 *
 * A reply cut short by the token ceiling looks exactly like that: the API hands
 * back the keys the model finished, and the rest never arrived. So the caller
 * checks this and refuses the answer, rather than writing a hollow row and
 * leaving somebody to notice weeks later.
 *
 * Top-level only, and presence only. An empty list can be a true answer — a
 * planset really can have no openings — so emptiness is the caller's business,
 * not this function's.
 */
export function missingRequiredKeys(
  schema: JsonSchema,
  value: unknown,
): string[] {
  const required = schema?.required;
  if (!Array.isArray(required)) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return required.filter((k): k is string => typeof k === "string");
  }
  const obj = value as Record<string, unknown>;
  return required.filter(
    (k): k is string =>
      typeof k === "string" && (!(k in obj) || obj[k] === null || obj[k] === undefined),
  );
}

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
