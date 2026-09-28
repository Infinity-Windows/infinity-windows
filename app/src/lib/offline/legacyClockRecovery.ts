// A legacy clock punch (clock_in/out, break_start/stop) with no known owner
// (Codex review of #660, P1 #1) can never be replayed or thrown away the way
// every other unknown-owner row can: it is the one write where deleting it
// can make a real punch disappear with nothing left for payroll to rebuild.
// This builds the one thing StuckWrites offers instead — a factual, WHITELISTED
// record of what the phone captured, for a foreman to reconcile by hand
// against the server timecard. It never sends, retries, assigns an owner, or
// creates a timecard; the IndexedDB entry it reads is never written to.
//
// Pure and framework-free on purpose, like outbox-core — the whitelist is the
// safety property, and it has to be provable without a browser.

import { isClockOp, type OutboxEntry, type OutboxOp } from "./outbox-core";
import type { TFn, TKey } from "../i18n";

/**
 * Only these fields ever leave a legacy clock entry's payload. Anything not
 * named here — an `authToken`, a `refreshToken`, or any other key a payload
 * happens to carry — never reaches the record. A shared phone may be opened
 * by another installer, so injury answers, freeform notes, labels, and pay
 * details are deliberately omitted even when present. Widen this list
 * deliberately, field by field, never by spreading the raw payload.
 */
export interface LegacyClockRecoveryRecord {
  entryId: string;
  op: OutboxOp;
  clientId: string | null;
  /** The tap timestamp exactly as the phone recorded it — untouched. */
  tappedAt: string | null;
  clockCheckedAt: string | null;
  clockSkewMs: number | null;
  /** When the outbox itself queued this entry (ISO, from createdAt) — null
   * when createdAt was malformed rather than a fabricated date. */
  queuedAt: string | null;
  projectId: string | null;
  costCodeId: string | null;
  shiftRef: string | null;
  breakType: string | null;
  breakSeconds: number | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A clock op (clock_in/out, break_start/stop) — the one unknown-owner shape
 * that gets a recovery record instead of Throw away. */
export function isUnknownClockEntry(entry: Pick<OutboxEntry, "op">): boolean {
  return isClockOp(entry.op);
}

/**
 * `entry.createdAt` on a genuinely legacy row can be malformed (NaN, or a
 * number outside the ~273,790-year range `Date` accepts) — `toISOString()`
 * throws `RangeError` on that, and this record must never crash the page it
 * renders on. `null` says plainly that the queue time isn't known rather than
 * printing a fabricated one.
 */
function safeIsoOrNull(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Pull only the whitelisted fields off a legacy clock entry. See the
 * interface doc — never spread `entry.payload` into the result. */
export function buildLegacyClockRecoveryRecord(entry: OutboxEntry): LegacyClockRecoveryRecord {
  const p = entry.payload;
  return {
    entryId: entry.id,
    op: entry.op,
    clientId: str(p.clientId),
    tappedAt: str(p.tappedAt),
    clockCheckedAt: str(p.clockCheckedAt),
    clockSkewMs: num(p.clockSkewMs),
    queuedAt: safeIsoOrNull(entry.createdAt),
    projectId: str(p.projectId),
    costCodeId: str(p.costCodeId),
    shiftRef: str(p.shiftRef),
    breakType: str(p.breakType),
    breakSeconds: num(p.breakSeconds),
  };
}

/** Only the four clock ops this module ever handles carry a label — the
 * fallback below covers the type, not a case that happens in practice
 * (`isUnknownClockEntry` gates every caller to a clock op first). */
const OP_LABEL_KEY: Partial<Record<OutboxOp, TKey>> = {
  clock_in: "stuck.op.clockIn",
  clock_out: "stuck.op.clockOut",
  break_start: "stuck.op.breakStart",
  break_stop: "stuck.op.breakStop",
};

/**
 * The tap time re-rendered in the CURRENT device's clock, purely for a person
 * to read at a glance. This is NOT the timezone the punch happened in — the
 * legacy payload never recorded one — so the label passed to `t()` must say
 * "current device zone at export", never anything implying it was captured
 * at the tap. Caller supplies the zone name so the text stays testable
 * without mocking `Intl`.
 */
function localTimeAtExport(iso: string, tz: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toLocaleString()} (${tz})`;
}

/**
 * The recovery record: what a foreman copies or downloads. Every line names
 * a whitelisted field; nothing here is the raw payload. Localized through the
 * same `t()`/CATALOG every other screen in the app uses, so an installer
 * reading Spanish sees Spanish, not an English block dropped into their UI.
 */
export function formatLegacyClockRecoveryText(record: LegacyClockRecoveryRecord, t: TFn): string {
  const lines: string[] = [];
  lines.push(t("stuck.unknownClock.record.header"));
  lines.push(t("stuck.unknownClock.record.ownerLine"));
  lines.push("");
  lines.push(t("stuck.unknownClock.record.action", { value: t(OP_LABEL_KEY[record.op] ?? "stuck.op.clockIn") }));
  lines.push(t("stuck.unknownClock.record.entryId", { value: record.entryId }));
  if (record.clientId) lines.push(t("stuck.unknownClock.record.clientId", { value: record.clientId }));
  if (record.tappedAt) {
    lines.push(t("stuck.unknownClock.record.tappedDevice", { value: record.tappedAt }));
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const local = localTimeAtExport(record.tappedAt, tz);
    if (local) lines.push(t("stuck.unknownClock.record.tappedLocalNow", { value: local, tz }));
  }
  if (record.clockCheckedAt) lines.push(t("stuck.unknownClock.record.clockChecked", { value: record.clockCheckedAt }));
  if (record.clockSkewMs != null) lines.push(t("stuck.unknownClock.record.clockSkew", { value: record.clockSkewMs }));
  lines.push(
    t("stuck.unknownClock.record.queuedAt", {
      value: record.queuedAt ?? t("stuck.unknownClock.record.unknownTime"),
    }),
  );
  if (record.projectId) lines.push(t("stuck.unknownClock.record.projectId", { value: record.projectId }));
  if (record.costCodeId) lines.push(t("stuck.unknownClock.record.costCodeId", { value: record.costCodeId }));
  if (record.shiftRef) lines.push(t("stuck.unknownClock.record.shiftRef", { value: record.shiftRef }));
  if (record.breakType) lines.push(t("stuck.unknownClock.record.breakType", { value: record.breakType }));
  if (record.breakSeconds != null) lines.push(t("stuck.unknownClock.record.breakSeconds", { value: record.breakSeconds }));
  lines.push("");
  lines.push(t("stuck.unknownClock.record.footer1"));
  lines.push(t("stuck.unknownClock.record.footer2"));
  return lines.join("\n");
}
