import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearOfflineEvents, getOfflineEvents } from "../offline/telemetry";
import { reportPreviousBootRecovery } from "./bootRecoveryDiagnostics";

describe("boot recovery diagnostics", () => {
  beforeEach(() => { clearOfflineEvents(); });

  it("explains the update reload and empty-shell recovery after the next boot", () => {
    const now = Date.now();
    const values = new Map<string, string>([
      ["wops-update-reload-diagnostic", JSON.stringify({ at: now - 9000, reason: "controllerchange" })],
      ["wops-empty-boot-diagnostic", JSON.stringify({ at: now - 1000, entry: "index-a.js", resources: ["index-a.js", "scanner-b.js"] })],
    ]);
    const storage = { getItem: (k: string) => values.get(k) ?? null, removeItem: (k: string) => { values.delete(k); } };
    reportPreviousBootRecovery(storage);
    expect(getOfflineEvents().map((event) => event.scope)).toEqual(["empty-boot", "app-update"]);
    expect(getOfflineEvents()[0].message).toContain("scanner-b.js");
    expect(values.size).toBe(0);
    reportPreviousBootRecovery(storage);
    expect(getOfflineEvents()).toHaveLength(2);
  });

  it("ignores stale, corrupt, and unsafe values without interrupting boot", () => {
    const now = Date.now();
    const values = new Map<string, string>([
      ["wops-update-reload-diagnostic", JSON.stringify({ at: now - 600_000, reason: "controllerchange" })],
      ["wops-empty-boot-diagnostic", JSON.stringify({ at: now, entry: "?token=private", resources: ["https://example.com/private?secret"] })],
    ]);
    reportPreviousBootRecovery({ getItem: (k) => values.get(k) ?? null, removeItem: (k) => { values.delete(k); } });
    expect(getOfflineEvents()).toHaveLength(1);
    expect(getOfflineEvents()[0].message).not.toContain("private");
    expect(getOfflineEvents()[0].message).toContain("unknown");
    const broken = { getItem: vi.fn(() => { throw Error("denied"); }), removeItem: vi.fn() };
    expect(() => reportPreviousBootRecovery(broken)).not.toThrow();
  });
});
