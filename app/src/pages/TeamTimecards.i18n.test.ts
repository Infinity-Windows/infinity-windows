// The strings Wave K wrote onto Team timecards speak Spanish too.
//
// The page as a whole is older English and stays that way for now — that is a
// deliberate deviation, not an oversight. What is NOT allowed is a wave adding
// fresh English beside its own translated strings, which is what the range
// stepper and the Gusto button were: hard-coded literals ten lines from a
// t("nudge.label") call.
//
// A source scan is the right tool here. The alternative is mounting a
// foreman-only page that fetches the roster, the projects, the cost codes, the
// overtime rules and the company settings, to read two button labels.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG } from "../lib/i18n/catalog";
import { translate } from "../lib/i18n/translate";

const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "./TeamTimecards.tsx"),
  "utf8",
);

const K5_KEYS = [
  "tcx.range.week",
  "tcx.range.pay",
  "tcx.range.aria",
  "tcx.range.prev",
  "tcx.range.next",
  "tcx.range.backToNow",
  "tcx.export.gusto",
  "tcx.export.gustoHint",
] as const;

describe("the range stepper and Gusto export are not hard-coded English", () => {
  it("has no literal left behind for any of them", () => {
    for (const literal of [
      '"Week"',
      '"Pay period"',
      'aria-label="Previous"',
      'aria-label="Next"',
      'title="Jump back to now"',
      "Export pay period for Gusto",
      "Switch to Pay period to export for Gusto.",
    ]) {
      expect(SRC).not.toContain(literal);
    }
  });

  it("calls t() for every one of them", () => {
    for (const key of K5_KEYS) expect(SRC).toContain(`t("${key}")`);
  });

  it("resolves each one to real Spanish, not the English fallback", () => {
    for (const key of K5_KEYS) {
      const en = translate(CATALOG, "en", key);
      const es = translate(CATALOG, "es", key);
      expect(en).not.toBe("");
      expect(es).not.toBe("");
      expect(es).not.toBe(en);
    }
  });
});
