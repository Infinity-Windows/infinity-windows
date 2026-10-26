// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { UnitRateChart } from "./UnitRateChart";
import { unitRatePoints } from "./unitRatePoints";
import type { ActivityRow } from "./activityRows";
import type { WorkUnit } from "../../lib/customWork/model";
const units = [{ id: "u", opening_id: "o", project_id: "j", facts: { width_in: 24, height_in: 12 } }, { id: "u2", opening_id: "o2", project_id: "j2", facts: { width_in: 12, height_in: 12 } }] as WorkUnit[];
const row = (id: string, activity: string, seconds: number, jobId = "j", unitId = "u") => ({ id, activity, seconds, jobId, unitId, job: jobId, unit: unitId, scope: "Specific" } as ActivityRow);
const rows = [row("a", "Install", 120), row("b", "Flash", 60), row("c", "Install", 60, "j2", "u2")];
it("aggregates selected activity minutes once per opening and excludes missing or conflicting area", () => {
  const result = unitRatePoints([...rows, row("missing", "Install", 60, "j", "unknown")], units);
  expect(result.points.map(p => p.value)).toEqual([1.5, 1]);
  expect(result.unlinked).toBe(1);
  expect(unitRatePoints(rows, [...units, { ...units[0], id: "duplicate", facts: { width_in: 36, height_in: 12 } }]).excluded).toBe(1);
});
it("toggles activity numerators, colors jobs separately, and inspects only contributing records", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"), root = createRoot(host), inspect = vi.fn();
  try {
    await act(async () => root.render(<UnitRateChart rows={rows} units={units} onInspect={inspect} />));
    const dots = host.querySelectorAll("circle");
    expect(dots).toHaveLength(2); expect(dots[0].getAttribute("fill")).not.toBe(dots[1].getAttribute("fill"));
    const sort = host.querySelector<HTMLSelectElement>('[aria-label="Sort units"]')!;
    await act(async () => { sort.value = "high"; sort.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.querySelector("circle")?.getAttribute("aria-label")).toContain("1.500 min/ft²");
    const job = host.querySelector<HTMLButtonElement>('[aria-label="Included jobs"] button')!;
    await act(async () => job.click());
    expect(host.querySelectorAll("circle")).toHaveLength(1);
    expect(host.querySelector("circle")?.getAttribute("fill")).toBe(dots[1].getAttribute("fill"));
    await act(async () => job.click());
    await act(async () => { sort.value = "unit"; sort.dispatchEvent(new Event("change", { bubbles: true })); });
    const flash = [...host.querySelectorAll("button")].find(b => b.textContent === "Flash")!;
    await act(async () => flash.click());
    expect(host.querySelector("circle")?.getAttribute("aria-label")).toContain("1.000 min/ft²");
    await act(async () => host.querySelector("circle")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Inspect records")!.click());
    expect(inspect).toHaveBeenCalledWith(["a"]);
    await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Install")!.click());
    expect(host.textContent).toContain("No units with usable area");
  } finally { await act(async () => root.unmount()); }
});
