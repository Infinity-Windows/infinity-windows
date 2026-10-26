// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WeeklyUnitRates } from "./WeeklyUnitRateChart";
import { midnight } from "./generalLabor";
import type { ActivityRow } from "./activityRows";
import type { WorkUnit } from "../../lib/customWork/model";
const units = [{ id: "u", opening_id: "o", project_id: "j", facts: { width_in: 12, height_in: 12 } }] as WorkUnit[];
const rows = ["Install", "Flash"].map((activity, index) => ({ id: String(index), activity, scope: "Specific", personId: String(index), person: index ? "Lee" : "Sam", jobId: "j", job: "J", unitId: "u", unit: "1", started: "2026-10-20T12:00:00Z", ended: "2026-10-20T12:01:00Z", seconds: 60 })) as ActivityRow[];
it("filters activity and recorded person, fits weeks without medians, and inspects the selected week only", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"), root = createRoot(host), inspect = vi.fn();
  try {
    await act(async () => root.render(<WeeklyUnitRates rows={rows} units={units} from={midnight("2026-10-19")} until={midnight("2026-10-26")} onInspect={inspect} />));
    expect(host.querySelector(".unit-rate-plot circle")?.getAttribute("aria-label")).toContain("2.000 min/ft²");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Weekly included activities"] button')!.click());
    expect(host.querySelector(".unit-rate-plot circle")?.getAttribute("aria-label")).toContain("1.000 min/ft²");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Weekly included activities"] button')!.click());
    await act(async () => host.querySelector<HTMLElement>('summary[aria-label="Select Recorded people"]')!.click());
    expect(host.querySelector('[aria-label="Weekly rate scale"]')).toBeNull();
    expect(host.querySelector('.weekly-rate-median')).toBeNull();
    expect(host.querySelector('.weekly-unit-scroll')).toBeNull();
    const person = [...host.querySelectorAll<HTMLInputElement>('.report-multi-options input')].find(input => input.parentElement?.textContent?.includes("Sam"))!;
    await act(async () => person.click());
    expect(host.querySelector(".unit-rate-plot circle")?.getAttribute("aria-label")).toContain("Sam");
    expect(host.querySelector(".unit-rate-plot circle")?.getAttribute("aria-label")).not.toContain("Lee");
    expect(host.querySelector('.weekly-rate-median')).toBeNull();
    await act(async () => host.querySelector(".unit-rate-plot circle")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Inspect records")!.click());
    expect(inspect).toHaveBeenCalledWith(["0"], [midnight("2026-10-19"), midnight("2026-10-26")]);
  } finally { await act(async () => root.unmount()); }
});

it("labels relative weeks while drilling into the real job-week dates", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"), root = createRoot(host), inspect = vi.fn();
  try {
    await act(async () => root.render(<WeeklyUnitRates rows={rows} units={units} from={-Infinity} until={Infinity} relative={{ anchors: new Map([["j", "2026-10-13"]]), count: 4 }} onInspect={inspect} />));
    const dot = host.querySelector(".unit-rate-plot circle")!;
    expect(dot.getAttribute("aria-label")).toContain("Week 2 (from 2026-10-20)");
    await act(async () => dot.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Inspect records")!.click());
    expect(inspect).toHaveBeenCalledWith(["0", "1"], [midnight("2026-10-20"), midnight("2026-10-27")]);
  } finally { await act(async () => root.unmount()); }
});
