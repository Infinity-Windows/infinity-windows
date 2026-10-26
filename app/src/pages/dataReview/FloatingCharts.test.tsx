import { useCharts } from "./chartContext";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { FloatingCharts, ChartSlot } from "./FloatingCharts";
import { ActivityAccordion } from "./ActivityAccordion";
import type { ActivityRow } from "./activityRows";
import { laborMetricContext } from "./laborMetrics";

const rows = [
  { id: "a", floor: "1", activity: "Install", scope: "Specific", personId: "p", seconds: 600 },
  { id: "b", floor: "1", activity: "Flash", scope: "Specific", personId: "p", seconds: 1200 },
] as ActivityRow[];
function Workspace() {
  const charts = useCharts()!;
  const ids = new Set(charts.scopes.flatMap(scope => scope.ids));
  return <>
    <ActivityAccordion rows={rows} order={["floor", "activity"]} metric="hours" context={laborMetricContext(rows, [], "hours")} />
    <ChartSlot view="mix"><p>Unique records: {ids.size}</p></ChartSlot>
    <ChartSlot view="units"><p>Unit view</p></ChartSlot></>;
}
it("cascades group selection to descendants, reflects partial selection, and preserves expansion and chart views", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const render = async (active = true) => act(async () => root.render(<FloatingCharts active={active}><Workspace /></FloatingCharts>));
  try {
    await render();
    const floor = host.querySelector<HTMLButtonElement>('[aria-label="Expand Floor · 1"]')!;
    expect(host.querySelector('.report-selection-bar')).toBeNull();
    expect(host.querySelector('[aria-label="Chart Floor · 1"]')).toBeNull();
    await act(async () => host.querySelector<HTMLInputElement>('[aria-label="Select Floor · 1"]')!.click());
    expect(floor.getAttribute("aria-expanded")).toBe("false");
    await act(async () => floor.click());
    const parent = host.querySelector<HTMLInputElement>('[aria-label="Select Floor · 1"]')!;
    const child = host.querySelector<HTMLInputElement>('[aria-label="Select Activity · Install"]')!;
    expect(child.checked).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Expand Activity · Install"]')!.click());
    const record = host.querySelector<HTMLInputElement>('[aria-label="Select record a"]')!;
    expect(record.checked).toBe(true);
    expect(host.querySelector('.activity-record-table thead input[type="checkbox"]')).toBeNull();
    await act(async () => record.click());
    expect(parent.checked).toBe(false);
    expect(parent.indeterminate).toBe(true);
    expect(child.checked).toBe(false);
    await act(async () => child.click());
    expect(parent.checked).toBe(true);
    expect(record.checked).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('.report-selection-bar button')!.click());
    expect(host.querySelectorAll('[role="dialog"][aria-label="Report charts"]')).toHaveLength(1);
    expect(host.querySelector(".report-chart-content")?.textContent).toBe("Unique records: 2");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Expand charts"]')!.click());
    expect(host.querySelector(".report-charts-expanded")).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Restore chart size"]')!.click());
    expect(host.querySelector(".report-charts-expanded")).toBeNull();
    const view = host.querySelector<HTMLSelectElement>('[aria-label="Chart view"]')!;
    await act(async () => { view.value = "units"; view.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.querySelector(".report-chart-content")?.textContent).toBe("Unit view");
    expect(floor.getAttribute("aria-expanded")).toBe("true");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close charts"]')!.click());
    const all = host.querySelector<HTMLInputElement>('[aria-label="Select all activity groups"]')!;
    expect(all.checked).toBe(true);
    await act(async () => all.click());
    expect(host.querySelector('.report-selection-bar')).toBeNull();
    await act(async () => all.click());
    expect(all.checked).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('.report-selection-bar button')!.click());
    expect(host.querySelector(".report-chart-content")?.textContent).toBe("Unique records: 2");
    await render(false);
    expect(host.querySelector('[role="dialog"][aria-label="Report charts"]')).toBeNull();
    expect(floor.getAttribute("aria-expanded")).toBe("true");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("keeps individual record selection without a detail-header select-all", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<FloatingCharts><ActivityAccordion rows={rows} order={[]} metric="hours" context={laborMetricContext(rows, [], "hours")} /></FloatingCharts>));
    expect(host.querySelector('thead input[type="checkbox"]')).toBeNull();
    const first = host.querySelector<HTMLInputElement>('[aria-label="Select record a"]')!;
    await act(async () => first.click());
    expect(first.checked).toBe(true);
    expect(host.querySelector('.report-selection-bar')).not.toBeNull();
    await act(async () => first.click());
    expect(first.checked).toBe(false);
    expect(host.querySelector('.report-selection-bar')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

function UnifiedWorkspace() {
  const charts = useCharts()!;
  return <><button onClick={() => charts.show("clocked")}>Open labor</button><button onClick={() => { charts.setLaborAxis("relative"); charts.setLaborWeeks(4); }}>Set relative window</button>
    <ChartSlot view="clocked"><p>Clocked content · {charts.laborMeasure} · {charts.laborAxis}/{charts.laborWeeks}</p></ChartSlot>
    <ChartSlot view="weeklyUnitRates"><p>Timer content · {charts.laborMeasure} · {charts.laborAxis}/{charts.laborWeeks}</p></ChartSlot></>;
}
it("combines labor sources in one view, enforces rate eligibility and preserves the time window", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  const change = async (label: string, value: string) => act(async () => { const select = host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
  try {
    await act(async () => root.render(<FloatingCharts><UnifiedWorkspace /></FloatingCharts>));
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Open labor")!.click());
    const view = host.querySelector<HTMLSelectElement>('[aria-label="Chart view"]')!;
    expect([...view.options].map(option => option.textContent)).toContain("Labor over time");
    expect(view.querySelector('[value="weeklyUnitRates"]')).toBeNull();
    expect(host.querySelector<HTMLOptionElement>('[aria-label="Labor measure"] option[value="area"]')?.disabled).toBe(true);
    await change("Labor measure", "area");
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Labor measure"]')?.value).toBe("hours");
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Set relative window")!.click());
    await change("Labor source", "timers"); await change("Labor measure", "opening");
    expect(host.querySelector('.report-chart-content')?.textContent).toContain("Timer content · opening · relative/4");
    expect(host.querySelector('.report-chart-content')?.textContent).not.toContain("Clocked content");
    await change("Labor source", "clocked");
    expect(host.querySelector('.report-chart-content')?.textContent).toContain("Clocked content · hours · relative/4");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
