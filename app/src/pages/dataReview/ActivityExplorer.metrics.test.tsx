// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ActivityExplorer } from "./ActivityExplorer";

vi.mock("./useReportShifts", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  const { reportShifts } = await import("./reportQueries");
  return { useReportShifts: (...args: Parameters<typeof reportShifts>) => useQuery(reportShifts(...args)) };
});
vi.mock("./chartContext", () => ({ useCharts: () => null }));
vi.mock("./FloatingCharts", () => ({ FloatingCharts: ({ children }: { children: React.ReactNode }) => children, ChartSlot: ({ children }: { children: React.ReactNode }) => children, useCharts: () => null }));
vi.mock("./historicalLabor", async importOriginal => ({ ...await importOriginal<typeof import("./historicalLabor")>(), readHistoricalLabor: vi.fn() }));
vi.mock("../../lib/api", () => ({ listProjectsAnyStatus: vi.fn() }));
vi.mock("../../lib/customWork/api", () => ({ listWorkSessions: vi.fn(), listWorkUnits: vi.fn() }));
vi.mock("../../lib/install/api", () => ({ listProfiles: vi.fn() }));
vi.mock("../../lib/signedIn", () => ({ signInMark: () => ({ userId: "owner" }) }));
vi.mock("./reportControls", async importOriginal => ({ ...await importOriginal<typeof import("./reportControls")>(), denverToday: () => "2026-10-23" }));
vi.mock("@tanstack/react-query", () => ({
  useQueries: () => [],
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    const session = (id: string, unit: string | null, duration: number, stage = "Installing") => ({
      id, profile_id: "person", project_id: "job", unit_id: unit, kind: unit ? "unit" : "idle", stage,
      description: unit ? "" : "Hauling", started_at: "2026-10-20T12:00:00Z",
      ended_at: new Date(Date.parse("2026-10-20T12:00:00Z") + duration * 1000).toISOString(), revision: 1,
    });
    return { data: queryKey[2] === "units" ? [
      { id: "u1", opening_id: "o1", project_id: "job", label: "1", facts: { width_in: 24, height_in: 12, story: "1" } },
      { id: "u2", opening_id: "o2", project_id: "job", label: "2", facts: { story: "1" } },
    ] : queryKey[2] === "openingReview" ? new Map() : (queryKey[2] === "historical" || queryKey[2] === "clockedShifts") ? [] : queryKey[2] === "projects" ? [{ id: "job", job_code: "JOB" }] : queryKey[2] === "people" ? [] : [
      session("a", "u1", 120), session("b", "u1", 60, "Flashing"), session("c", "u2", 180), session("g", null, 60),
    ], isPending: false };
  },
}));

it("switches chart metrics with explicit coverage and keeps General rates unavailable", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<ActivityExplorer />); });
    const metric = [...host.querySelectorAll("select")].find(select => select.closest("label")?.textContent?.startsWith("Metric"))!;
    const change = async (select: HTMLSelectElement, value: string) => {
      await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
    };
    expect(metric.value).toBe("hours");
    const chartControls = host.querySelector('.report-chart-grouping')!;
    expect(chartControls).not.toBeNull();
    for (const label of ["Person", "Job", "Unit category", "Operation", "Configuration", "System", "Material"]) {
      expect(chartControls.querySelector(`[aria-label="Group by ${label}"]`)).not.toBeNull();
    }
    await act(async () => chartControls.querySelector<HTMLButtonElement>('[aria-label="Group by Material"]')!.click());
    expect(host.querySelector('.activity-comparison-title')?.textContent).toBe("Material");
    expect(host.querySelector('.activity-bars')?.textContent).toContain("Unknown");
    await act(async () => chartControls.querySelector<HTMLButtonElement>('[aria-label="Group by Material"]')!.click());

    const history = host.querySelector('[aria-label="Job labor history"]')!;
    expect(history.querySelector(".weekly-columns")).not.toBeNull();
    expect(history.textContent).toContain("Unit-linked work \u00b7 Installing");
    expect(history.textContent).toContain("Job-level work \u00b7 Hauling");
    expect(host.querySelector('[aria-label="Job-level work"]')?.textContent).not.toContain("Installing");

    expect(host.querySelector(".activity-total")?.textContent).toContain("0.12");
    await change(metric, "area");
    expect(host.querySelector(".activity-total")?.textContent).toContain("1.500");
    expect(host.querySelector(".activity-metric-coverage")?.textContent).toContain("1 linked openings have missing");
    expect(host.querySelector(".activity-metric-coverage")?.textContent).toContain("unverified");
    const mix = host.querySelector('[aria-label="Labor mix"]')!;
    expect(mix.textContent).toContain("1.000 min/ft²");
    expect(mix.textContent).toContain("0.500 min/ft²");
    expect(mix.textContent).toContain("— min/ft²");
    await change(metric, "opening");
    expect(host.querySelector(".activity-total")?.textContent).toContain("3.00");
    expect(host.querySelector('input[placeholder="Search data…"]')).toBeNull();
    expect(host.querySelector('[aria-label="Group by Unit"]')).toBeNull();
    expect([...host.querySelectorAll('button')].some(button => button.textContent === "Arrange" || button.textContent === "Totals")).toBe(false);
    expect(host.querySelector('[aria-label="Group by Job"]')).not.toBeNull();
    expect(host.querySelector(".report-records-header")?.contains(host.querySelector('[aria-label="Group by Job"]'))).toBe(true);
    expect(host.querySelector('[aria-label="Group by Work attribution"]')).not.toBeNull();
    expect(host.querySelector('.dimension-scope-controls')).toBeNull();
    expect(host.querySelector('[aria-label="Labor mix"]')?.textContent).toContain("Job-level work");
    const personGroup = host.querySelector<HTMLButtonElement>('[aria-label="Group by Person"]')!;
    const floorGroup = host.querySelector<HTMLButtonElement>('[aria-label="Group by Floor"]')!;
    await act(async () => { personGroup.click(); });
    await act(async () => { floorGroup.click(); });
    expect(host.querySelector('.dimension-heading')?.textContent).toContain("Floor → Person");
    await act(async () => { host.querySelector<HTMLElement>('[aria-label="Reorder Person"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
    expect(host.querySelector('.dimension-heading')?.textContent).toContain("Person → Floor");
    expect(host.querySelectorAll('input[type="date"]')).toHaveLength(0);
    const range = host.querySelector<HTMLSelectElement>('.report-range select')!;
    await change(range, "week");
    expect(host.textContent).toContain("inclusive local dates");
    expect(host.querySelector('.report-date-presets')).toBeNull();
    await change(range, "custom");
    expect(host.querySelectorAll('input[type="date"]')).toHaveLength(2);
    await change(range, "all");
    expect(host.querySelectorAll('input[type="date"]')).toHaveLength(0);
    expect(host.querySelector('.activity-total')?.textContent).toContain("3.00");
  } finally {
    await act(async () => { root.unmount(); }); host.remove();
  }
});


it("unit area filters affect unit charts and records while preserving Job-level work", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<ActivityExplorer />); });
    const area = host.querySelector('[aria-label="Select Unit area"]')!.closest("details")!;
    const unknown = [...area.querySelectorAll("label")].find(label => label.textContent === "0–25 ft²")!.querySelector("input")!;
    await act(async () => { unknown.click(); });
    expect(host.querySelector(".activity-total")?.textContent).toContain("3 records");
    expect(host.querySelector('[aria-label="Labor mix"]')?.textContent).toContain("Job-level work \u00b7 Hauling");
    expect(host.querySelector('[aria-label="Unit labor"]')?.textContent).not.toContain("Unit 2");
    await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === "Clear unit filters")!.click(); });
    expect(host.querySelector(".activity-total")?.textContent).toContain("4 records");
    expect(host.querySelector('[aria-label="Unit labor"]')?.textContent).toContain("Unit 2");
  } finally { await act(async () => root.unmount()); host.remove(); }
});


it("keeps General chart controls local and opens contributing weekly records", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<ActivityExplorer />); });
    const chart = host.querySelector('[aria-label="Job-level work"]')!;
    const controls = chart.querySelectorAll("select");
    await act(async () => { controls[0].value = "weekly"; controls[0].dispatchEvent(new Event("change", { bubbles: true })); chart.querySelector<HTMLButtonElement>('[aria-label="Chart format"] button:last-child')!.click(); });
    expect(chart.textContent).toContain("100%");
    expect(host.querySelector<HTMLSelectElement>(".activity-metric select")?.value).toBe("hours");
    await act(async () => { chart.querySelector<HTMLButtonElement>(".general-chart-bar")!.click(); });
    expect(host.querySelector('[aria-controls="activity-record-table"]')).toBeNull();
    expect(host.querySelector<HTMLDetailsElement>(".activity-partial-evidence")?.open).toBe(true);
    expect(host.querySelector("#activity-record-table")?.textContent).toContain("Hauling");
    expect(host.querySelector("#activity-record-table")?.textContent).not.toContain("Installing");
    await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === "Clear selection")!.click(); });
    expect(host.querySelector("#activity-record-table")?.textContent).toContain("Installing");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
