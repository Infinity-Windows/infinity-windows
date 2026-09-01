// Printable per-person timesheet, modeled on Horizon's PDF column layout:
// Date | Start | End | Break | Paid | Job | Cost code | Notes, with per-day
// subtotal rows, a Regular/Overtime split, and a signature line. Rendered as
// a print-styled HTML window (browser print → PDF) instead of shipping a
// PDF library to every phone.

import {
  punchDay,
  shiftHours,
  type TimeShift,
} from "../../lib/timeclock";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function t(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function hrs(h: number): string {
  return h.toFixed(2);
}

export function printTimesheet(args: {
  personName: string;
  periodLabel: string;
  shifts: TimeShift[];
  regular: number;
  overtime: number;
  doubleTime: number;
}) {
  const { personName, periodLabel, shifts, regular, overtime, doubleTime } = args;
  const byDay = new Map<string, TimeShift[]>();
  for (const s of [...shifts].sort((a, b) => a.clock_in_at.localeCompare(b.clock_in_at))) {
    const d = punchDay(s.clock_in_at);
    const arr = byDay.get(d);
    if (arr) arr.push(s);
    else byDay.set(d, [s]);
  }

  let body = "";
  let total = 0;
  let breakTotal = 0;
  for (const [day, list] of byDay) {
    const label = new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    body += `<tr class="day"><td colspan="8">${esc(label)}</td></tr>`;
    let dayTotal = 0;
    for (const s of list) {
      const h = shiftHours(s);
      dayTotal += h;
      breakTotal += (s.break_seconds ?? 0) / 3600;
      body += `<tr>
        <td></td>
        <td>${t(s.clock_in_at)}</td>
        <td>${t(s.clock_out_at)}</td>
        <td class="num">${s.break_seconds ? Math.round(s.break_seconds / 60) + "m" : "—"}</td>
        <td class="num">${hrs(h)}</td>
        <td>${esc(s.projects?.job_code ?? "—")}</td>
        <td>${esc(s.cost_codes ? `${s.cost_codes.code} · ${s.cost_codes.label}` : "—")}</td>
        <td class="note">${esc(s.note ?? "")}</td>
      </tr>`;
    }
    total += dayTotal;
    body += `<tr class="subtotal"><td colspan="4">Daily total</td><td class="num">${hrs(dayTotal)}</td><td colspan="3"></td></tr>`;
  }

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(personName)} — ${esc(periodLabel)}</title>
<style>
  body { font: 12px/1.45 -apple-system, "Segoe UI", sans-serif; color: #111; margin: 32px; }
  h1 { font-size: 18px; margin: 0; }
  .sub { color: #666; margin: 2px 0 16px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
       color: #666; border-bottom: 1.5px solid #333; padding: 4px 6px; }
  td { padding: 4px 6px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  th.num { text-align: right; }
  tr.day td { border-left: 3px solid #e2542c; background: #faf5f2; font-weight: 700; }
  tr.subtotal td { font-weight: 600; color: #444; background: #fafafa; }
  .totals { margin-top: 16px; width: 280px; margin-left: auto; }
  .totals td { border: none; padding: 2px 6px; }
  .totals .grand td { border-top: 1.5px solid #333; font-weight: 700; }
  .sig { margin-top: 48px; display: flex; gap: 48px; }
  .sig div { flex: 1; border-top: 1px solid #333; padding-top: 4px; color: #666; font-size: 11px; }
  .legend { margin-top: 24px; color: #888; font-size: 10.5px; }
  @media print { body { margin: 12px; } }
</style></head><body>
<h1>${esc(personName)} — Timesheet</h1>
<p class="sub">${esc(periodLabel)} · Forge Windows</p>
<table>
  <thead><tr>
    <th>Date</th><th>Start</th><th>End</th><th class="num">Break</th>
    <th class="num">Paid&nbsp;h</th><th>Job</th><th>Cost code</th><th>Notes</th>
  </tr></thead>
  <tbody>${body}</tbody>
</table>
<table class="totals">
  <tr><td>Regular</td><td class="num">${hrs(regular)}</td></tr>
  <tr><td>Overtime</td><td class="num">${hrs(overtime)}</td></tr>
  ${doubleTime > 0 ? `<tr><td>Double time</td><td class="num">${hrs(doubleTime)}</td></tr>` : ""}
  <tr><td>Unpaid breaks</td><td class="num">${hrs(breakTotal)}</td></tr>
  <tr class="grand"><td>Total paid</td><td class="num">${hrs(total)}</td></tr>
</table>
<div class="sig">
  <div>Employee signature / date</div>
  <div>Supervisor signature / date</div>
</div>
<p class="legend">Paid hours exclude breaks. Overtime split per company rule
(weekly threshold). Adjusted punches carry a full audit trail in the app.</p>
<script>window.print()</script>
</body></html>`;

  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(html);
  w.document.close();
}
