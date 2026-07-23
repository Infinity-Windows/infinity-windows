// UI gate + framework-free CSV export for the per-vehicle driving log. This is
// tax/financial data, so — exactly like the financials gate — we only surface it
// to a real supervisor/owner who is NOT previewing another role. The CSV shaping
// mirrors `timecardExport.ts`: pure string rows so it stays unit-testable, and
// the WRITE-OFF total sums BUSINESS (clocked-in) drives only.

import { roleRank } from "../install/types";
import { businessTotals, personalTotals } from "./driveClassification";

export interface DriveLogGateInput {
  /** The real signed-in user's role (never a previewed/client role). */
  realRole: string | null | undefined;
  /** Whether a supervisor+ is currently previewing another role. */
  isPreviewing: boolean;
}

/**
 * True only for a real supervisor/owner who is not previewing another role.
 * Same faithful-preview rule as `canSeeFinancials`, one rank lower (owner AND
 * supervisor can see mileage write-offs; installers/foremen never do).
 */
export function canSeeDriveLog({ realRole, isPreviewing }: DriveLogGateInput): boolean {
  if (isPreviewing) return false;
  return roleRank(realRole) >= 2;
}

export interface DriveLogRow {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  start: string;
  end: string;
  /** Pre-formatted duration, e.g. "0:45:00". */
  duration: string;
  distance_miles: number;
  duration_seconds: number;
  business: boolean;
  driver: string;
}

export interface DriveLogExportPayload {
  vehicleLabel: string;
  year: number;
  rows: DriveLogRow[];
}

const DETAIL_COLS = [
  "Date",
  "Start",
  "End",
  "Duration",
  "Miles",
  "Type",
  "Driver",
] as const;

const WIDTH = DETAIL_COLS.length;

function pad(cells: string[]): string[] {
  const row = cells.slice(0, WIDTH);
  while (row.length < WIDTH) row.push("");
  return row;
}

function miles(n: number): string {
  return n.toFixed(2);
}

/**
 * Rows shared by the CSV serializer. Ordering: header block, per-drive detail
 * rows (newest first is the caller's choice — we keep input order), then the
 * BUSINESS write-off total, a personal subtotal, and an all-drives grand total.
 */
export function buildDriveLogRows(payload: DriveLogExportPayload): string[][] {
  const rows: string[][] = [];
  rows.push(pad([`Driving log — ${payload.vehicleLabel}`, String(payload.year)]));
  rows.push(pad([]));
  rows.push(pad([...DETAIL_COLS]));

  for (const r of payload.rows) {
    rows.push(
      pad([
        r.day,
        r.start,
        r.end,
        r.duration,
        miles(r.distance_miles),
        r.business ? "Business" : "Personal",
        r.driver,
      ]),
    );
  }

  const business = businessTotals(payload.rows);
  const personal = personalTotals(payload.rows);
  const allMiles = payload.rows.reduce((sum, r) => sum + (r.distance_miles || 0), 0);

  rows.push(pad([]));
  rows.push(pad(["Business total (write-off)", "", "", business.hours.toFixed(2), miles(business.miles)]));
  rows.push(pad(["Personal total (not counted)", "", "", personal.hours.toFixed(2), miles(personal.miles)]));
  rows.push(pad(["All drives", "", "", "", miles(allMiles)]));
  return rows;
}

function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV with a UTF-8 BOM so Excel on Windows decodes non-ASCII correctly. */
export function buildDriveLogCsv(payload: DriveLogExportPayload): string {
  const body = buildDriveLogRows(payload)
    .map((r) => r.map(csvEscape).join(","))
    .join("\r\n");
  return `\uFEFF${body}`;
}
