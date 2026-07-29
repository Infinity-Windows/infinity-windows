import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The fields the AI is asked for must be the fields the app reads back.
 *
 * This exists because of a real, live failure. A toolbox talk generated on the
 * production project saved with a good title, a good opening paragraph, and no
 * hazards, no steps, no do's and no don'ts. It appeared in the Safety list like
 * any other talk, and a crew member would have been asked to read and sign an
 * empty one before clocking in. Nothing threw, because every field the code went
 * looking for was simply absent, and an absent list tidies up into an empty one.
 *
 * The old provider had a setting that guaranteed a machine-readable answer, and
 * it was doing more work than it looked like. The replacement pins the shape with
 * Anthropic tool use, whose input schema names the fields — but a schema only
 * helps if it names the SAME fields the reader wants, so that correspondence is
 * asserted here rather than assumed.
 *
 * Two of these features cannot be exercised live yet — no window type has a
 * reference install recorded, and no install memos exist — so a real run cannot
 * prove them. That is exactly why their shape is pinned in a test that needs no
 * data: "untested" is not "working", and the first person to find out must not be
 * an installer on a roof.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** The keys named in a `required: [...]` list in a source file. */
const requiredKeys = (src: string, schemaName: string): string[] => {
  const from = src.indexOf(`const ${schemaName}`);
  expect(from, `${schemaName} should exist`).toBeGreaterThan(-1);
  const decl = src.slice(from, src.indexOf("\n};", from));
  // The LAST required list in the declaration is the top-level one; a nested
  // item schema (how-to steps) declares its own earlier.
  const lists = [...decl.matchAll(/required:\s*\[([^\]]*)\]/g)];
  const last = lists[lists.length - 1];
  expect(last, `${schemaName} should pin its fields with a required list`).toBeTruthy();
  return [...last[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

describe("toolbox talks: asked for what the Safety screen renders", () => {
  const fn = read("supabase/functions/generate-toolbox-talk/index.ts");
  const consumer = read("app/src/lib/ops.ts");

  it("pins every section the app knows how to show", () => {
    // Taken from the consumer, not from the prompt: `TalkSections` is what the
    // Safety screen, the printable talk and the sign-off sheet all read.
    const sections = [...consumer.matchAll(/^\s{2}(\w+)\?:/gm)]
      .map((m) => m[1])
      .filter((k) =>
        ["intro", "key_hazards", "steps", "dos", "donts"].includes(k),
      );
    expect(sections).toHaveLength(5);
    for (const key of sections) {
      expect(requiredKeys(fn, "TALK_SCHEMA"), key).toContain(key);
    }
  });

  it("refuses to save a talk with no hazards and no steps", () => {
    // Stricter than the app's own emptiness test, which an intro alone passes —
    // and an intro alone is exactly what came back on the live project.
    expect(fn).toContain(
      "!sections.key_hazards.length && !sections.steps.length",
    );
    expect(fn).toContain("nothing was saved");
  });

  it("reads a section the model wrote as prose rather than dropping it", () => {
    expect(fn).toContain("toStringList");
  });
});

describe("how-to guides: asked for what the type card renders", () => {
  const fn = read("supabase/functions/generate-howto/index.ts");

  it("pins the step fields the card reads", () => {
    // app/src/lib/brain/catalogCache.ts reads `{ title, detail }` per step.
    expect(read("app/src/lib/brain/catalogCache.ts")).toContain(
      "howto_json: Array<{ title?: string; detail?: string }> | null",
    );
    expect(requiredKeys(fn, "HOWTO_SCHEMA")).toEqual(["steps"]);
    expect(fn).toMatch(/required:\s*\["title",\s*"detail"\]/);
  });

  it("keeps a step the model wrote as a bare sentence", () => {
    expect(fn).toContain('typeof s === "string"');
  });

  it("refuses to blank an existing guide with a stepless answer", () => {
    // `howto_json` is replaced outright, so saving an empty answer would delete
    // a working guide and report success.
    expect(fn).toContain("steps.length === 0");
    expect(fn).toContain("nothing was saved");
  });
});

describe("window-type tips: asked for what the catalog stores", () => {
  const fn = read("supabase/functions/synthesize-type-tips/index.ts");

  it("pins the three fields it writes", () => {
    expect(requiredKeys(fn, "TIPS_SCHEMA")).toEqual([
      "tips",
      "watch_outs",
      "outcome_difficulty",
    ]);
  });

  it("reads tips the model wrote as prose rather than dropping them", () => {
    expect(fn).toContain("toStringList(synthesis.tips)");
  });

  it("keeps the tips it already has rather than overwriting them with nothing", () => {
    // The worst version of this bug: tips are written over the top, so an empty
    // answer would destroy what previous installs taught the crew.
    expect(fn).toContain("tips.length === 0");
    expect(fn).toContain("the existing ones were kept");
  });
});

describe("every strict-JSON answer is checked before it is trusted", () => {
  const helper = read("supabase/functions/_shared/anthropic.ts");

  it("refuses an answer missing any field the schema requires", () => {
    expect(helper).toContain("missingRequiredKeys(opts.schema, answer)");
    expect(helper).toContain("Anthropic answer is incomplete");
  });

  it("accepts a field that came back under a near-miss name", () => {
    expect(helper).toContain("alignToSchema(opts.schema");
  });

  it("names what the model did send, so the next fix needs no guessing", () => {
    // The first live failure cost a deploy cycle precisely because the log said
    // what was missing and not what had arrived instead.
    expect(helper).toContain("it sent");
  });

  it("says when the answer was cut short, since that reads as a code bug", () => {
    expect(helper).toContain("max_tokens");
    expect(helper).toContain("cut off");
  });

  it("leaves room for a full answer", () => {
    // 4096 was not enough for a toolbox talk. Only tokens actually generated are
    // billed, so headroom is free.
    expect(helper).toMatch(/maxTokens \?\? 8192/);
  });
});
