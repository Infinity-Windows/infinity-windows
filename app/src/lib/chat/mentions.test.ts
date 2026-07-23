import { describe, expect, it } from "vitest";
import {
  parseMentionTokens,
  resolveMentions,
  splitMentionSegments,
} from "./mentions";

const roster = [
  { id: "taylor", display_name: "Taylor" },
  { id: "ammon", display_name: "Ammon Barlow" },
  { id: "jose", display_name: "José Ruiz" },
  { id: "taylor2", display_name: "Taylor Smith" },
  { id: "chris1", display_name: "Chris Lee" },
  { id: "chris2", display_name: "Chris Ray" },
];

describe("parseMentionTokens", () => {
  it("captures the leading word and an optional second word", () => {
    expect(parseMentionTokens("hey @Taylor and @Ammon Barlow")).toEqual([
      { word1: "Taylor", word2: "and" },
      { word1: "Ammon", word2: "Barlow" },
    ]);
  });

  it("stops the token at punctuation (no second word across a comma)", () => {
    expect(parseMentionTokens("@Taylor, you there?")).toEqual([
      { word1: "Taylor", word2: null },
    ]);
  });

  it("returns nothing when there are no mentions", () => {
    expect(parseMentionTokens("no mentions here")).toEqual([]);
  });
});

describe("resolveMentions", () => {
  it("resolves a first-name mention case-insensitively", () => {
    expect(resolveMentions("hey @taylor", roster)).toContain("taylor");
  });

  it("prefers a full 'First Last' match over a bare first name", () => {
    expect(resolveMentions("ping @Ammon Barlow please", roster)).toEqual([
      "ammon",
    ]);
  });

  it("resolves an exact single-word name to just that person", () => {
    // "Taylor" is itself a complete display name, so it maps to that one person
    // (not every Taylor) — the two-word pair "Taylor can" isn't a real name.
    expect(resolveMentions("@Taylor can you check this", roster)).toEqual([
      "taylor",
    ]);
  });

  it("falls back to a shared first name when it is not a full name", () => {
    // "Chris" isn't a standalone display name, so both Chrises are notified
    // (forgiving on purpose).
    const ids = resolveMentions("@Chris can you help", roster);
    expect(ids).toContain("chris1");
    expect(ids).toContain("chris2");
  });

  it("handles multiple mentions and de-dupes", () => {
    const ids = resolveMentions("@Ammon @Ammon @José", roster);
    expect(ids).toEqual(["ammon", "jose"]);
  });

  it("returns nothing for an unknown name or empty body", () => {
    expect(resolveMentions("@Nobody here", roster)).toEqual([]);
    expect(resolveMentions("", roster)).toEqual([]);
  });

  it("strips punctuation before matching a name", () => {
    expect(resolveMentions("thanks @Taylor!", roster)).toContain("taylor");
  });
});

describe("splitMentionSegments", () => {
  it("marks a full-name mention and leaves surrounding text plain", () => {
    const segs = splitMentionSegments("ping @Ammon Barlow now", roster);
    expect(segs).toEqual([
      { text: "ping ", mentionId: null },
      { text: "@Ammon Barlow", mentionId: "ammon" },
      { text: " now", mentionId: null },
    ]);
  });

  it("only highlights the resolved word when the pair is not a full name", () => {
    const segs = splitMentionSegments("@Taylor can you look", roster);
    expect(segs[0]).toEqual({ text: "@Taylor", mentionId: "taylor" });
    expect(segs[1].mentionId).toBeNull();
    expect(segs[1].text.startsWith(" can")).toBe(true);
  });

  it("leaves an unknown @name as plain text", () => {
    const segs = splitMentionSegments("hi @Nobody", roster);
    expect(segs.every((s) => s.mentionId === null)).toBe(true);
    expect(segs.map((s) => s.text).join("")).toBe("hi @Nobody");
  });

  it("round-trips the original text", () => {
    const body = "hey @taylor and @Ammon Barlow, thanks!";
    const segs = splitMentionSegments(body, roster);
    expect(segs.map((s) => s.text).join("")).toBe(body);
  });
});
