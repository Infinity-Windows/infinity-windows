// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { UnitLaborReview } from "./UnitLaborReview";
import type { ActivityRow } from "./activityRows";
import type { WorkUnit } from "../../lib/customWork/model";
it("opens unit facts, contributors and activity allocations without implying a valid baseline", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const unit = { id: "u", opening_id: "o", project_id: "j", type_label: "Fixed", facts: { material: "Aluminum", width_in: 24, height_in: 24 } } as WorkUnit;
  const rows = [{ id: "r", unitId: "u", openingId: "o", jobId: "j", job: "JOB", unit: "1", personId: "p", person: "Sam", activity: "Flashing", scope: "Specific", seconds: 600, started: "2026-10-01T12:00:00Z", ended: "2026-10-01T12:10:00Z" }] as ActivityRow[];
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), inspect = vi.fn();
  try {
    await act(async () => root.render(<UnitLaborReview rows={rows} units={[unit]} onInspect={inspect} />));
    expect(host.textContent).toContain("1 need more evidence");
    await act(async () => host.querySelector<HTMLButtonElement>(".unit-review-row")!.click());
    const panel = host.querySelector('[aria-label="Unit labor inspection"]')!;
    expect(panel.textContent).toContain("Insufficient evidence");
    expect(panel.textContent).toContain("Sam");
    expect(panel.textContent).toContain("Flashing");
    expect(panel.textContent).toContain("Aluminum");
    expect(panel.textContent).toContain("100.0%");
    await act(async () => panel.querySelector<HTMLButtonElement>(".activity-inspect-records")!.click());
    expect(inspect).toHaveBeenCalledWith(["r"]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
