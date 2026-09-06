import { describe, expect, it } from "vitest";
import type { TFn } from "../i18n";
import { withConnection } from "./pillConnection";

const t: TFn = (key) => key;
const synced = { tone: "synced" as const, label: "All synced", detail: "All changes are saved and synced." };
const syncing = { tone: "syncing" as const, label: "Clock 1 · Photos 3", detail: "4 changes saved and waiting to sync." };
const attention = { tone: "attention" as const, label: "Needs attention", detail: "1 item couldn't sync." };

describe("withConnection", () => {
  it("leaves a healthy online pill alone", () => {
    expect(withConnection(synced, true, false, t)).toEqual(synced);
    expect(withConnection(syncing, true, false, t)).toEqual(syncing);
  });
  it("says no signal, and keeps the queue in the label when there is one", () => {
    expect(withConnection(synced, false, false, t)).toEqual({ tone: "offline", label: "pill.noSignal", detail: "pill.noSignalDetail" });
    expect(withConnection(syncing, false, true, t).label).toBe("pill.noSignal · Clock 1 · Photos 3");
  });
  it("says weak signal when a request just timed out", () => {
    expect(withConnection(synced, true, true, t).tone).toBe("weak");
    expect(withConnection(syncing, true, true, t).label).toBe("pill.weakSignal · Clock 1 · Photos 3");
  });
  it("a red pill stays red whatever the connection does", () => {
    expect(withConnection(attention, false, true, t)).toEqual(attention);
  });
});
