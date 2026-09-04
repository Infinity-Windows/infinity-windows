// The pay-period file the office uploads to Gusto (Wave K, K5).
//
// WHAT GUSTO ACTUALLY WANTS, and how we know. Gusto's payroll importer is
// "Smart Import" (Pay → Run payroll → Import payroll data): it accepts a
// spreadsheet or CSV and MATCHES the columns itself rather than requiring a
// fixed template, so there is no downloadable template with pinned header
// names to copy. What Gusto's own help pages do name are the columns of the
// payroll grid the import fills in — Regular hours, Overtime hours and Double
// overtime — with hours entered as decimals (1 hour 15 minutes = 1.25) and the
// pay rate taken from the person's Gusto profile, never from the file.
//
// So the columns below are Gusto's OWN words for those three figures, plus the
// employee's name to match them to a person. Nothing here is invented: if a
// header is ever wrong, Gusto's importer shows the mapping step and the office
// re-points it once — which is exactly why it is a matched import rather than
// a rigid template.
//
// DELIBERATELY NOT IN THE FILE: comment or note rows explaining any of this.
// A leading "# exported by …" line is the kind of thing an importer reads as a
// row of data. The explanation belongs in this comment, where a person can read
// it, and the file stays a clean table.
//
// One row per employee for the WHOLE pay period, with the overtime split
// computed per calendar week (lib/overtimeRollup.ts) — never one 80-hour pool.
// Names come from `profiles.display_name`, the only name this app has.

export interface GustoHoursRow {
  firstName: string;
  lastName: string;
  regular: number;
  overtime: number;
  doubleOvertime: number;
}

/** Gusto's own column names for the three hour buckets, plus the name. */
export const GUSTO_COLUMNS = [
  "First name",
  "Last name",
  "Regular hours",
  "Overtime hours",
  "Double overtime",
] as const;

/**
 * "Jose Ramirez Diaz" → first "Jose", last "Ramirez Diaz".
 *
 * One display name is all this app stores, so the split is the honest guess:
 * first word is the given name, everything after it is the surname — which is
 * right for a two-part name and right for a compound surname. A single-word
 * name keeps the whole thing as the first name rather than inventing a blank
 * surname in the wrong column.
 */
export function splitDisplayName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function hrs(n: number): string {
  return n.toFixed(2);
}

function csvEscape(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Rows for the CSV, header first — shared with the test and the serializer. */
export function buildGustoRows(rows: GustoHoursRow[]): string[][] {
  const out: string[][] = [[...GUSTO_COLUMNS]];
  for (const r of rows) {
    out.push([
      r.firstName,
      r.lastName,
      hrs(r.regular),
      hrs(r.overtime),
      hrs(r.doubleOvertime),
    ]);
  }
  return out;
}

/** CSV with a UTF-8 BOM, so Excel on Windows opens it without mojibake. */
export function buildGustoCsv(rows: GustoHoursRow[]): string {
  const body = buildGustoRows(rows)
    .map((r) => r.map(csvEscape).join(","))
    .join("\r\n");
  return `\uFEFF${body}`;
}

/** `gusto-hours-2026-09-07.csv` — the period start, so two files sort. */
export function gustoFileName(periodStartIso: string): string {
  return `gusto-hours-${periodStartIso.slice(0, 10)}.csv`;
}
