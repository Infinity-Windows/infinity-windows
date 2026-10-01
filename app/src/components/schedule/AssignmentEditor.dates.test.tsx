// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssignmentEditor } from "./AssignmentEditor";
import type { ScheduleAssignment } from "../../lib/schedule/types";

vi.mock("../voice/VoiceTextarea", () => ({
  VoiceTextarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));

const assignment: ScheduleAssignment = {
  id: "target", project_id: "job", kind: "install", delivery_id: null,
  start_date: "2026-10-01", end_date: "2026-10-03",
  start_time: "07:00", end_time: "15:00", status: "draft", color: null, note: null,
  created_by: null, published_at: null, created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  members: [{ profile_id: "crew", role: "installer", display_name: "Crew" }],
  project: { id: "job", job_code: "JOB", name: "Job", address: null },
};
let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  vi.unstubAllGlobals();
});

function mount(over: Partial<ScheduleAssignment> = {}) {
  const save = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<AssignmentEditor
    assignment={{ ...assignment, ...over }} projects={[]}
    crew={[{ id: "crew", display_name: "Crew", role: "installer", active: true, skill_level: 1 }]}
    others={[{ ...assignment, id: "other" }]}
    currentVehicleId="truck"
    vehicleBookings={[{ vehicle_id: "truck", assignment_id: "other", start_date: "2026-10-01", end_date: "2026-10-03" }]}
    horizon={{ from: "2026-09-01", to: "2026-12-31" }}
    onSave={save} onClose={() => {}}
  />));
  return save;
}
function button(text: string) {
  return [...host.querySelectorAll("button")].find(b => b.textContent === text)!;
}
function changeDate(index: number, value: string) {
  const field = host.querySelectorAll<HTMLInputElement>('input[type="date"]')[index];
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("assignment dates while editing", () => {
  it.each([0, 1])("keeps the editor open when date field %i is cleared, then saves a complete range", index => {
    const save = mount();
    expect(host.textContent).toContain("Double-booked");
    changeDate(index, "");
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.querySelectorAll<HTMLInputElement>('input[type="date"]')[index].value).toBe("");
    expect(button("Save changes").disabled).toBe(true);
    expect(host.textContent).not.toContain("Double-booked");
    act(() => button("Save changes").click());
    expect(save).not.toHaveBeenCalled();
    if (index === 0) expect(button("3d").disabled).toBe(true);
    changeDate(index, index === 0 ? "2026-10-01" : "2026-10-03");
    expect(button("Save changes").disabled).toBe(false);
    expect(host.textContent).toContain("Double-booked");
    act(() => button("Save changes").click());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ start_date: "2026-10-01", end_date: "2026-10-03" }));
  });

  it.each(["", "bad", "2026-02-30"])("keeps invalid loaded dates editable without saving: %s", date => {
    const save = mount({ start_date: date });
    expect(button("Save changes").disabled).toBe(true);
    expect(button("3d").disabled).toBe(true);
    act(() => button("Save changes").click());
    expect(save).not.toHaveBeenCalled();
  });

  it("preserves valid range normalization and duration shortcuts", () => {
    const save = mount();
    changeDate(0, "2026-10-05");
    expect(host.querySelectorAll<HTMLInputElement>('input[type="date"]')[1].value).toBe("2026-10-05");
    act(() => button("3d").click());
    act(() => button("Save changes").click());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ start_date: "2026-10-05", end_date: "2026-10-07" }));
  });
});
