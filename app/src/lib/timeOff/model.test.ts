import { describe, expect, it } from "vitest";
import {
  absenceOn,
  availableAssignments,
  timeOffCounts,
  type TimeOffRequest,
} from "./model";
import { boardChips, coverageReport } from "../schedule/board";
import type { ScheduleAssignment } from "../schedule/types";
const request = (over: Partial<TimeOffRequest> = {}): TimeOffRequest => ({
  id: "a",
  profile_id: "u",
  kind: "sick",
  start_date: "2026-09-18",
  end_date: "2026-09-20",
  status: "approved",
  created_at: "2026-09-18T12:00:00Z",
  reviewed_at: null,
  reviewed_by: null,
  ...over,
});
const assignment: ScheduleAssignment = {
  id: "job",
  project_id: "p",
  kind: "install",
  delivery_id: null,
  start_date: "2026-09-17",
  end_date: "2026-09-22",
  status: "published",
  start_time: null,
  color: null,
  note: null,
  created_by: null,
  published_at: null,
  created_at: "",
  updated_at: "",
  members: [
    { profile_id: "u", role: "installer" },
    { profile_id: "v", role: "installer" },
  ],
};
describe("time off does not erase the working schedule", () => {
  it("counts approved elapsed and future calendar days separately, clipping periods and excluding pending/declined/canceled", () => {
    const rows = [
      request(),
      request({ id: "repeat" }),
      request({ kind: "vacation", status: "pending" }),
      request({ kind: "other", status: "canceled" }),
      request({ kind: "vacation", status: "declined" }),
    ];
    expect(timeOffCounts(rows, "2026-09-18")).toEqual({
      taken: { sick: 1, vacation: 0, other: 0 },
      planned: { sick: 2, vacation: 0, other: 0 },
    });
    expect(
      timeOffCounts(rows, "2026-10-01", "2026-09-19", "2026-09-19").taken.sick,
    ).toBe(1);
  });
  it("clips a cross-year vacation and retains weekends explicitly", () => {
    expect(
      timeOffCounts(
        [
          request({
            kind: "vacation",
            start_date: "2026-12-30",
            end_date: "2027-01-03",
          }),
        ],
        "2027-02-01",
        "2027-01-01",
        "2027-12-31",
      ).taken.vacation,
    ).toBe(3);
  });
  it("removes only absent person's affected days, keeps source untouched, and restores on cancellation", () => {
    const rows = [request()];
    const out = availableAssignments([assignment], rows, "u");
    expect(out.map((a) => [a.start_date, a.end_date])).toEqual([
      ["2026-09-17", "2026-09-17"],
      ["2026-09-21", "2026-09-22"],
    ]);
    expect(assignment.members).toHaveLength(2);
    expect(
      availableAssignments(
        [assignment],
        [request({ status: "canceled" })],
        "u",
      ),
    ).toEqual([assignment]);
    expect(absenceOn(rows, "v", "2026-09-18")).toBeUndefined();
  });
  it("does not report a job as covered when its only crew is absent for the whole assignment", () => {
    const planned = { ...assignment, members: [assignment.members[0]] };
    const jobs = [{ id: "p", job_code: "TEST", name: "Fixture", start_date: "2026-09-18" }];
    const absence = request({ start_date: planned.start_date, end_date: planned.end_date });
    expect(coverageReport(jobs, availableAssignments([planned], [absence]), "2026-09-18").covered).toHaveLength(0);
    expect(coverageReport(jobs, availableAssignments([planned], [{ ...absence, status: "canceled" }]), "2026-09-18").covered).toHaveLength(1);
    expect(planned.members).toHaveLength(1);
  });
  it("crew board and personal schedule agree about a sick day and pending leave does not remove work", () => {
    const days = ["2026-09-17", "2026-09-18"];
    expect(
      boardChips([{ ...assignment, time_off: [request()] }], days).map(
        (c) => `${c.personId}:${c.day}`,
      ),
    ).toEqual(["u:2026-09-17", "v:2026-09-17", "v:2026-09-18"]);
    expect(
      boardChips(
        [{ ...assignment, time_off: [request({ status: "pending" })] }],
        days,
      ),
    ).toHaveLength(4);
  });
});
