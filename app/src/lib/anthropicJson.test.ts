import { describe, expect, it } from "vitest";
import {
  alignToSchema,
  buildJsonToolRequest,
  JSON_TOOL_NAME,
  missingRequiredKeys,
  parseJsonLoose,
  readJsonFromContent,
  toStringList,
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

  it("keeps the whole answer when it arrives across several tool calls", () => {
    // The live failure this fixes: a talk's title, intro and hazards came back in
    // one call and its steps, do's and don'ts in another, and taking only the
    // first threw half the talk away.
    expect(
      readJsonFromContent([
        { type: "tool_use", name: JSON_TOOL_NAME, input: { title: "t", intro: "i" } },
        { type: "tool_use", name: JSON_TOOL_NAME, input: { steps: ["a"], dos: ["b"] } },
      ]),
    ).toEqual({ title: "t", intro: "i", steps: ["a"], dos: ["b"] });
  });

  it("lets the first answer stand when a later call contradicts it", () => {
    // A model adding to its answer is normal; a model rewriting it mid-reply is
    // not, and the first version is the one it committed to.
    expect(
      readJsonFromContent([
        { type: "tool_use", name: JSON_TOOL_NAME, input: { steps: ["real"] } },
        { type: "tool_use", name: JSON_TOOL_NAME, input: { steps: [] } },
      ]),
    ).toEqual({ steps: ["real"] });
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

describe("alignToSchema", () => {
  const TALK = {
    type: "object",
    required: ["title", "intro", "key_hazards", "steps", "dos", "donts"],
  };

  it("accepts hazards answered under a near-miss name", () => {
    // A full set of hazards is not worth throwing away over an underscore.
    expect(
      alignToSchema(TALK, { title: "t", hazards: ["falls", "glass"] }),
    ).toEqual({ title: "t", key_hazards: ["falls", "glass"] });
  });

  it("accepts a longer name for a shorter field", () => {
    expect(alignToSchema(TALK, { next_steps: ["a"] })).toEqual({ steps: ["a"] });
  });

  it("never overwrites a field the model got right", () => {
    expect(
      alignToSchema(TALK, { key_hazards: ["right"], hazards: ["wrong"] }),
    ).toEqual({ key_hazards: ["right"], hazards: ["wrong"] });
  });

  it("does not let two short fields be mistaken for each other", () => {
    // "dos" is a tail of "donts" by letters alone. Answering one with the other
    // would be worse than failing, so the minimum length forbids it.
    expect(alignToSchema(TALK, { donts: ["never free-hand it"] })).toEqual({
      donts: ["never free-hand it"],
    });
  });

  it("leaves an answer that needs no help exactly as it is", () => {
    const answer = { rows: [{ qty: 2 }] };
    expect(alignToSchema({ type: "object", required: ["rows"] }, answer)).toEqual(
      answer,
    );
  });

  it("does nothing when the schema requires nothing", () => {
    expect(alignToSchema({ type: "object" }, { anything: 1 })).toEqual({
      anything: 1,
    });
  });
});

describe("toStringList", () => {
  // Live failure: a talk's hazards, steps, do's and don'ts all rendered empty
  // while its title and intro were fine. Whatever the lists arrived as, the
  // reader did not recognise it, and an unrecognised list quietly became none.
  it("reads a real list of strings unchanged", () => {
    expect(toStringList(["shim the sill", "check for plumb"])).toEqual([
      "shim the sill",
      "check for plumb",
    ]);
  });

  it("reads a list the model wrote as one bulleted string", () => {
    expect(toStringList("- shim the sill\n- check for plumb")).toEqual([
      "shim the sill",
      "check for plumb",
    ]);
  });

  it("reads a numbered list written as one string", () => {
    expect(toStringList("1. Dry-fit the unit\n2) Shim the sill")).toEqual([
      "Dry-fit the unit",
      "Shim the sill",
    ]);
  });

  it("treats a single sentence as a list of one", () => {
    expect(toStringList("Mind the glass edges.")).toEqual([
      "Mind the glass edges.",
    ]);
  });

  it("leaves a measurement at the start of a real list item alone", () => {
    // The bullet-stripping must not eat content. "3/4" is a size, not a number
    // in a numbered list, and a hazard that loses it is worse than useless.
    expect(toStringList(["3/4 inch shims can walk out under load"])).toEqual([
      "3/4 inch shims can walk out under load",
    ]);
  });

  it("drops blank lines and blank entries rather than rendering gaps", () => {
    expect(toStringList(["a", "", "  ", "b"])).toEqual(["a", "b"]);
    expect(toStringList("a\n\n\nb")).toEqual(["a", "b"]);
  });

  it("returns nothing for an answer that really has nothing", () => {
    expect(toStringList(undefined)).toEqual([]);
    expect(toStringList(null)).toEqual([]);
    expect(toStringList("")).toEqual([]);
    expect(toStringList(42)).toEqual([]);
  });
});

describe("missingRequiredKeys", () => {
  // The failure this is for, from a live run: a toolbox talk came back with a
  // title and an opening paragraph and no hazards, no steps, no do's, no
  // don'ts. It saved. It looked like a talk in the list. Its entire body was
  // missing, and nothing threw, because every field the code went looking for
  // was `undefined` and `undefined` tidies up into an empty list.
  const TALK = {
    type: "object",
    required: ["title", "intro", "key_hazards", "steps"],
  };

  it("names the fields a half-finished answer never got to", () => {
    expect(
      missingRequiredKeys(TALK, {
        title: "Ladder safety",
        intro: "Working off a ladder with a window in your hands...",
      }),
    ).toEqual(["key_hazards", "steps"]);
  });

  it("passes an answer that has everything", () => {
    expect(
      missingRequiredKeys(TALK, {
        title: "t",
        intro: "i",
        key_hazards: ["a"],
        steps: ["b"],
      }),
    ).toEqual([]);
  });

  it("treats an empty list as a real answer, because sometimes it is", () => {
    // A planset with no openings in it is a true result, not a broken one.
    expect(
      missingRequiredKeys({ type: "object", required: ["rows"] }, { rows: [] }),
    ).toEqual([]);
  });

  it("counts a null as missing, since callers cannot read it either", () => {
    expect(
      missingRequiredKeys({ type: "object", required: ["rows"] }, { rows: null }),
    ).toEqual(["rows"]);
  });

  it("says nothing when the schema requires nothing", () => {
    expect(missingRequiredKeys({ type: "object" }, {})).toEqual([]);
    expect(missingRequiredKeys({ required: "not a list" }, {})).toEqual([]);
  });

  it("reports every required field when the answer is not an object at all", () => {
    expect(missingRequiredKeys(TALK, null)).toEqual([
      "title",
      "intro",
      "key_hazards",
      "steps",
    ]);
    expect(missingRequiredKeys(TALK, ["nope"])).toHaveLength(4);
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
