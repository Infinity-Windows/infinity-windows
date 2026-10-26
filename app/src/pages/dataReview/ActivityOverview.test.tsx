// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ActivityOverview } from "./ActivityOverview";
import type { ActivityRow } from "./activityRows";

it("expands an activity, aligns job trends, preserves denominators, and inspects its records", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const row = (id: string, job: string, activity: string, hours: number, date: string, scope = "General") => ({ id, jobId: job, job, activity, scope, seconds: hours * 3600, started: `${date}T06:00:00Z`, ended: new Date(Date.parse(`${date}T06:00:00Z`) + hours * 3600000).toISOString() }) as ActivityRow;
  const rows = [row("p1", "A", "Problem solving", 2, "2026-10-05"), row("i1", "A", "Install", 2, "2026-10-05", "Specific"), row("p2", "B", "Problem solving", 1, "2026-10-19"), row("c2", "B", "Cleanup", 3, "2026-10-19")];
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), inspect = vi.fn();
  try {
    await act(async () => root.render(<ActivityOverview rows={rows} from={-Infinity} until={Infinity} onInspect={inspect} />));
    expect(host.querySelector(".activity-investigation")).toBeNull();
    const problem = [...host.querySelectorAll<HTMLButtonElement>(".activity-overview-row")].find(button => button.textContent?.includes("Problem solving"))!;
    expect(problem.textContent).toContain("37.5%");
    await act(async () => problem.click());
    const controls = host.querySelectorAll<HTMLSelectElement>(".activity-investigation select");
    await act(async () => { controls[0].value = "percent"; controls[0].dispatchEvent(new Event("change", { bubbles: true })); controls[1].value = "job"; controls[1].dispatchEvent(new Event("change", { bubbles: true })); });
    const series = host.querySelectorAll(".activity-job-series");
    expect(series).toHaveLength(2);
    expect(series[0].querySelectorAll(".weekly-column")).toHaveLength(3);
    expect(series[1].querySelectorAll(".weekly-column")).toHaveLength(3);
    expect(series[0].textContent).toContain("50%");
    expect(series[1].textContent).toContain("25%");
    await act(async () => series[0].querySelector<HTMLButtonElement>(".general-week-segment")!.click());
    expect(inspect).toHaveBeenLastCalledWith(["p1"], [Date.parse("2026-10-05T06:00:00Z"), Date.parse("2026-10-12T06:00:00Z")]);
    await act(async () => problem.click());
    expect(host.querySelector(".activity-investigation")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
