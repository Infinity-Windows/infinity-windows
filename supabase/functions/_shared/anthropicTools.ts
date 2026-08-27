/**
 * Anthropic tool-calling (function-calling) plumbing. Pure functions and one
 * pure ORCHESTRATOR only — no `Deno`, no `fetch` — mirroring anthropicJson.ts's
 * own header: the whole reason this is a separate file is so the browser test
 * suite can drive the tool_use/tool_result loop with a mocked model and a
 * mocked tool executor, never a real network call.
 *
 * `anthropicJson.ts` forces exactly ONE tool call to get strict JSON out of a
 * single turn. This file is the general case: the model may call zero or more
 * tools, read their results, and call more — a real agent loop, not a single
 * forced call. Wave A's scheduling toolset (get_scheduling_picture,
 * draft_assignments, clear_ai_drafts) is the first caller.
 */

import type { JsonSchema } from "./anthropicJson.ts";

/** One tool offered to the model, in the Messages API's own shape. */
export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

/** One content block of a Messages API reply — text, tool_use, or thinking. */
export interface ToolLoopContentBlock {
  type?: string;
  /** Present on `text` blocks. */
  text?: string;
  /** Present on `tool_use` blocks. */
  id?: string;
  name?: string;
  input?: unknown;
}

/** A parsed `tool_use` block: the model asking to call one tool once. */
export interface ToolUseBlock {
  id: string;
  name: string;
  input: unknown;
}

/** Every `tool_use` block in a reply's content, in the order the model made them. */
export function parseToolUseBlocks(content: unknown): ToolUseBlock[] {
  const blocks: ToolLoopContentBlock[] = Array.isArray(content) ? content : [];
  const out: ToolUseBlock[] = [];
  for (const b of blocks) {
    if (!b || b.type !== "tool_use") continue;
    if (typeof b.id !== "string" || typeof b.name !== "string") continue;
    out.push({ id: b.id, name: b.name, input: b.input });
  }
  return out;
}

/** The text of a reply, joining only blocks that actually carry text — a
 * `thinking` or `tool_use` block contributes nothing rather than "undefined". */
export function extractText(content: unknown): string {
  const blocks: ToolLoopContentBlock[] = Array.isArray(content) ? content : [];
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
}

/** One tool's outcome, fed back to the model as a `tool_result` block. */
export interface ToolResultInput {
  tool_use_id: string;
  /** Always a string — the executor's own JSON.stringify or plain sentence. */
  content: string;
  is_error?: boolean;
}

/** Shape a batch of tool outcomes into the single user turn Anthropic expects
 * to follow an assistant turn full of `tool_use` blocks. */
export function buildToolResultContent(results: ToolResultInput[]): unknown[] {
  return results.map((r) => ({
    type: "tool_result",
    tool_use_id: r.tool_use_id,
    content: r.content,
    ...(r.is_error ? { is_error: true } : {}),
  }));
}

/** At most this many requests to the model per loop — a real ceiling, not a
 * suggestion. Chosen in a1-ai-scheduler-spec.md (A2): "bounded to ≤6 round
 * trips". A round trip is one call to `send`, whether or not it asks for a
 * tool, so a plan that never touches a tool still finishes in round 1. */
export const MAX_TOOL_ROUNDS = 6;

export interface ToolLoopMessage {
  role: "user" | "assistant";
  /** A plain string for an ordinary turn, or a content-block array once tool
   * use enters the conversation — the Messages API accepts either. */
  content: unknown;
}

export interface ToolLoopUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ToolLoopResponse {
  content: unknown;
  /** "tool_use" keeps the loop going; anything else (usually "end_turn") ends it. */
  stop_reason?: string;
  usage?: { inputTokens: number | null; outputTokens: number | null };
}

export interface ToolLoopResult {
  /** The model's final prose — empty when the loop was truncated mid-tool-use. */
  text: string;
  /** Every tool the model actually called, in order, for building progress lines. */
  toolCalls: Array<{ name: string; input: unknown }>;
  /** How many requests to the model this took (1..maxRounds). */
  rounds: number;
  /** True when the round-trip ceiling hit while the model still wanted a tool —
   * the loop stopped rather than execute a round it can't get an answer for. */
  truncated: boolean;
  usage: ToolLoopUsage;
}

export interface ToolLoopOptions {
  initialMessages: ToolLoopMessage[];
  /** Calls the model once with the running transcript. The only impure seam —
   * a test supplies a mock here instead of a real fetch. */
  send: (messages: ToolLoopMessage[]) => Promise<ToolLoopResponse>;
  /** Runs one tool call and returns what to tell the model. Never throws by
   * contract — a failing tool returns `is_error: true` instead, same as the
   * model's own tool_result convention, so the loop itself needs no try/catch. */
  executeTool: (name: string, input: unknown) => Promise<{ content: string; is_error?: boolean }>;
  maxRounds?: number;
}

/**
 * Drive the tool_use / tool_result loop to completion or the round-trip
 * ceiling, whichever comes first.
 *
 * Bounded deliberately, the same philosophy as anthropicChatJson's ONE repair
 * attempt: an unbounded agent loop is the runaway docs/ai-spend-limits.md
 * exists to prevent, and a model that still wants six more tools after six
 * has a bug worth surfacing, not feeding.
 */
export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const maxRounds = Math.max(1, Math.floor(opts.maxRounds ?? MAX_TOOL_ROUNDS));
  const messages: ToolLoopMessage[] = [...opts.initialMessages];
  const usage: ToolLoopUsage = { inputTokens: 0, outputTokens: 0 };
  const toolCalls: Array<{ name: string; input: unknown }> = [];

  for (let round = 1; round <= maxRounds; round++) {
    const res = await opts.send(messages);
    usage.inputTokens += res.usage?.inputTokens ?? 0;
    usage.outputTokens += res.usage?.outputTokens ?? 0;

    const toolUses = parseToolUseBlocks(res.content);
    if (toolUses.length === 0 || res.stop_reason !== "tool_use") {
      return { text: extractText(res.content), toolCalls, rounds: round, truncated: false, usage };
    }

    // The model wants to call tools but this was the last round the ceiling
    // allows — stop rather than execute tools it will never get to answer
    // with. Whatever prose came with this reply (often none) is all there is.
    if (round === maxRounds) {
      return { text: extractText(res.content), toolCalls, rounds: round, truncated: true, usage };
    }

    messages.push({ role: "assistant", content: res.content });
    const results: ToolResultInput[] = [];
    for (const tu of toolUses) {
      toolCalls.push({ name: tu.name, input: tu.input });
      const out = await opts.executeTool(tu.name, tu.input);
      results.push({ tool_use_id: tu.id, content: out.content, is_error: out.is_error === true });
    }
    messages.push({ role: "user", content: buildToolResultContent(results) });
  }

  // Unreachable — the loop always returns on or before round === maxRounds —
  // but TypeScript needs every path to return.
  return { text: "", toolCalls, rounds: maxRounds, truncated: true, usage };
}
