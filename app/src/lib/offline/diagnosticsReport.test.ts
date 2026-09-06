import { describe, expect, it } from "vitest";
import { buildDiagnosticsReport } from "./diagnosticsReport";

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

describe("buildDiagnosticsReport", () => {
  it("says the things support needs, in order, with no ids", () => {
    const text = buildDiagnosticsReport({
      buildId: "abc1234",
      builtAt: "2026-09-06T05:00:00Z",
      supabaseHost: "czprjcskmzzagdztqonm.supabase.co",
      online: true,
      weak: true,
      lastOkAt: NOW - 3 * 60_000,
      queues: [
        { label: "Clock", pending: 1, failed: 0 },
        { label: "Installs", pending: 0, failed: 2 },
      ],
      savedJobs: [{ name: "BLACK22", record: { at: NOW - 2 * 3_600_000, specs: 37, plansets: 3, drawings: 36, failed: 0 } }],
      events: [
        { type: "flush", count: 3, at: NOW - 60_000 },
        { type: "timeout", scope: "supabase", at: NOW - 120_000 },
      ],
      now: NOW,
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Forge diagnostics 2026-09-06 12:00:00");
    expect(lines[1]).toContain("abc1234");
    expect(lines[3]).toBe("Connection: weak signal; last good request 3 min ago");
    expect(text).toContain("  Clock: 1 pending");
    expect(text).toContain("  Installs: 0 pending, 2 need attention");
    expect(text).toContain("Jobs saved on this phone: 1");
    expect(text).toContain("  BLACK22: 2 h ago (37 specs, 3 sheets, 36 pictures)");
    expect(text).toContain("1 timeouts, 0 saved-copy screens, 1 flushes sent 3");
    expect(text).toContain("2026-09-06 11:59:00 flush ×3");
    expect(text).toContain("2026-09-06 11:58:00 timeout supabase");
  });

  it("handles a phone that has never reached the database", () => {
    const text = buildDiagnosticsReport({
      buildId: "", builtAt: "", supabaseHost: "", online: false, weak: false, lastOkAt: null,
      queues: [], savedJobs: [], events: [], now: NOW,
    });
    expect(text).toContain("Build unknown");
    expect(text).toContain("Connection: offline; last good request never");
    expect(text).toContain("Jobs saved on this phone: 0");
  });
});
