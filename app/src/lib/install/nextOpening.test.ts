import { describe, expect, it } from "vitest";
import { pickNextOpening, toDispatchOpening } from "./nextOpening";
import type { ProjectOpening } from "./types";

// Minimal opening factory. Defaults produce a fully-ready opening (unit
// assigned + matching type + fits + undamaged + staged) so tests only override
// what they care about.
function opening(p: Partial<ProjectOpening> & { id: string }): ProjectOpening {
  return {
    project_id: "proj-1",
    planset_id: null,
    opening_code: p.id.toUpperCase(),
    window_type_id: "type-a",
    label: null,
    page_number: 1,
    pin_x: null,
    pin_y: null,
    assigned_window_id: "unit-1",
    status: "pending",
    confirmed: false,
    created_at: "2026-07-17T00:00:00Z",
    ro_width_in: 25,
    ro_height_in: 37,
    ro_measured_by: null,
    ro_measured_at: null,
    condition: "ok",
    condition_note: null,
    condition_checked_by: null,
    condition_checked_at: null,
    assigned_to: "me",
    assigned_by: null,
    assigned_at: null,
    sequence: null,
    work_started_at: null,
    work_ended_at: null,
    flag_note: null,
    flagged_by: null,
    flagged_at: null,
    window_types: { width_in: 24, height_in: 36 } as never,
    windows: { window_type_id: "type-a", status: "staged" } as never,
    ...p,
  } as ProjectOpening;
}

describe("toDispatchOpening", () => {
  it("marks a fully-satisfied opening ready and a damaged one blocked", () => {
    expect(toDispatchOpening(opening({ id: "a" })).ready).toBe(true);
    const dmg = toDispatchOpening(opening({ id: "b", condition: "damaged" }));
    expect(dmg.blocked).toBe(true);
    expect(dmg.ready).toBe(false);
  });

  it("derives area from label, falling back to page", () => {
    expect(toDispatchOpening(opening({ id: "a", label: "Kitchen" })).area).toBe(
      "Kitchen",
    );
    expect(toDispatchOpening(opening({ id: "a", page_number: 3 })).area).toBe(
      "page 3",
    );
  });
});

describe("pickNextOpening", () => {
  it("returns null when nothing is left", () => {
    expect(pickNextOpening([])).toBeNull();
    expect(
      pickNextOpening([opening({ id: "done", status: "installed" })]),
    ).toBeNull();
  });

  it("skips the just-completed opening", () => {
    const next = pickNextOpening(
      [opening({ id: "a", sequence: 0 }), opening({ id: "b", sequence: 1 })],
      "a",
    );
    expect(next?.id).toBe("b");
  });

  it("prefers a ready opening over an incomplete one", () => {
    const next = pickNextOpening([
      // incomplete: no unit assigned, lands earlier in sequence
      opening({ id: "incomplete", sequence: 0, assigned_window_id: null }),
      opening({ id: "ready", sequence: 5 }),
    ]);
    expect(next?.id).toBe("ready");
  });

  it("respects sequence among equally-ready openings", () => {
    const next = pickNextOpening([
      opening({ id: "second", sequence: 2 }),
      opening({ id: "first", sequence: 1 }),
    ]);
    expect(next?.id).toBe("first");
  });

  it("never returns an installed opening even if it sorts first", () => {
    const next = pickNextOpening([
      opening({ id: "done", sequence: 0, status: "installed" }),
      opening({ id: "todo", sequence: 1 }),
    ]);
    expect(next?.id).toBe("todo");
  });

  it("skips a session-blocked opening even if it sorts first (grilled Q4)", () => {
    const next = pickNextOpening(
      [opening({ id: "stuck", sequence: 0 }), opening({ id: "free", sequence: 1 })],
      undefined,
      new Set(["stuck"]),
    );
    expect(next?.id).toBe("free");
  });
});
