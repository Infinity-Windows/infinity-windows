import { describe, expect, it } from "vitest";
import { CATALOG, translate, type TFn } from "../i18n";
import { pillSummary, countsByOp } from "./outbox-core";
import { withHeld } from "./pillHeld";

const en: TFn = (key, vars) => translate(CATALOG, "en", key, vars);
const es: TFn = (key, vars) => translate(CATALOG, "es", key, vars);

describe("someone else's work on the pill", () => {
  it("changes nothing when there is none", () => {
    const pill = pillSummary(countsByOp([]));
    expect(withHeld(pill, { theirs: 0, unknown: 0 }, en)).toBe(pill);
  });

  it("is never 'All synced': a phone holding only someone else's work says so", () => {
    const pill = withHeld(pillSummary(countsByOp([])), { theirs: 2, unknown: 0 }, en);
    expect(pill.tone).toBe("syncing");
    expect(pill.label).toBe("2 saved by someone else");
    expect(pill.detail).toMatch(/goes out when that person signs in again/);
  });

  it("sits beside this person's own pending work, in Spanish too", () => {
    const base = { tone: "syncing" as const, label: "Photos 1", detail: "1 change saved and waiting to sync." };
    expect(withHeld(base, { theirs: 1, unknown: 0 }, en).label).toBe("Photos 1 · 1 saved by someone else");
    expect(withHeld(base, { theirs: 3, unknown: 0 }, es).label).toBe("Photos 1 · 3 de otra persona");
  });

  it("names work saved before an update, whose owner nobody can tell, on its own — in English and Spanish", () => {
    // Codex review of #660, P1 #1: held, never sent as anyone; a person
    // opens Stuck writes to see it and can throw it away.
    const only = withHeld(pillSummary(countsByOp([])), { theirs: 0, unknown: 2 }, en);
    expect(only.tone).toBe("syncing");
    expect(only.label).toBe("2 saved before an update");
    expect(only.detail).toMatch(/can't tell who saved/);
    const both = withHeld(pillSummary(countsByOp([])), { theirs: 1, unknown: 1 }, es);
    expect(both.label).toBe("1 de otra persona · 1 de antes de una actualización");
  });
});
