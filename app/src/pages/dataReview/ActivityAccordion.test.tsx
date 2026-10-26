// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type { ActivityRow } from "./activityRows";
import type { WorkUnit } from "../../lib/customWork/model";
import { ActivityAccordion } from "./ActivityAccordion";
import { laborMetricContext } from "./laborMetrics";

const rows = [
  { id: "a", unitId: "u1", unit: "1", job: "Job", jobId: "j", floor: "1", activity: "Installing", scope: "Specific", person: "Sam", personId: "p1", seconds: 600 },
  { id: "b", unitId: "u1", unit: "1", job: "Job", jobId: "j", floor: "1", activity: "Flashing", scope: "Specific", person: "Sam", personId: "p1", seconds: 600 },
  { id: "c", unitId: "u2", unit: "2", job: "Job", jobId: "j", floor: "1", activity: "Installing", scope: "Specific", person: "Lee", personId: "p2", seconds: 1800 },
] as ActivityRow[];
const units = [{ id: "u1", opening_id: "o1", project_id: "j", facts: { width_in: 12, height_in: 12 } }, { id: "u2", opening_id: "o2", project_id: "j", facts: { width_in: 36, height_in: 12 } }] as WorkUnit[];

it("uses standard columns and retains distinct people and activity proportions when expanded", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<ActivityAccordion units={units} rows={rows.map(row => ({ ...row, person: "Sam" }))} order={["floor"]} metric="hours" context={laborMetricContext(rows, units, "hours")} />));
    expect([...host.querySelectorAll("thead th")].map(th => th.textContent)).toEqual(["Group", "Records", "Activity", "People", "Hours"]);
    const floor = host.querySelector("tbody tr")!;
    expect(floor.querySelector(".accordion-recorded-hours")?.textContent).toBe("0.83(12.500 min/ft²)");
    expect(floor.querySelector(".report-expand")?.textContent).toBe("▸1");
    expect(floor.querySelector(".report-expand")?.getAttribute("aria-label")).toBe("Expand Floor · 1");
    expect(floor.querySelector(".accordion-people")?.getAttribute("aria-label")).toBe("2 unique people");
    expect(floor.querySelector(".accordion-activity-mix")?.getAttribute("aria-label")).toContain("Missing attribution · Installing · 0.67 h · 80.0%");
    await act(async () => floor.querySelector<HTMLTableCellElement>('.accordion-recorded-hours')!.click());
    expect(floor.querySelector('.report-expand')?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => floor.querySelector<HTMLButtonElement>('.accordion-activity-mix')!.click());
    expect(floor.querySelector('.report-expand')?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => floor.querySelector<HTMLButtonElement>('.report-expand')!.click());
    expect(floor.querySelector('.report-expand')?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => floor.querySelector<HTMLTableCellElement>('.report-number')!.click());
    expect(floor.querySelector(".accordion-activity-mix")).not.toBeNull();
    expect(host.querySelectorAll(".activity-record-table tbody tr")).toHaveLength(3);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
it("recomputes rate subtotals and expands to the saved record table", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<ActivityAccordion units={units} rows={rows} order={["floor", "activity", "person"]} metric="area" context={laborMetricContext(rows, units, "area")} />));
    const floor = host.querySelector("tbody tr")!;
    expect([...host.querySelectorAll("thead th")].map(th => th.textContent)).toEqual(["Group", "Records", "Activity share", "Hours"]);
    expect(floor.textContent).toContain("12.500");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Expand Floor · 1"]')!.click());
    const installing = host.querySelector('[aria-label="Expand Activity · Installing"]')!.closest("tr")!;
    expect(installing.textContent).toContain("10.000");
    expect(floor.textContent).toContain("12.500");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Expand Activity · Installing"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Expand Person · Sam"]')!.click());
    const leaf = host.querySelector('.activity-record-table')!;
    expect(leaf.querySelectorAll('tbody tr')).toHaveLength(1);
    expect([...leaf.querySelectorAll("th button:not(.activity-table-columns)")].map(button => button.textContent?.replace(/[↑↓↕]/g, "").trim())).toEqual(["Unit", "Hours", "Job"]);
    await act(async () => leaf.querySelector<HTMLButtonElement>(".activity-table-columns")!.click());
    expect([...leaf.querySelectorAll("th")].some(th => th.textContent?.startsWith("Floor"))).toBe(false);
    expect(leaf.querySelector('.activity-record-hours')?.textContent).toBe("0.17(10.000 min/ft²)");
    await act(async () => root.render(<ActivityAccordion key="flat" rows={rows} order={[]} metric="hours" context={laborMetricContext(rows, units, "hours")} />));
    expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("shows classification unknowns and opens actual saved unit facts", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const unit = { ...units[0], label: "1", type_label: "Mark #1", facts: { material: "Aluminum", width_in: 12, height_in: 12 } } as WorkUnit;
  const records = [{ ...rows[0], category: null, subtype: null, unitRecord: unit }];
  try {
    await act(async () => root.render(<ActivityAccordion units={units} rows={records} order={[]} metric="hours" context={laborMetricContext(records, [unit], "hours")} />));
    expect([...host.querySelectorAll("th button:not(.activity-table-columns)")].map(button => button.textContent?.replace(/[↑↓↕]/g, "").trim())).toEqual(["Unit", "Activity", "Person", "Hours", "Job"]);
    const columnsButton = host.querySelector<HTMLButtonElement>('[aria-label="Show more columns"]')!;
    expect(columnsButton.closest('thead')).not.toBeNull();
    expect(columnsButton.closest('th')).toBe(host.querySelector('thead tr')?.lastElementChild);
    expect(columnsButton.textContent).toBe("");
    await act(async () => columnsButton.click());
    expect(columnsButton.getAttribute('aria-pressed')).toBe("true");
    expect(columnsButton.closest('th')).toBe(host.querySelector('thead tr')?.lastElementChild);
    const headings = [...host.querySelectorAll("th")].map(th => th.textContent);
    expect(headings.some(text => text?.startsWith("Scope"))).toBe(false);
    expect(headings.some(text => text?.startsWith("Category"))).toBe(true);
    expect(headings.some(text => text?.startsWith("Operation"))).toBe(true);
    expect(host.querySelector("tbody")?.textContent).toContain("Unknown");
    await act(async () => host.querySelector<HTMLButtonElement>(".report-unit-link")!.click());
    expect(host.querySelector("dialog")?.open).toBe(true);
    expect(host.querySelector("dialog")?.textContent).toContain("Aluminum");
    expect(host.querySelector("dialog")?.textContent).toContain("Mark #1");
    await act(async () => host.querySelector<HTMLButtonElement>("dialog button")!.click());
    expect(host.querySelector("dialog")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("hides Job only when it is grouped and restores it when grouping changes", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const records = [rows[0], { ...rows[1], jobId: "other", job: "Other job" }];
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<ActivityAccordion units={units} rows={records} order={["floor"]} metric="hours" context={laborMetricContext(records, units, "hours")} />));
    expect([...host.querySelectorAll("thead th")].map(th => th.textContent)).toEqual(["Group", "Job", "Records", "Activity", "People", "Hours"]);
    expect(host.querySelector(".report-job-cell")?.textContent).toBe("2 jobs");
    expect(host.querySelector(".report-job-cell")?.getAttribute("title")).toContain("Other job");
    await act(async () => root.render(<ActivityAccordion key="job-grouped" rows={records} order={["floor", "job"]} metric="hours" context={laborMetricContext(records, units, "hours")} />));
    expect([...host.querySelectorAll("thead th")].map(th => th.textContent)).toEqual(["Group", "Records", "Activity", "People", "Hours"]);
    expect(host.querySelector(".report-job-cell")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Expand Floor · 1"]')!.click());
    expect(host.querySelector('[aria-label="Expand Job · Job"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Expand Job · Other job"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Expand Job · Job"]')!.click());
    const leaf = host.querySelector('.activity-record-table')!;
    expect([...leaf.querySelectorAll("th button:not(.activity-table-columns)")].map(button => button.textContent?.replace(/[↑↓↕]/g, "").trim())).toEqual(["Unit", "Activity", "Person", "Hours"]);
    expect(host.querySelector('.report-leaf-row > td')?.getAttribute('colspan')).toBe("5");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("shows each activity's recorded-time share of its parent without a breakdown of other activities", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const records = [...rows, { ...rows[0], id:"other-floor", floor:"2", seconds:3000 }];
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<ActivityAccordion units={units} rows={records} order={["floor", "activity"]} metric="area" context={laborMetricContext(records, units, "area")} />));
    expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Expand Floor · 1"]')!.click());
    const bars = [...host.querySelectorAll('[role="progressbar"]')];
    expect(bars.map(bar => bar.getAttribute("aria-valuenow"))).toEqual(["20", "80"]);
    expect(bars[1].getAttribute("aria-label")).toContain("Floor · 1");
    expect(bars[1].getAttribute("aria-valuetext")).toContain("0.67 of 0.83 recorded activity hours");
    expect(host.querySelector('.accordion-activity-mix')).toBeNull();
    await act(async () => root.render(<ActivityAccordion key="global" rows={records} order={["activity"]} metric="hours" context={laborMetricContext(records, units, "hours")} />));
    expect([...host.querySelectorAll('[role="progressbar"]')].map(bar => bar.getAttribute("aria-valuenow"))).toEqual(["10", "90"]);
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toContain("Filtered activity work");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
