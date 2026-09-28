import { describe, expect, it } from "vitest";
import type { OutboxEntry } from "./outbox-core";
import { CATALOG, translate, type TKey, type TVars } from "../i18n";
import {
  buildLegacyClockRecoveryRecord,
  formatLegacyClockRecoveryText,
  isUnknownClockEntry,
} from "./legacyClockRecovery";

const tEn = (key: TKey, vars?: TVars) => translate(CATALOG, "en", key, vars);
const tEs = (key: TKey, vars?: TVars) => translate(CATALOG, "es", key, vars);

function legacyClockEntry(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: "entry-1",
    op: "clock_out",
    payload: {
      clientId: "client-abc",
      tappedAt: "2026-09-20T14:03:00.000Z",
      clockCheckedAt: "2026-09-20T14:02:55.000Z",
      clockSkewMs: 1200,
      projectId: "proj-9",
      costCodeId: "cc-3",
      shiftRef: "shift-77",
      breakType: "lunch",
      breakSeconds: 1800,
      // A different installer may open this shared phone. These private
      // fields must remain in the local entry but never appear in its export.
      injured: true,
      injuryNote: "private-medical-detail",
      note: "private-freeform-note",
      labels: ["private-label"],
      timeConfirmed: true,
      payRate: "private-pay-rate",
      // Secrets that must never reach a recovery record, whatever they're
      // called — this is the property the whitelist exists to guarantee.
      authToken: "super-secret-access-token",
      refreshToken: "super-secret-refresh-token",
      apiKey: "another-secret",
    },
    createdAt: Date.parse("2026-09-20T14:05:00.000Z"),
    attemptCount: 0,
    lastError: null,
    status: "queued",
    nextAttemptAt: 0,
    dependsOn: null,
    hasBlob: false,
    ...over,
  };
}

describe("isUnknownClockEntry", () => {
  it("is true for all four clock ops", () => {
    for (const op of ["clock_in", "clock_out", "break_start", "break_stop"] as const) {
      expect(isUnknownClockEntry({ op })).toBe(true);
    }
  });

  it("is false for a non-clock op", () => {
    expect(isUnknownClockEntry({ op: "daily_log" })).toBe(false);
  });
});

describe("buildLegacyClockRecoveryRecord", () => {
  it("carries the entry id, client id, and untouched tap timestamp through unchanged", () => {
    const entry = legacyClockEntry();
    const record = buildLegacyClockRecoveryRecord(entry);
    expect(record.entryId).toBe("entry-1");
    expect(record.clientId).toBe("client-abc");
    expect(record.tappedAt).toBe("2026-09-20T14:03:00.000Z");
    expect(record.queuedAt).toBe(new Date(entry.createdAt).toISOString());
    expect(record.projectId).toBe("proj-9");
    expect(record.costCodeId).toBe("cc-3");
    expect(record.shiftRef).toBe("shift-77");
    expect(record.breakType).toBe("lunch");
    expect(record.breakSeconds).toBe(1800);
  });

  it("never carries authToken, refreshToken, or any other unlisted payload key", () => {
    const record = buildLegacyClockRecoveryRecord(legacyClockEntry());
    const json = JSON.stringify(record);
    expect(json).not.toContain("super-secret-access-token");
    expect(json).not.toContain("super-secret-refresh-token");
    expect(json).not.toContain("another-secret");
    expect(json).not.toContain("authToken");
    expect(json).not.toContain("refreshToken");
    expect(json).not.toContain("apiKey");
    for (const privateValue of ["private-medical-detail", "private-freeform-note", "private-label", "private-pay-rate"]) {
      expect(json).not.toContain(privateValue);
    }
    expect(json).not.toContain("injured");
  });

  it("leaves an absent field as null rather than guessing", () => {
    const record = buildLegacyClockRecoveryRecord(legacyClockEntry({ payload: { tappedAt: "2026-09-20T14:03:00.000Z" } }));
    expect(record.clientId).toBeNull();
    expect(record.projectId).toBeNull();
    expect(record.breakSeconds).toBeNull();
  });

  // A truly legacy row can carry a malformed createdAt — `new
  // Date(x).toISOString()` throws RangeError on both NaN and a number
  // outside Date's range, and this must never crash the page it renders on.
  it("reports queuedAt as null, not a crash, when createdAt is out of range", () => {
    const outOfRange = buildLegacyClockRecoveryRecord(legacyClockEntry({ createdAt: 8.65e15 }));
    expect(outOfRange.queuedAt).toBeNull();
    const nan = buildLegacyClockRecoveryRecord(legacyClockEntry({ createdAt: Number.NaN }));
    expect(nan.queuedAt).toBeNull();
  });
});

describe("formatLegacyClockRecoveryText", () => {
  it("states the owner is UNKNOWN and that it does not update payroll, in English", () => {
    const text = formatLegacyClockRecoveryText(buildLegacyClockRecoveryRecord(legacyClockEntry()), tEn);
    expect(text).toContain("Owner: UNKNOWN");
    expect(text).toContain("does not update payroll");
  });

  it("says the same thing in Spanish when the reader's language is Spanish", () => {
    const text = formatLegacyClockRecoveryText(buildLegacyClockRecoveryRecord(legacyClockEntry()), tEs);
    expect(text).toContain("DESCONOCIDO");
    expect(text).toContain("ni actualiza la nómina");
    // Not an English block dropped into the Spanish record.
    expect(text).not.toContain("Owner: UNKNOWN");
    expect(text).not.toContain("Entry id:");
  });

  it("includes the whitelisted facts and never the secret payload values, in either language", () => {
    for (const t of [tEn, tEs]) {
      const text = formatLegacyClockRecoveryText(buildLegacyClockRecoveryRecord(legacyClockEntry()), t);
      expect(text).toContain("entry-1");
      expect(text).toContain("client-abc");
      expect(text).toContain("2026-09-20T14:03:00.000Z");
      expect(text).toContain("proj-9");
      expect(text).toContain("shift-77");
      expect(text).toContain("1800");
      expect(text).not.toContain("super-secret");
      expect(text).not.toContain("private-");
    }
  });

  it("labels the converted local time as the device's CURRENT zone at export, never the zone the punch happened in", () => {
    const text = formatLegacyClockRecoveryText(buildLegacyClockRecoveryRecord(legacyClockEntry()), tEn);
    // The raw, untouched timestamp is still present as its own line.
    expect(text).toContain("Tapped at (device, untouched): 2026-09-20T14:03:00.000Z");
    expect(text).toMatch(/CURRENT time zone at export/);
    expect(text).toMatch(/not necessarily the zone the punch happened in/);
  });

  it("prints an honest 'unknown' queued time rather than crashing when createdAt is out of range", () => {
    const record = buildLegacyClockRecoveryRecord(legacyClockEntry({ createdAt: Number.NaN }));
    expect(() => formatLegacyClockRecoveryText(record, tEn)).not.toThrow();
    const text = formatLegacyClockRecoveryText(record, tEn);
    expect(text).toContain("unknown");
    expect(text).not.toContain("Invalid Date");
  });
});
