import type { TimeShift } from "./timeclock";
import { splitDisplayName } from "./gustoExport";

/** Original source evidence is immutable; corrections use the ordinary shift fields. */
export interface TimeEntryImportSource {
  source: "busybusy";
  file: string;
  row: number;
  timeZone: string;
  original: Record<string, string>;
}

export const TIME_ENTRY_COLUMNS = [
  "Employee Id", "First Name", "Last Name", "Start", "End", "Break", "Total",
  "Customer", "Project Number", "Project", "Cost Code", "Cost Code Desc.",
  "Equipment", "Add-Ons", "Description", "Status", "Time Zone",
] as const;

export function durationText(seconds: number): string {
  const n = Math.max(0, Math.round(seconds));
  const hours = String(Math.floor(n / 3600)).padStart(2, "0");
  const minutes = String(Math.floor(n % 3600 / 60)).padStart(2, "0");
  return `${hours}:${minutes}${n % 60 ? `:${String(n % 60).padStart(2, "0")}` : ""}`;
}

export function exportTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(Math.round(Date.parse(iso) / 1000) * 1000));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${p.second !== "00" ? `:${p.second}` : ""}`;
}

export function timeEntrySeconds(shift: TimeShift): number {
  if (!shift.clock_out_at) return 0;
  return Math.max(0, (Date.parse(shift.clock_out_at) - Date.parse(shift.clock_in_at)) / 1000 - shift.break_seconds);
}

export function completedExportShifts(shifts: TimeShift[]): TimeShift[] {
  return shifts.filter(s => s.status !== "voided" && s.clock_out_at &&
    Number.isFinite(Date.parse(s.clock_in_at)) && Number.isFinite(Date.parse(s.clock_out_at)));
}

export function buildTimeEntryRows(shifts: TimeShift[], timeZone: string, fallbackName = ""): string[][] {
  const rows: string[][] = [[...TIME_ENTRY_COLUMNS]];
  for (const s of completedExportShifts(shifts).sort((a, b) =>
    (a.profiles?.display_name ?? fallbackName).localeCompare(b.profiles?.display_name ?? fallbackName) ||
    a.profile_id.localeCompare(b.profile_id) || a.clock_in_at.localeCompare(b.clock_in_at) || a.id.localeCompare(b.id))) {
    const original = s.source_import?.original ?? {};
    const name = splitDisplayName(s.profiles?.display_name ?? fallbackName);
    const unassigned = !s.project_id && original.Project;
    const description = [s.note ?? "", unassigned ? `STG project awaiting assignment: ${original.Project}` : ""].filter(Boolean).join("\n");
    rows.push([
      s.profile_id, original["First Name"] ?? name.firstName, original["Last Name"] ?? name.lastName,
      exportTime(s.clock_in_at, timeZone), exportTime(s.clock_out_at!, timeZone),
      durationText(s.break_seconds), durationText(timeEntrySeconds(s)), original.Customer ?? "",
      s.projects?.job_code ?? original["Project Number"] ?? "", s.projects?.name ?? original.Project ?? "",
      s.cost_codes?.code ?? original["Cost Code"] ?? "", s.cost_codes?.label ?? original["Cost Code Desc."] ?? "",
      original.Equipment ?? "", original["Add-Ons"] ?? "", description, s.status, timeZone,
    ]);
  }
  return rows;
}

/** Quotes CSV and neutralizes spreadsheet formulas in user-entered text. */
function csvCell(value: string): string {
  const safe = /^[\s]*[=+@-]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function buildTimeEntriesCsv(shifts: TimeShift[], timeZone: string, fallbackName = ""): string {
  return "\uFEFF" + buildTimeEntryRows(shifts, timeZone, fallbackName).map(row => row.map(csvCell).join(",")).join("\r\n");
}

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Shared, printable preview; no guessed overtime for a partial date range. */
export function timeEntriesHtml(shifts: TimeShift[], period: string, timeZone: string, fallbackName = ""): string {
  const rows = buildTimeEntryRows(shifts, timeZone, fallbackName).slice(1);
  const groups = new Map<string, string[][]>();
  for (const row of rows) groups.set(row[0], [...(groups.get(row[0]) ?? []), row]);
  let body = "";
  for (const [id, entries] of groups) {
    const personShifts = completedExportShifts(shifts).filter(s => s.profile_id === id);
    const seconds = personShifts.reduce((n, s) => n + timeEntrySeconds(s), 0);
    const breaks = personShifts.reduce((n, s) => n + s.break_seconds, 0);
    const name = `${entries[0][1]} ${entries[0][2]}`.trim();
    body += `<section><div class="person"><h2>${esc(name)}</h2><strong>${durationText(seconds)}</strong></div>
      <p class="muted">${entries.length} entries · Breaks ${durationText(breaks)}</p>
      <table><thead><tr>${["Start", "End", "Break", "Total", "Project", "Cost code", "Description", "Status"].map(h => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${entries.map(r => `<tr>${[r[3], r[4], r[5], r[6], [r[8], r[9]].filter(Boolean).join(" · "), [r[10], r[11]].filter(Boolean).join(" · "), r[14], r[15]].map(v => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></section>`;
  }
  const total = completedExportShifts(shifts).reduce((n, s) => n + timeEntrySeconds(s), 0);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Forge time entries · ${esc(period)}</title><style>
    *{box-sizing:border-box}body{font:14px/1.45 system-ui,sans-serif;background:#f6f3f0;color:#211915;margin:0;padding:24px}
    main{max-width:1400px;margin:auto}header{background:#170e0a;color:#fff;border-top:5px solid #ff432d;padding:24px;border-radius:12px}
    .brand{color:#ff694f;font-size:13px;font-weight:800;letter-spacing:.16em}h1{margin:8px 0;font-size:28px}header p{margin:5px 0;color:#e4d6d0}
    button{font:inherit;padding:12px 18px;border:0;border-radius:8px;background:#ff432d;color:#fff;cursor:pointer;margin:16px 0}
    section{background:#fff;border:1px solid #e4d6d0;border-radius:12px;padding:20px;margin:18px 0;overflow-x:auto}
    .person{display:flex;justify-content:space-between;gap:16px;align-items:center}.person strong{font-size:24px;font-variant-numeric:tabular-nums}h2{font-size:20px;margin:0}
    .muted{color:#665850;margin:6px 0 16px}table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;background:#faf0ea;border-bottom:2px solid #ff432d}
    th,td{padding:9px 7px;vertical-align:top}td{border-bottom:1px solid #e6ddd7;white-space:pre-wrap;overflow-wrap:anywhere}th:nth-child(-n+4),td:nth-child(-n+4){white-space:nowrap}
    footer{font-weight:700;text-align:right;font-size:20px;margin:18px 0}.note{font-size:12px;color:#665850}
    @page{size:landscape;margin:12mm}@media print{body{background:#fff;padding:0;font-size:11px}button{display:none}header{color:#211915;background:#fff;border-radius:0;padding:12px 0}header p{color:#665850}section{border:0;padding:8px 0;overflow:visible}thead{display:table-header-group}tr{break-inside:avoid}.person{break-after:avoid}h1{font-size:22px}table{font-size:10px}th,td{padding:5px}}
    </style></head><body><main><header><div class="brand">FORGE WINDOWS &amp; DOORS</div><h1>Time entries</h1><p>${esc(period)} · ${esc(timeZone)}</p></header>
    <button onclick="window.print()">Print / Save PDF</button>${body}<footer>Total recorded time: ${durationText(total)}</footer>
    <p class="note">Hours exclude breaks. Unfinished and removed entries are excluded. Check each entry’s status before payroll; exporting does not approve hours. Times are shown to the nearest second. This entry report does not calculate overtime for partial weeks.</p>
    </main></body></html>`;
}
