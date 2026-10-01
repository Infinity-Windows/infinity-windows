// Confirmed double-booking vs hours-need-review must render as visibly
// different notices (never the same red "this is a problem" styling), and
// the notice must reflect the CURRENT props — the editor re-renders with new
// start/end times on every keystroke, so a stale classification would be a
// trust bug, not just a cosmetic one.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssignmentEditor } from "./AssignmentEditor";
import type { Profile } from "../../lib/install/types";
import type { ScheduleAssignment } from "../../lib/schedule/types";

const CREW: Profile[] = [
  { id: "jordan", display_name: "Jordan", skill_level: 1, role: "installer", active: true },
];

function other(over: Partial<ScheduleAssignment>): ScheduleAssignment {
  return {
    id: "other",
    project_id: "p",
    kind: "install",
    delivery_id: null,
    start_date: "2026-10-01",
    end_date: "2026-10-01",
    start_time: null,
    end_time: null,
    status: "draft",
    color: null,
    note: null,
    created_by: null,
    published_at: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    members: [{ profile_id: "jordan", role: "installer", display_name: "Jordan" }],
    project: { id: "p", job_code: "SISTER", name: "Sister job", address: null },
    ...over,
  };
}

const HORIZON = { from: "2026-09-01", to: "2026-11-01" };

function markup(assignment: Partial<ScheduleAssignment>, others: ScheduleAssignment[]): string {
  const full: ScheduleAssignment = {
    id: "target",
    project_id: "q",
    kind: "install",
    delivery_id: null,
    start_date: "2026-10-01",
    end_date: "2026-10-01",
    start_time: null,
    end_time: null,
    status: "draft",
    color: null,
    note: null,
    created_by: null,
    published_at: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    members: [{ profile_id: "jordan", role: "installer", display_name: "Jordan" }],
    project: { id: "q", job_code: "DECK", name: "Deck job", address: null },
    ...assignment,
  };
  return renderToStaticMarkup(
    <AssignmentEditor
      assignment={full}
      projects={[]}
      crew={CREW}
      others={others}
      horizon={HORIZON}
      onSave={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("AssignmentEditor inline conflict notices", () => {
  it("shows the confirmed notice (not review) when both sides' hours are known and overlap", () => {
    const html = markup(
      { start_time: "12:00", end_time: "14:00" },
      [other({ start_time: "13:00", end_time: "17:00" })],
    );
    expect(html).toContain("sched-conflict-inline");
    expect(html).not.toContain("is-review");
    expect(html).toContain("Double-booked");
  });

  it("shows the review notice (not confirmed) when the other assignment's hours are unknown", () => {
    const html = markup(
      { start_time: "12:00", end_time: "14:00" },
      [other({ start_time: null, end_time: null })],
    );
    expect(html).toContain("is-review");
    expect(html).toContain("Hours need review");
    expect(html).not.toContain("Double-booked");
  });

  it("shows neither notice once edited hours no longer overlap", () => {
    const html = markup(
      { start_time: "07:00", end_time: "11:00" },
      [other({ start_time: "13:00", end_time: "17:00" })],
    );
    expect(html).not.toContain("sched-conflict-inline");
  });

  it("reclassifies from review to confirmed as soon as the missing end time is filled in — never stays stuck on the old notice", () => {
    const others = [other({ start_time: "13:00", end_time: "17:00" })];
    const stillReview = markup({ start_time: "12:00", end_time: null }, others);
    expect(stillReview).toContain("is-review");
    expect(stillReview).not.toContain("Double-booked");

    const nowConfirmed = markup({ start_time: "12:00", end_time: "14:00" }, others);
    expect(nowConfirmed).not.toContain("is-review");
    expect(nowConfirmed).toContain("Double-booked");
  });
});
