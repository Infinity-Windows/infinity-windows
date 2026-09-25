import { describe, expect, it } from "vitest";
import { CATALOG, translate, type TFn } from "../i18n";
import { pillSummary, countsByOp } from "./outbox-core";
import { withHeld } from "./pillHeld";

const en: TFn = (key, vars) => translate(CATALOG, "en", key, vars);
const es: TFn = (key, vars) => translate(CATALOG, "es", key, vars);

describe("someone else's work on the pill", () => {
  it("changes nothing when there is none", () => {
    const pill = pillSummary(countsByOp([]));
    expect(withHeld(pill, 0, en)).toBe(pill);
  });

  it("is never 'All synced': a phone holding only someone else's work says so", () => {
    const pill = withHeld(pillSummary(countsByOp([])), 2, en);
    expect(pill.tone).toBe("syncing");
    expect(pill.label).toBe("2 saved by someone else");
    expect(pill.detail).toMatch(/goes out when that person signs in again/);
  });

  it("sits beside this person's own pending work, in Spanish too", () => {
    const base = { tone: "syncing" as const, label: "Photos 1", detail: "1 change saved and waiting to sync." };
    expect(withHeld(base, 1, en).label).toBe("Photos 1 · 1 saved by someone else");
    expect(withHeld(base, 3, es).label).toBe("Photos 1 · 3 de otra persona");
  });
});
