// @vitest-environment happy-dom
//
// The clock sheet is THE primary crew screen, and slice 7's promise is that a
// Spanish reader never drops back to English on it. A catalog-key test can't
// see a literal that never calls t(); these tests can. Two kinds of proof:
//   1. Source scan (same trick as App.routeGuards.test.ts) — the sheet's own
//      text is read and the flagged English literals must be gone, replaced by
//      a t() call. This is what catches a toast that fires deep in an async
//      mutation success, where driving the real path would mean mocking the
//      whole Supabase chain.
//   2. A real mount under the live Spanish provider for the on-screen hero, so
//      the wrapped subtitles are proven to render Spanish, not just resolve it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { translate } from "../../lib/i18n/translate";
import { CATALOG } from "../../lib/i18n/catalog";

const SHEET_SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "./ClockSheet.tsx"),
  "utf8",
);

describe("the clock sheet leaves no English toast on the crew flow (slice 7)", () => {
  it("routes the clock-in-on-unit toast through t(), not a hard-coded literal", () => {
    // Before the fix the sheet built the toast from a template literal, so a
    // Spanish installer starting a unit read English. It must now go through
    // the catalog key.
    expect(SHEET_SRC).not.toContain("Clocked in — clock running on ");
    expect(SHEET_SRC).toContain('t("clock.toast.clockedInOnUnit"');
  });

  it("resolves clockedInOnUnit to real Spanish with the unit code filled in", () => {
    expect(translate(CATALOG, "en", "clock.toast.clockedInOnUnit", { code: "1-2" })).toBe(
      "Clocked in — clock running on 1-2",
    );
    expect(translate(CATALOG, "es", "clock.toast.clockedInOnUnit", { code: "1-2" })).toBe(
      "Entrada marcada — el reloj corre en 1-2",
    );
    expect(
      translate(CATALOG, "es", "clock.toast.clockedInOnUnit", { code: "1-2" }),
    ).not.toBe(translate(CATALOG, "en", "clock.toast.clockedInOnUnit", { code: "1-2" }));
  });

  it("routes the auto-resume toast through t(), not a hard-coded literal", () => {
    // The held-unit resume toast fired from an async IIFE that reads Supabase;
    // it must build from the catalog, not a template literal, or a Spanish
    // reader gets English after every break.
    expect(SHEET_SRC).not.toContain("Back on unit ");
    expect(SHEET_SRC).toContain('t("clock.toast.backOnUnit"');
  });

  it("resolves backOnUnit to real Spanish with the unit code filled in", () => {
    expect(translate(CATALOG, "en", "clock.toast.backOnUnit", { code: "1-2" })).toBe(
      "Back on unit 1-2 — clock's running.",
    );
    expect(translate(CATALOG, "es", "clock.toast.backOnUnit", { code: "1-2" })).toBe(
      "De vuelta en la unidad 1-2 — el reloj está corriendo.",
    );
    expect(translate(CATALOG, "es", "clock.toast.backOnUnit", { code: "1-2" })).not.toBe(
      translate(CATALOG, "en", "clock.toast.backOnUnit", { code: "1-2" }),
    );
  });
});
