import { describe, expect, it } from "vitest";
import {
  buildJsonToolRequest,
  JSON_TOOL_NAME,
  parseJsonLoose,
  readJsonFromContent,
} from "../../../supabase/functions/_shared/anthropicJson.ts";

// This module is the whole reason moving text generation to Claude is safe.
// OpenAI guaranteed parseable JSON with `response_format: {type:
// "json_object"}`; Anthropic has no such flag, so the guarantee is rebuilt out
// of forced tool use plus a tolerant text fallback. Every case below is one that
// would otherwise write a broken answer into the database.

describe("buildJsonToolRequest", () => {
  const opts = {
    model: "claude-sonnet-5",
    maxTokens: 4096,
    system: "You extract schedule rows.",
    schemaHint: 'Schema: { "rows": [] }',
    schema: { type: "object", properties: { rows: { type: "array" } } },
    messages: [{ role: "user" as const, content: "planset text" }],
  };

  it("never sends temperature, which claude-sonnet-5 rejects with a 400", () => {
    // Not a style preference: sending it took a live feature down once.
    expect(buildJsonToolRequest(opts)).not.toHaveProperty("temperature");
  });

  it("forces the JSON tool rather than merely offering it", () => {
    const body = buildJsonToolRequest(opts);
    expect(body.tool_choice).toEqual({ type: "tool", name: JSON_TOOL_NAME });
    expect(body.tools).toHaveLength(1);
  });

  it("passes the caller's schema through as the tool's input schema", () => {
    const body = buildJsonToolRequest(opts) as {
      tools: { name: string; input_schema: unknown }[];
    };
    expect(body.tools[0].name).toBe(JSON_TOOL_NAME);
    expect(body.tools[0].input_schema).toBe(opts.schema);
  });

  it("keeps the caller's system prompt and adds the JSON-only instruction", () => {
    const body = buildJsonToolRequest(opts) as { system: string };
    expect(body.system).toContain("You extract schedule rows.");
    expect(body.system).toContain(JSON_TOOL_NAME);
    expect(body.system).toContain('Schema: { "rows": [] }');
  });

  it("sends the model and token ceiling it was given", () => {
    const body = buildJsonToolRequest(opts);
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toBe(opts.messages);
  });
});

describe("readJsonFromContent", () => {
  it("reads the tool call's already-parsed input", () => {
    expect(
      readJsonFromContent([
        { type: "tool_use", name: JSON_TOOL_NAME, input: { steps: ["a"] } },
      ]),
    ).toEqual({ steps: ["a"] });
  });

  it("survives a thinking block that carries no text field at all", () => {
    // The exact production bug: filtering on `.text` across every block yielded
    // "" here, and "" does not parse. The tool input is immune to it.
    expect(
      readJsonFromContent([
        { type: "thinking" },
        { type: "tool_use", name: JSON_TOOL_NAME, input: { rows: [] } },
      ]),
    ).toEqual({ rows: [] });
  });

  it("ignores a text-less thinking block on the text fallback path too", () => {
    expect(
      readJsonFromContent([
        { type: "thinking" },
        { type: "text", text: '{"tips":["pre-drill the hinge side"]}' },
      ]),
    ).toEqual({ tips: ["pre-drill the hinge side"] });
  });

  it("accepts a tool call under an unexpected name rather than losing it", () => {
    expect(
      readJsonFromContent([{ type: "tool_use", name: "json", input: { a: 1 } }]),
    ).toEqual({ a: 1 });
  });

  it("prefers the configured tool when several tool calls came back", () => {
    expect(
      readJsonFromContent([
        { type: "tool_use", name: "something_else", input: { wrong: true } },
        { type: "tool_use", name: JSON_TOOL_NAME, input: { right: true } },
      ]),
    ).toEqual({ right: true });
  });

  it("falls back to text when the model ignored the tool", () => {
    expect(
      readJsonFromContent([{ type: "text", text: '{"title":"Ladder safety"}' }]),
    ).toEqual({ title: "Ladder safety" });
  });

  it("unwraps a markdown fence in the text fallback", () => {
    expect(
      readJsonFromContent([
        { type: "text", text: '```json\n{"steps":[{"title":"Dry-fit"}]}\n```' },
      ]),
    ).toEqual({ steps: [{ title: "Dry-fit" }] });
  });

  it("digs the object out from behind a chatty preamble", () => {
    expect(
      readJsonFromContent([
        { type: "text", text: 'Sure! Here you go:\n{"rows":[{"qty":3}]}' },
      ]),
    ).toEqual({ rows: [{ qty: 3 }] });
  });

  it("returns null for content with nothing usable in it, so callers can throw", () => {
    expect(readJsonFromContent([{ type: "text", text: "I can't help." }])).toBeNull();
    expect(readJsonFromContent([{ type: "thinking" }])).toBeNull();
    expect(readJsonFromContent([])).toBeNull();
    expect(readJsonFromContent(undefined)).toBeNull();
  });

  it("ignores a tool call whose input is not an object", () => {
    // An array or a bare string is not the answer shape any caller expects, and
    // silently passing it on would break the destructuring downstream.
    expect(
      readJsonFromContent([
        { type: "tool_use", name: JSON_TOOL_NAME, input: ["nope"] },
      ]),
    ).toBeNull();
  });
});

describe("parseJsonLoose", () => {
  it("parses clean JSON", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns null on an empty string instead of throwing", () => {
    expect(parseJsonLoose("")).toBeNull();
  });

  it("returns null when there is no object to find", () => {
    expect(parseJsonLoose("no json here")).toBeNull();
  });

  it("keeps the outermost object when one is nested inside another", () => {
    expect(parseJsonLoose('{"outer":{"inner":2}}')).toEqual({
      outer: { inner: 2 },
    });
  });
});
