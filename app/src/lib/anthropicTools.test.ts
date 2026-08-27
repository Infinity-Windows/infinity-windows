import { describe, expect, it, vi } from "vitest";
import {
  buildToolResultContent,
  extractText,
  MAX_TOOL_ROUNDS,
  parseToolUseBlocks,
  runToolLoop,
  type ToolLoopResponse,
} from "../../../supabase/functions/_shared/anthropicTools.ts";

// The whole point of this file: drive the tool_use/tool_result loop with a
// mocked model (`send`) and a mocked tool executor, so wave A's scheduling
// toolset is provably bounded and provably wires tool results back correctly
// without ever touching the real Anthropic API.

describe("parseToolUseBlocks", () => {
  it("pulls only well-formed tool_use blocks, in order", () => {
    const content = [
      { type: "text", text: "Reading the week…" },
      { type: "tool_use", id: "t1", name: "get_scheduling_picture", input: { from: "2026-09-01" } },
      { type: "thinking" },
      { type: "tool_use", id: "t2", name: "draft_assignments", input: { entries: [] } },
      { type: "tool_use", name: "missing_id", input: {} }, // no id — dropped
    ];
    expect(parseToolUseBlocks(content)).toEqual([
      { id: "t1", name: "get_scheduling_picture", input: { from: "2026-09-01" } },
      { id: "t2", name: "draft_assignments", input: { entries: [] } },
    ]);
  });

  it("returns empty for non-array content", () => {
    expect(parseToolUseBlocks("just text")).toEqual([]);
    expect(parseToolUseBlocks(undefined)).toEqual([]);
  });
});

describe("extractText", () => {
  it("joins only text blocks, skipping thinking/tool_use", () => {
    const content = [
      { type: "thinking" },
      { type: "text", text: "Drafted 3. " },
      { type: "tool_use", id: "t1", name: "x", input: {} },
      { type: "text", text: "Review on Scheduling." },
    ];
    // Joined with no separator (each block already carries its own spacing),
    // then trimmed.
    expect(extractText(content)).toBe("Drafted 3. Review on Scheduling.");
  });

  it("is empty when nothing carries text", () => {
    expect(extractText([{ type: "tool_use", id: "t1", name: "x", input: {} }])).toBe("");
  });
});

describe("buildToolResultContent", () => {
  it("shapes ok and error results the same way except is_error", () => {
    expect(
      buildToolResultContent([
        { tool_use_id: "t1", content: "{\"ok\":true}" },
        { tool_use_id: "t2", content: "boom", is_error: true },
      ]),
    ).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "{\"ok\":true}" },
      { type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true },
    ]);
  });
});

describe("runToolLoop", () => {
  const textOnly = (text: string, usage = { inputTokens: 10, outputTokens: 5 }): ToolLoopResponse => ({
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage,
  });

  it("finishes in one round when the model never calls a tool", async () => {
    const send = vi.fn().mockResolvedValue(textOnly("Flashing goes on every window."));
    const executeTool = vi.fn();

    const result = await runToolLoop({
      initialMessages: [{ role: "user", content: "What is flashing?" }],
      send,
      executeTool,
    });

    expect(result).toEqual({
      text: "Flashing goes on every window.",
      toolCalls: [],
      rounds: 1,
      truncated: false,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("executes a tool, feeds the result back, and finishes on the next round", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "t1", name: "get_scheduling_picture", input: { from: "2026-09-01", to: "2026-09-05" } },
        ],
        stop_reason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 20 },
      })
      .mockResolvedValueOnce(textOnly("Here's the plan.", { inputTokens: 50, outputTokens: 30 }));
    const executeTool = vi.fn().mockResolvedValue({ content: "{\"jobs\":[]}" });

    const result = await runToolLoop({
      initialMessages: [{ role: "user", content: "Plan the week" }],
      send,
      executeTool,
    });

    expect(executeTool).toHaveBeenCalledWith("get_scheduling_picture", {
      from: "2026-09-01",
      to: "2026-09-05",
    });
    expect(result.text).toBe("Here's the plan.");
    expect(result.toolCalls).toEqual([
      { name: "get_scheduling_picture", input: { from: "2026-09-01", to: "2026-09-05" } },
    ]);
    expect(result.rounds).toBe(2);
    expect(result.truncated).toBe(false);
    // Usage accumulates across BOTH round trips, not just the last one.
    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 50 });

    // The second call's transcript carries the tool_result the executor
    // returned, addressed to the same id the model asked with.
    const secondCallMessages = send.mock.calls[1][0];
    expect(secondCallMessages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: '{"jobs":[]}' }],
    });
  });

  it("runs every tool call in one round before sending the next request", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "t1", name: "draft_assignments", input: { entries: [{ a: 1 }] } },
          { type: "tool_use", id: "t2", name: "draft_assignments", input: { entries: [{ a: 2 }] } },
        ],
        stop_reason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
      })
      .mockResolvedValueOnce(textOnly("Drafted both."));
    const executeTool = vi.fn().mockResolvedValue({ content: "ok" });

    const result = await runToolLoop({
      initialMessages: [{ role: "user", content: "go" }],
      send,
      executeTool,
    });

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toHaveLength(2);
  });

  it("carries an is_error tool_result through without special-casing it", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "t1", name: "draft_assignments", input: {} }],
        stop_reason: "tool_use",
        usage: {},
      })
      .mockResolvedValueOnce(textOnly("That didn't work — try again."));
    const executeTool = vi.fn().mockResolvedValue({ content: "double_booked", is_error: true });

    await runToolLoop({ initialMessages: [], send, executeTool });

    const secondCallMessages = send.mock.calls[1][0];
    expect(secondCallMessages.at(-1).content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "t1",
      content: "double_booked",
      is_error: true,
    });
  });

  it("stops at the round-trip ceiling rather than executing one more tool", async () => {
    const wantsAnotherTool: ToolLoopResponse = {
      content: [{ type: "tool_use", id: "t1", name: "draft_assignments", input: {} }],
      stop_reason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const send = vi.fn().mockResolvedValue(wantsAnotherTool);
    const executeTool = vi.fn().mockResolvedValue({ content: "ok" });

    const result = await runToolLoop({
      initialMessages: [{ role: "user", content: "go" }],
      send,
      executeTool,
      maxRounds: 3,
    });

    // 3 requests made (rounds 1, 2, 3); only rounds 1-2 execute their tools —
    // round 3 stops the loop instead of running a tool it can't get an answer
    // for, so executeTool is called twice, not three times.
    expect(send).toHaveBeenCalledTimes(3);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(result.rounds).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(""); // the 3rd reply carried only a tool_use block
  });

  it("defaults the ceiling to MAX_TOOL_ROUNDS (6) when maxRounds is omitted", async () => {
    const wantsAnotherTool: ToolLoopResponse = {
      content: [{ type: "tool_use", id: "t1", name: "draft_assignments", input: {} }],
      stop_reason: "tool_use",
    };
    const send = vi.fn().mockResolvedValue(wantsAnotherTool);
    const executeTool = vi.fn().mockResolvedValue({ content: "ok" });

    const result = await runToolLoop({ initialMessages: [], send, executeTool });

    expect(MAX_TOOL_ROUNDS).toBe(6);
    expect(send).toHaveBeenCalledTimes(6);
    expect(result.rounds).toBe(6);
    expect(result.truncated).toBe(true);
  });

  it("treats missing usage fields as zero rather than NaN", async () => {
    const send = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" });
    const result = await runToolLoop({
      initialMessages: [],
      send,
      executeTool: vi.fn(),
    });
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
