import { describe, expect, it } from "vitest";
import { CATALOG, translate, type Lang, type TFn } from "../i18n";
import { pillSummary, type PillSummary } from "./outbox-core";
import { combineQueues, EMPTY_SNAPSHOT, PILL_DESTINATION, type QueueSnapshot } from "./pillQueues";

const en: TFn = (key, vars) => translate(CATALOG, "en" as Lang, key, vars);
const es: TFn = (key, vars) => translate(CATALOG, "es" as Lang, key, vars);

const SYNCED: PillSummary = pillSummary({
  clock: 0, photos: 0, memos: 0, receipts: 0, logs: 0, other: 0, deadLetter: 0, warehouse: 0,
});
const PHOTOS_WAITING: PillSummary = pillSummary({
  clock: 0, photos: 2, memos: 0, receipts: 0, logs: 0, other: 0, deadLetter: 0, warehouse: 0,
});
const DEAD_LETTER: PillSummary = pillSummary({
  clock: 0, photos: 0, memos: 0, receipts: 0, logs: 0, other: 0, deadLetter: 1, warehouse: 0,
});

const snap = (over: Partial<QueueSnapshot>): QueueSnapshot => ({ ...EMPTY_SNAPSHOT, ...over });

describe("combineQueues — one honest status", () => {
  it("leaves a phone with nothing anywhere at All synced", () => {
    expect(combineQueues(SYNCED, EMPTY_SNAPSHOT, en)).toBe(SYNCED);
    expect(combineQueues(SYNCED, EMPTY_SNAPSHOT, en).label).toBe("All synced");
  });

  // The rule that matters: not one of these may read "All synced".
  it.each<[string, Partial<QueueSnapshot>, string]>([
    ["a finished unit", { installsPending: 1 }, "1 install queued"],
    ["three finished units", { installsPending: 3 }, "3 installs queued"],
    ["a custom-work change", { workPending: 1 }, "1 work change queued"],
    ["custom-work changes", { workPending: 2 }, "2 work changes queued"],
    ["a servicing change", { servicePending: 1 }, "1 service change queued"],
    ["servicing evidence", { servicePending: 4 }, "4 service changes queued"],
    ["a memo still in the old upload store", { legacyPending: 1 }, "Old uploads 1"],
  ])("never says All synced while %s is waiting", (_what, over, words) => {
    const pill = combineQueues(SYNCED, snap(over), en);
    expect(pill.tone).toBe("syncing");
    expect(pill.label).toBe(words);
    expect(pill.label).not.toContain("All synced");
  });

  it("names every waiting queue on the face, after the outbox's own words", () => {
    const pill = combineQueues(
      PHOTOS_WAITING,
      snap({ basePending: 2, installsPending: 1, workPending: 1, servicePending: 2, legacyPending: 3 }),
      en,
    );
    expect(pill.label).toBe(
      "Photos 2 · 1 install queued · 1 work change queued · 2 service changes queued · Old uploads 3",
    );
    expect(pill.tone).toBe("syncing");
    expect(pill.detail).toBe(
      "9 changes are saved on this phone and waiting to send. Open this to see them.",
    );
  });

  it("reads a single waiting change as one", () => {
    expect(combineQueues(SYNCED, snap({ installsPending: 1 }), en).detail).toBe(
      "1 change is saved on this phone and waiting to send. Open this to see it.",
    );
  });

  it.each<[string, Partial<QueueSnapshot>, string]>([
    ["an install", { installsFailed: 1 }, "1 install needs you"],
    ["installs", { installsFailed: 2 }, "2 installs need you"],
    ["custom work", { workPending: 1, workFailed: 1 }, "Work needs review"],
    ["servicing", { servicePending: 1, serviceFailed: 1 }, "Service work needs review"],
  ])("turns to needs-you when %s has given up", (_what, over, words) => {
    const pill = combineQueues(SYNCED, snap(over), en);
    expect(pill.tone).toBe("attention");
    expect(pill.label).toBe(words);
    expect(pill.detail).toContain("couldn't send and needs you");
  });

  it("keeps the outbox's own needs-attention, and adds the others after it", () => {
    const pill = combineQueues(DEAD_LETTER, snap({ installsPending: 1 }), en);
    expect(pill.tone).toBe("attention");
    expect(pill.label).toBe("Needs attention · 1 install queued");
  });

  it("stays red when a queue has given up even though others are only waiting", () => {
    const pill = combineQueues(PHOTOS_WAITING, snap({ basePending: 2, workPending: 1, workFailed: 1 }), en);
    expect(pill.tone).toBe("attention");
    expect(pill.label).toBe("Photos 2 · Work needs review");
    expect(pill.detail).toBe(
      "Something on this phone couldn't send and needs you. Open this to see it. " +
        "3 changes are saved on this phone and waiting to send. Open this to see them.",
    );
  });

  it("speaks Spanish when the phone does", () => {
    const pill = combineQueues(SYNCED, snap({ installsPending: 2, workFailed: 1, workPending: 1 }), es);
    expect(pill.label).toBe("2 instalaciones en espera · El trabajo necesita revisión");
    expect(pill.detail).toContain("te necesita");
  });
});

describe("where the pill opens", () => {
  it("is /stuck, whatever is queued — one tap, one place (F5)", () => {
    expect(PILL_DESTINATION).toBe("/stuck");
  });
});
