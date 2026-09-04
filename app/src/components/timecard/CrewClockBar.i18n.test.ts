// Every string the roster's bulk clock puts on screen speaks Spanish too.
//
// A source scan, for the same reason TeamTimecards.i18n.test.ts is one: the
// alternative is mounting a supervisor-only page that fetches the roster, the
// projects, the cost codes, the overtime rules and the company settings, to
// read a handful of button labels. What this has to catch is fresh English
// literals sitting ten lines from a t() call — the exact way the range stepper
// and the Gusto button went out untranslated.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG, SAFETY_KEYS } from "../../lib/i18n/catalog";
import { translate } from "../../lib/i18n/translate";

const here = dirname(fileURLToPath(import.meta.url));
const BAR = readFileSync(resolve(here, "./CrewClockBar.tsx"), "utf8");
const PAGE = readFileSync(resolve(here, "../../pages/TeamTimecards.tsx"), "utf8");

const KEYS = Object.keys(CATALOG).filter((k) => k.startsWith("crewclock."));

describe("the roster's bulk clock is fully translated", () => {
  it("has a key for every part of the flow", () => {
    // A floor, not an exact count: adding copy should not break this test, but
    // deleting the block wholesale should.
    expect(KEYS.length).toBeGreaterThanOrEqual(25);
  });

  it("resolves each one to real Spanish, not the English fallback", () => {
    for (const key of KEYS) {
      const en = translate(CATALOG, "en", key);
      const es = translate(CATALOG, "es", key);
      expect(en, `en for ${key}`).not.toBe("");
      expect(es, `es for ${key}`).not.toBe("");
      expect(es, `${key} is still English`).not.toBe(en);
    }
  });

  it("leaves no English literal behind in the bar or the roster", () => {
    for (const literal of [
      '"Select all"',
      '"Select everyone on the clock"',
      '"Clock in…"',
      '"Clock out…"',
      '"I gave today\'s toolbox talk',
      '"Move anyone already on another job here"',
      '"Clock them in"',
      '"Clock them out"',
    ]) {
      expect(BAR).not.toContain(literal);
      expect(PAGE).not.toContain(literal);
    }
  });

  it("calls t() for the bar's own buttons and the row checkboxes", () => {
    for (const key of [
      "crewclock.bar.clockIn",
      "crewclock.bar.clockOut",
      "crewclock.in.go",
      "crewclock.out.go",
    ]) {
      expect(BAR).toContain(`t("${key}")`);
    }
    // The two counted ones carry their number, so match the call, not the
    // whole expression.
    for (const key of ["crewclock.select.all", "crewclock.select.onClock"]) {
      expect(PAGE).toContain(`t("${key}", { n:`);
    }
    expect(PAGE).toContain('t("crewclock.select.clear")');
  });

  // Every counted string is a .one/.many pair, because "Clock in 1 people" is
  // not English and "1 seleccionados" is not Spanish (2026-09-04 review). The
  // framework has no plural rule — the caller picks the key by count — so the
  // pair has to exist and the bar has to branch on it.
  it("ships a singular for every counted string, and picks it by count", () => {
    for (const stem of [
      "crewclock.bar.count",
      "crewclock.in.title",
      "crewclock.out.title",
      "crewclock.out.body",
      "crewclock.in.moveOff",
    ]) {
      expect(CATALOG, `${stem}.one`).toHaveProperty(`${stem}.one`);
      expect(CATALOG, `${stem}.many`).toHaveProperty(`${stem}.many`);
      // …and the un-suffixed key is gone, so nothing can quietly go back to it.
      expect(Object.keys(CATALOG)).not.toContain(stem);
      expect(BAR).toContain(`${stem}.one`);
      expect(BAR, `${stem}.many is used`).toContain(`${stem}.many`);
    }
    expect(translate(CATALOG, "en", "crewclock.in.title.one", { n: 1 })).toBe(
      "Clock in 1 person",
    );
    expect(translate(CATALOG, "es", "crewclock.bar.count.one", { n: 1 })).toBe(
      "1 seleccionado",
    );
  });

  // Somebody held back from the request still gets a line in the answer.
  it("has copy for the people the sheet never sent", () => {
    expect(translate(CATALOG, "en", "crewclock.outcome.skipped")).toBe(
      "Left on their other job",
    );
    expect(translate(CATALOG, "es", "crewclock.outcome.skipped")).toBe(
      "Se quedó en su otro trabajo",
    );
    expect(BAR).toContain("crewclock.outcome.skipped");
  });

  // The attestation is the one claim in this feature that stands in for a
  // signature. It is flagged for the same bilingual review every other safety
  // string carries.
  it("flags the toolbox attestation as a SAFETY key", () => {
    expect(SAFETY_KEYS as readonly string[]).toContain("crewclock.in.attest");
    expect(SAFETY_KEYS as readonly string[]).toContain("crewclock.in.attestHelp");
  });
});
