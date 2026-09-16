import { describe, expect, it } from "vitest";
import type { TimeShift } from "./timeclock";
import { buildTimeEntriesCsv, buildTimeEntryRows, durationText, timeEntriesHtml } from "./timeEntryExport";
const shift = (over: Partial<TimeShift> = {}): TimeShift => ({
  id: "shift-1", profile_id: "person-1", project_id: "job-1", cost_code_id: "code-1",
  clock_in_at: "2026-09-01T13:00:00Z", clock_out_at: "2026-09-01T21:30:00Z",
  break_seconds: 1800, break_started_at: null, injured: null, time_confirmed: null,
  status: "submitted", created_at: "2026-09-01T13:00:00Z", note: "Installed frames",
  profiles: { display_name: "Alex Rivera Diaz" }, projects: { job_code: "JOB-1", name: "River home" },
  cost_codes: { code: "1", label: "Installation" }, ...over,
});
describe("detailed time-entry exports", () => {
  it("matches the supplied entry columns and preserves breaks, minutes, descriptions and status", () => {
    const [header, row] = buildTimeEntryRows([shift()], "America/Denver");
    expect(header.slice(0, 15)).toEqual(["Employee Id", "First Name", "Last Name", "Start", "End", "Break", "Total", "Customer", "Project Number", "Project", "Cost Code", "Cost Code Desc.", "Equipment", "Add-Ons", "Description"]);
    expect(row).toEqual(["person-1", "Alex", "Rivera Diaz", "2026-09-01 07:00", "2026-09-01 15:30", "00:30", "08:00", "", "JOB-1", "River home", "1", "Installation", "", "", "Installed frames", "submitted", "America/Denver"]);
  });
  it("excludes removed and unfinished punches, and retains a rejected entry's status", () => {
    const rows = buildTimeEntryRows([shift({ status: "voided" }), shift({ clock_out_at: null, status: "open" }), shift({ status: "rejected" })], "America/Denver");
    expect(rows).toHaveLength(2); expect(rows[1][15]).toBe("rejected");
  });
  it("preserves original imported identity and unassigned project without guessing a Forge job", () => {
    const imported = shift({ project_id: null, projects: null, source_import: { source: "busybusy", file: "source.csv", row: 2, timeZone: "America/Denver", original: { "First Name": "Alex", "Last Name": "Rivera Diaz", Project: "New site", Customer: "Builder", Equipment: "Lift" } } });
    const row = buildTimeEntryRows([imported], "America/Denver")[1];
    expect(row[8]).toBe(""); expect(row[9]).toBe("New site"); expect(row[12]).toBe("Lift");
    expect(row[14]).toContain("STG project awaiting assignment: New site");
  });
  it("keeps seconds and overnight dates; durations never wrap after 24 hours", () => {
    const row = buildTimeEntryRows([shift({ clock_in_at: "2026-09-02T04:00:15Z", clock_out_at: "2026-09-02T08:00:45Z", break_seconds: 0 })], "America/Denver")[1];
    expect(row.slice(3, 7)).toEqual(["2026-09-01 22:00:15", "2026-09-02 02:00:45", "00:00", "04:00:30"]);
    expect(durationText(388 * 3600 + 28 * 60)).toBe("388:28");
  });
  it("escapes quoted multiline notes and neutralizes spreadsheet formulas", () => {
    const csv = buildTimeEntriesCsv([shift({ note: '=HYPERLINK("bad")\nsecond line' })], "America/Denver");
    expect(csv.startsWith("\uFEFFEmployee Id,")).toBe(true);
    expect(csv).toContain('"\'=HYPERLINK(""bad"")\nsecond line"');
  });
  it("creates a branded printable report, escapes HTML and keeps names with distinct IDs separate", () => {
    const html = timeEntriesHtml([shift({ note: "<script>bad()</script>" }), shift({ id: "shift-2", profile_id: "person-2" })], "Sep 1–4", "America/Denver");
    expect(html).toContain("FORGE WINDOWS &amp; DOORS");
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(html.match(/<section>/g)).toHaveLength(2);
    expect(html).toContain("Total recorded time: 16:00");
    expect(html).not.toContain("<script>bad()");
  });
});
