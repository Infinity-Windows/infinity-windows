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
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translate } from "../../lib/i18n/translate";
import { CATALOG } from "../../lib/i18n/catalog";
import { LanguageProvider } from "../../lib/i18n";
import { ClockSheet } from "./ClockSheet";
import type { TimeShift } from "../../lib/timeclock";

// The on-the-clock hero mounts WrongClockBanner, which fetches the server's
// clock from a mount effect. Hold that still (skew 0 → banner renders nothing)
// so the render test never reaches for the network; every ClockSheet query is
// seeded below.
vi.mock("../../lib/clockSkew", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/clockSkew")>();
  return { ...actual, fetchServerNowMs: vi.fn(async () => Date.now()) };
});

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

  it("routes the hero subtitles and the job-search empty state through t()", () => {
    // The clock hero read 'Worked so far' / 'Breaks today' and the picker's
    // empty state read 'No jobs match …' in English, none gated on job mode —
    // so a Spanish crew member saw them on the standard clock screen too.
    expect(SHEET_SRC).not.toContain("Worked so far ");
    expect(SHEET_SRC).not.toContain("Breaks today ");
    expect(SHEET_SRC).not.toContain("No jobs match");
    expect(SHEET_SRC).toContain('t("clock.hero.workedSoFar")');
    expect(SHEET_SRC).toContain('t("clock.hero.breaksToday")');
    expect(SHEET_SRC).toContain('t("clock.search.noJobs", { q: search })');
  });
});

// The gold-standard proof for the hero: mount the sheet FOR REAL under the live
// Spanish provider and read the rendered card, so the wrapped subtitles are
// shown to put Spanish on screen — not merely resolve a key in a helper.
describe("the on-the-clock hero renders Spanish (slice 7)", () => {
  let container: HTMLElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function baseShift(): TimeShift {
    return {
      id: "s1",
      profile_id: "me",
      project_id: "p1",
      cost_code_id: "cc1",
      // An hour in — well under the shift cap, so the normal hero (not the
      // "clock stopped" card) renders.
      clock_in_at: new Date(Date.now() - 3600_000).toISOString(),
      clock_out_at: null,
      break_seconds: 0,
      break_started_at: null,
      break_type: null,
      injured: null,
      time_confirmed: null,
      status: "open",
      created_at: new Date().toISOString(),
      note: null,
      projects: { job_code: "BLACK22", name: "Black Desert" },
      cost_codes: { code: "100", label: "Install" },
    };
  }

  function mountInSpanish(shift: TimeShift): string {
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
      },
    });
    // Force lang="es" via the profile the provider reads, and seed every query
    // the sheet touches while on the clock so none reaches for the network.
    qc.setQueryData(["myRealProfile"], { id: "me", language: "es", role: "installer" });
    qc.setQueryData(["projects"], []);
    qc.setQueryData(["clockCostCodes", "p1"], []);
    qc.setQueryData(["recentJobs", "me"], []);
    qc.setQueryData(["myActivePhases", "me"], []);
    // Seed the nag banner's completion truthy so it renders nothing and never
    // fetches today's toolbox status.
    qc.setQueryData(["toolboxToday", "me"], { signed: true });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <LanguageProvider>
            <MemoryRouter>
              <ClockSheet
                profileId="me"
                shift={shift}
                onClose={() => {}}
                onChanged={() => {}}
              />
            </MemoryRouter>
          </LanguageProvider>
        </QueryClientProvider>,
      );
    });
    return container.textContent ?? "";
  }

  it("shows 'Trabajado hasta ahora' on break, never the English", () => {
    const text = mountInSpanish({
      ...baseShift(),
      break_started_at: new Date(Date.now() - 300_000).toISOString(),
    });
    expect(text).toContain("Trabajado hasta ahora");
    expect(text).not.toContain("Worked so far");
  });

  it("shows 'Descansos hoy' with a break banked, never the English", () => {
    const text = mountInSpanish({ ...baseShift(), break_seconds: 600 });
    expect(text).toContain("Descansos hoy");
    expect(text).not.toContain("Breaks today");
  });
});
