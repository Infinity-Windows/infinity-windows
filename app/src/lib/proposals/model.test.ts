import { describe, it, expect } from "vitest";
import {
  followUpDue,
  latestBids,
  startLabel,
  daysOld,
  localDay,
  type Job,
  type Bid,
} from "./model";
import { canAccess } from "../nav";
const job = {
  id: "job",
  stage: "submitted",
  follow_up_on: "2026-09-09",
  start_precision: "unknown",
  target_start: null,
  target_end: null,
  confirmed_start: null,
} as Job;
describe("proposal workflow business rules", () => {
  it("keeps internal Workflow away from foremen/installers, including cost grants", () => {
    for (const role of ["installer", "foreman"])
      expect(canAccess(role, "/workflow", { costs: true })).toBe(false);
    for (const role of ["supervisor", "owner", "admin", "big_boss"])
      expect(canAccess(role, "/workflow")).toBe(true);
  });
  it("uses the Mountain calendar rather than the UTC day", () => {
    expect(localDay(new Date("2026-09-10T02:00:00Z"))).toBe("2026-09-09");
  });
  it("marks a four-day date due without reactivating held or closed work", () => {
    expect(followUpDue(job, new Date("2026-09-09T20:00Z"))).toBe(true);
    expect(followUpDue(job, new Date("2026-09-08T20:00Z"))).toBe(false);
    for (const stage of ["on_hold", "complete", "lost"] as const)
      expect(
        followUpDue({ ...job, stage }, new Date("2026-10-01T20:00Z")),
      ).toBe(false);
  });
  it("does not invent a day for an approximate month", () => {
    expect(
      startLabel({
        ...job,
        start_precision: "month",
        target_start: "2026-10-01",
      }),
    ).toBe("October 2026 · tentative");
  });
  it("keeps confirmed timing distinct from a target", () => {
    expect(
      startLabel({
        ...job,
        target_start: "2026-10-01",
        confirmed_start: "2026-10-07",
      }),
    ).toBe("Confirmed 2026-10-07");
  });
  it("keeps separate contractors, phases and jobs when selecting latest revisions", () => {
    const b = {
      id: "old",
      job_id: "job",
      number: "B1",
      contractor: "STG",
      revision: 1,
    } as Bid;
    expect(
      latestBids([
        b,
        { ...b, id: "new", revision: 2 },
        { ...b, id: "other", contractor: "Other" },
        { ...b, id: "phase", number: "B2" },
        { ...b, id: "other-job", job_id: "job2" },
      ]).map((x) => x.id),
    ).toEqual(["new", "other", "phase", "other-job"]);
  });
  it("computes proposal age in calendar days and clamps future values", () => {
    expect(daysOld("2026-09-05", new Date("2026-09-09T20:00Z"))).toBe(4);
    expect(daysOld("2026-10-01", new Date("2026-09-09T20:00Z"))).toBe(0);
  });
});
