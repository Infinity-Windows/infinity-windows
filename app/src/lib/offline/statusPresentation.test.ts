import { describe, expect, it } from "vitest";
import { CATALOG, translate, type Lang, type TFn } from "../i18n";
import { statusPresentation } from "./statusPresentation";
import type { SyncReceipt } from "./syncReceipt";

const en: TFn = (key, vars) => translate(CATALOG, "en" as Lang, key, vars);
const es: TFn = (key, vars) => translate(CATALOG, "es" as Lang, key, vars);
const empty = { tone: "synced" as const, label: "All synced", detail: "All changes are saved and synced." };
const waiting = { tone: "syncing" as const, label: "Clock 1 · Photos 2", detail: "3 changes saved and waiting to sync." };
const ownReceipt: SyncReceipt = { ownerId: "installer-1", savedAt: Date.parse("2026-10-01T12:00:00Z"), sequence: 1 };
const view = (over: Partial<Parameters<typeof statusPresentation>[0]> = {}) => statusPresentation({
  pill: empty, outboxReadState: "ready", allReady: true, readError: false,
  receipt: null, profileId: "installer-1", quietWhenSynced: true,
  now: ownReceipt.savedAt + 1000, t: en, ...over,
});

describe("crew save status", () => {
  it("does not promise all synced while any durable queue is still being read", () => {
    const checking = view({ outboxReadState: "checking", allReady: false });
    expect(checking).toMatchObject({ visible: true, display: { label: "Checking saved work…" } });
    expect(view({ allReady: false }).display.label).toBe("Checking saved work…");
    expect(view({ pill: waiting, allReady: false }).display.label).toBe("Checking saved work…");
    expect(view({ readError: true }).display).toMatchObject({ tone: "attention", label: "Check saved work" });
  });

  it("keeps queued work, weak signal, and a refusal visible rather than covering them with a recent receipt", () => {
    expect(view({ pill: waiting, receipt: ownReceipt }).display.label).toBe(waiting.label);
    expect(view({ pill: { tone: "weak", label: "Weak signal", detail: "Slow connection" } }).visible).toBe(true);
    expect(view({ pill: { tone: "attention", label: "Needs attention", detail: "A write failed" } }).visible).toBe(true);
  });

  it("briefly confirms only this account's server receipt, then clears the resting badge", () => {
    expect(view({ receipt: ownReceipt })).toMatchObject({ visible: true, receipt: true, display: { label: "Saved in Forge" } });
    expect(view({ receipt: ownReceipt, now: ownReceipt.savedAt + 4000 }).visible).toBe(false);
    expect(view({ receipt: { ...ownReceipt, ownerId: "other-installer" } }).visible).toBe(false);
    expect(view({ receipt: null }).visible).toBe(false); // A discard is not a save.
  });

  it("keeps the classic resting badge and gives Spanish readers the same clear state", () => {
    expect(view({ quietWhenSynced: false }).visible).toBe(true);
    expect(view({ allReady: false, t: es }).display.label).toBe("Revisando el trabajo guardado…");
    expect(view({ receipt: ownReceipt, t: es }).display.label).toBe("Guardado en Forge");
  });
});
