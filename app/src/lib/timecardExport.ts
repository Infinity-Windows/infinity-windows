// Framework-free weekly payroll export for the team timecard. Turns a flat list
// of worked shifts into payroll-friendly rows: a detail block, per-person totals,
// and per-cost-code totals. Serialized to CSV (Excel) or TSV (paste into Sheets).
// No Supabase / React types here so the shaping stays unit-testable.

export interface TimecardExportShift {
  employee: string;
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** Formatted start/end times (viewer local), or "" when missing. */
  start: string;
  end: string;
  /** Net worked hours (breaks already excluded). */
  hours: number;
  job: string;
  /** "code - label" or "-". ASCII hyphen so Excel/Windows never mojibakes it. */
  costCode: string;
  status: string;
}

/** One person's week priced against the overtime rule that applies to them. */
export interface TimecardOvertimeLine {
  employee: string;
  regular: number;
  overtime: number;
  doubleTime: number;
}

export interface TimecardExportPayload {
  periodLabel: string;
  shifts: TimecardExportShift[];
  /** Optional weekly regular/OT/double split per person (lib/overtime.ts). */
  overtime?: TimecardOvertimeLine[];
}

function hrs(n: number): string {
  return n.toFixed(2);
}

const DETAIL_COLS = [
  "Employee",
  "Date",
  "Start",
  "End",
  "Hours",
  "Job",
  "Cost Code",
  "Status",
] as const;

const WIDTH = DETAIL_COLS.length;

function pad(cells: string[]): string[] {
  const row = cells.slice(0, WIDTH);
  while (row.length < WIDTH) row.push("");
  return row;
}

function sumBy<T>(rows: T[], key: (r: T) => string, val: (r: T) => number) {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + val(r));
  return m;
}

/**
 * Rows shared by the CSV and TSV serializers. Each cell is a string; the
 * serializer only chooses a delimiter. Ordering: header block, per-day detail
 * rows grouped by employee, per-person totals, per-cost-code totals, grand total.
 */
export function buildTimecardRows(payload: TimecardExportPayload): string[][] {
  const rows: string[][] = [];
  rows.push(pad(["Team timecard", payload.periodLabel]));
  rows.push(pad([]));
  rows.push(pad([...DETAIL_COLS]));

  const sorted = [...payload.shifts].sort(
    (a, b) =>
      a.employee.localeCompare(b.employee, undefined, { sensitivity: "base" }) ||
      a.day.localeCompare(b.day) ||
      a.start.localeCompare(b.start),
  );
  for (const s of sorted) {
    rows.push(
      pad([
        s.employee,
        s.day,
        s.start,
        s.end,
        hrs(s.hours),
        s.job,
        s.costCode,
        s.status,
      ]),
    );
  }

  const grand = payload.shifts.reduce((acc, s) => acc + s.hours, 0);

  rows.push(pad([]));
  rows.push(pad(["Totals per person"]));
  const perPerson = sumBy(payload.shifts, (s) => s.employee, (s) => s.hours);
  for (const [name, total] of [...perPerson.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], undefined, { sensitivity: "base" }),
  )) {
    rows.push(pad([name, "", "", "", hrs(total)]));
  }

  if (payload.overtime && payload.overtime.length > 0) {
    rows.push(pad([]));
    rows.push(pad(["Overtime split", "", "", "", "Regular", "OT", "Double time"]));
    for (const o of [...payload.overtime].sort((a, b) =>
      a.employee.localeCompare(b.employee, undefined, { sensitivity: "base" }),
    )) {
      rows.push(
        pad([o.employee, "", "", "", hrs(o.regular), hrs(o.overtime), hrs(o.doubleTime)]),
      );
    }
  }

  rows.push(pad([]));
  rows.push(pad(["Totals per cost code"]));
  const perCode = sumBy(payload.shifts, (s) => s.costCode, (s) => s.hours);
  for (const [code, total] of [...perCode.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], undefined, { sensitivity: "base" }),
  )) {
    rows.push(pad([code, "", "", "", hrs(total)]));
  }

  rows.push(pad([]));
  rows.push(pad(["Grand total", "", "", "", hrs(grand)]));
  return rows;
}

function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV with a UTF-8 BOM so Excel on Windows decodes non-ASCII correctly. */
export function buildTimecardCsv(payload: TimecardExportPayload): string {
  const body = buildTimecardRows(payload)
    .map((r) => r.map(csvEscape).join(","))
    .join("\r\n");
  return `\uFEFF${body}`;
}

/** TSV for pasting straight into Google Sheets (no BOM — clipboard is UTF-16). */
export function buildTimecardTsv(payload: TimecardExportPayload): string {
  const clean = (v: string) => v.replace(/\t/g, " ").replace(/\r?\n/g, " ");
  return buildTimecardRows(payload)
    .map((r) => r.map(clean).join("\t"))
    .join("\n");
}
