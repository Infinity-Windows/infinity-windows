import { describe, expect, it } from "vitest";
import { normalizeWord, rewritePhrases, stem, tokenize } from "./tokenize";
import { buildEntries } from "./entries";
import { buildIndex, hasAppIntent, searchBrain } from "./search";
import { bundledEntries } from "./entries";
import type { CatalogType } from "./types";

describe("tokenizing what an installer typed", () => {
  it("drops the words that carry no meaning", () => {
    expect(tokenize("Do I have to shim it?")).toEqual(["shim"]);
  });

  it("keeps the words that do, even the short ones", () => {
    expect(tokenize("caulk the bottom")).toContain("bottom");
    expect(tokenize("the opening is out of level")).toContain("out");
  });

  it("ties word endings together", () => {
    expect(stem("flashing")).toBe(stem("flash"));
    expect(stem("bracing")).toBe(stem("brace"));
    expect(stem("setting")).toBe(stem("set"));
    expect(stem("holes")).toBe(stem("hole"));
    // "glass" must not become "glas".
    expect(stem("glass")).toBe("glass");
  });

  it("folds the ways installers say the same thing", () => {
    expect(normalizeWord("caulk")).toBe(normalizeWord("sealant"));
    expect(normalizeWord("weep")).toBe(normalizeWord("drain"));
    expect(normalizeWord("drags")).toBe(normalizeWord("binds"));
    expect(normalizeWord("centre")).toBe(normalizeWord("center"));
    expect(normalizeWord("aluminium")).toBe(normalizeWord("aluminum"));
    expect(normalizeWord("tight")).toBe(normalizeWord("torque"));
  });

  it("keeps a size whole and splits it, so 72x48 finds Slider 72x48", () => {
    expect(tokenize("72×48 slider")).toEqual(
      expect.arrayContaining(["72x48", "72", "48", "slider"]),
    );
  });

  it("rewrites phrases that mean more than their words", () => {
    expect(rewritePhrases("how far back does it sit")).toContain("depth");
    expect(rewritePhrases("do I need a second man")).toContain("person");
  });
});

const SAMPLE: CatalogType[] = [
  {
    c: "SH3252",
    n: "Single-Hung 32x52",
    cat: "single-hung",
    w: 32,
    h: 52,
    d: 1,
    t: [
      "Find the drain slots on the bottom of the frame - that side faces OUT.",
      "Caulk the flanges left, right and top only - leave the bottom open to drain.",
    ],
    x: ["Confirm stucco vs rock before setting depth - ~1 in (rock) vs ~1.5 in (stucco)."],
  },
  { c: "AWN2418", n: "Awning 24x18", cat: "awning", w: 24, h: 18, d: 2 },
];

describe("what gets indexed", () => {
  const entries = buildEntries(SAMPLE);

  it("makes every tip and watch-out its own answer, cited to its type", () => {
    const tip = entries.find((e) => e.id === "tip:SH3252:0");
    expect(tip?.source).toBe("SH3252 · Single-Hung 32x52");
    expect(entries.filter((e) => e.kind === "tip")).toHaveLength(2);
    expect(entries.filter((e) => e.kind === "watch-out")).toHaveLength(1);
  });

  it("shows a type's tips on its card but does not index them there", () => {
    const card = entries.find((e) => e.id === "type:SH3252")!;
    expect(card.body).toContain("drain slots");
    expect(card.indexBody).not.toContain("drain slots");
  });

  it("says so plainly when a type has nothing written for it", () => {
    const card = entries.find((e) => e.id === "type:AWN2418")!;
    expect(card.body).toContain("No install tips saved for this type yet");
  });

  it("bundles the whole brain: 105 terms, 18 steps, 88 tip lines, 102 types", () => {
    const all = bundledEntries();
    const count = (kind: string) => all.filter((e) => e.kind === kind).length;
    expect(count("glossary")).toBe(105);
    expect(count("procedure")).toBe(18);
    expect(count("tip") + count("watch-out")).toBe(88);
    expect(count("type")).toBe(102);
    expect(count("app")).toBe(1);
  });
});

describe("searching", () => {
  const index = buildIndex(buildEntries(SAMPLE));

  it("finds a type by name, not just by exact code — the bug this replaces", () => {
    const ids = searchBrain(index, "single hung tips").hits.map((h) => h.entry.id);
    expect(ids[0]).toBe("type:SH3252");
  });

  it("still finds a type by its code", () => {
    const ids = searchBrain(index, "SH3252").hits.map((h) => h.entry.id);
    expect(ids[0]).toBe("type:SH3252");
  });

  it("returns at most three answers", () => {
    expect(searchBrain(index, "caulk the bottom drain").hits.length).toBeLessThanOrEqual(3);
  });

  it("gives one answer per window type, so three results are three options", () => {
    const hits = searchBrain(index, "drain stucco caulk").hits;
    const groups = hits.map((h) => h.entry.id.split(":")[1]);
    expect(new Set(groups).size).toBe(groups.length);
  });

  it("stays quiet rather than guessing on a question with no answer", () => {
    const result = searchBrain(index, "what did the inspector want on Tuesday");
    expect(result.miss).toBe(true);
    expect(result.hits).toEqual([]);
  });

  it("needs more than one matching word to answer", () => {
    // "stucco" alone appears in the watch-out; one rare word is not an answer.
    expect(searchBrain(index, "stucco pricing invoice terms").hits).toEqual([]);
  });

  it("cites where each answer came from", () => {
    for (const hit of searchBrain(index, "which side does the drain face").hits) {
      expect(hit.entry.source).toBeTruthy();
      expect(hit.entry.title).toBeTruthy();
    }
  });
});

describe("app intent", () => {
  it("recognises a question about the app", () => {
    expect(hasAppIntent("which tab do I clock in on?")).toBe(true);
    expect(hasAppIntent("how do I scan a unit?")).toBe(true);
  });

  it("does not mistake an install question for one", () => {
    expect(hasAppIntent("do I caulk the bottom of the window?")).toBe(false);
    expect(hasAppIntent("what order do I flash?")).toBe(false);
    expect(hasAppIntent("how do I brace a bay?")).toBe(false);
  });
});
