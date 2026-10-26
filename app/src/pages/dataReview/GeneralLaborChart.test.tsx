// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { weeklyScale } from "./generalLabor";
import { GeneralLaborChart } from "./GeneralLaborChart";
import type { ActivityRow } from "./activityRows";

it("stacks activities on a shared scale and inspects only a segment's weekly records", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), inspect = vi.fn();
  const rows = [
    { id: "a", activity: "Cleanup", scope: "General", jobId: "j", started: "2026-10-19T06:00:00Z", ended: "2026-10-19T07:00:00Z" },
    { id: "b", activity: "Problem solving", scope: "General", jobId: "j", started: "2026-10-19T07:00:00Z", ended: "2026-10-19T10:00:00Z" },
  ] as ActivityRow[];
  try {
    await act(async () => root.render(<GeneralLaborChart rows={rows} from={-Infinity} until={Infinity} onInspect={inspect} jobStatuses={new Map([["j", "completed"]])} />));
    const controls = host.querySelectorAll("select");
    expect(controls[0].value).toBe("weekly");
    expect(host.querySelector('[aria-label="Hours axis"]')).not.toBeNull();
    expect(host.querySelector(".weekly-x-title")?.textContent).toContain("Monday");
    await act(async () => { controls[0].value = "weekly"; controls[0].dispatchEvent(new Event("change", { bubbles: true })); });
    const segments = host.querySelectorAll<HTMLButtonElement>(".general-week-segment");
    expect(segments).toHaveLength(2);
    expect(segments[0].style.height).toBe("25%");
    expect(segments[1].style.height).toBe("75%");
    await act(async () => segments[1].click());
    expect(inspect).toHaveBeenLastCalledWith(["b"], [Date.parse("2026-10-19T06:00:00Z"), Date.parse("2026-10-26T06:00:00Z")]);
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Chart format"] button')].find(button => button.textContent === "Percent")!.click());
    expect(host.querySelector(".weekly-column-total")?.textContent).toContain("100%");
    expect(host.querySelector<HTMLButtonElement>(".general-week-segment")?.style.height).toBe("25%");
    expect(host.querySelectorAll(".general-week-details button")).toHaveLength(2);
    await act(async () => { controls[2].value = "active"; controls[2].dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.textContent).toContain("No recorded Job-level work");
    await act(async () => { controls[2].value = "completed"; controls[2].dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.querySelectorAll(".general-week-segment")).toHaveLength(2);
  } finally { await act(async () => root.unmount()); host.remove(); }
});


it("keeps the hours scale above recorded totals, including very small visits", () => {
  for (const hours of [.00001, .03, .7, 4, 7, 234]) expect(weeklyScale(hours)).toBeGreaterThanOrEqual(hours);
  expect(weeklyScale(0)).toBe(1);
  expect(weeklyScale(4)).toBe(4);
});
