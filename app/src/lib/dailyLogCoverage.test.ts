import { describe, expect, it } from "vitest";
import { coverage, coverageLine, type JobDay } from "./dailyLogCoverage";

function day(projectId: string, logDate: string): JobDay {
  return { projectId, logDate };
}

describe("coverage", () => {
  it("computes the overall ratio: logged worked-days over all worked-days", () => {
    const worked = [day("p1", "2026-08-18"), day("p1", "2026-08-19"), day("p2", "2026-08-18")];
    const logs = [day("p1", "2026-08-18")];
    const s = coverage(worked, logs);
    expect(s.workedDays).toBe(3);
    expect(s.loggedDays).toBe(1);
    expect(s.ratio).toBeCloseTo(1 / 3);
  });

  it("breaks the ratio down per job too", () => {
    const worked = [day("p1", "2026-08-18"), day("p1", "2026-08-19"), day("p2", "2026-08-18")];
    const logs = [day("p1", "2026-08-18"), day("p1", "2026-08-19"), day("p2", "2026-08-18")];
    const s = coverage(worked, logs);
    const p1 = s.perJob.find((j) => j.projectId === "p1")!;
    const p2 = s.perJob.find((j) => j.projectId === "p2")!;
    expect(p1).toEqual({ projectId: "p1", workedDays: 2, loggedDays: 2, ratio: 1 });
    expect(p2).toEqual({ projectId: "p2", workedDays: 1, loggedDays: 1, ratio: 1 });
  });

  it("a job worked by three people the same day is ONE worked job-day, not three", () => {
    const worked = [day("p1", "2026-08-18"), day("p1", "2026-08-18"), day("p1", "2026-08-18")];
    const s = coverage(worked, []);
    expect(s.workedDays).toBe(1);
  });

  it("nothing worked is fully covered, not a divide-by-zero: nothing to log is not the same as nothing logged", () => {
    const s = coverage([], []);
    expect(s.workedDays).toBe(0);
    expect(s.loggedDays).toBe(0);
    expect(s.ratio).toBe(1);
    expect(s.perJob).toEqual([]);
  });

  it("a logged day that was never a worked day (a stray/backfilled log) doesn't inflate the denominator", () => {
    const worked = [day("p1", "2026-08-18")];
    const logs = [day("p1", "2026-08-18"), day("p1", "2026-08-30")];
    const s = coverage(worked, logs);
    expect(s.workedDays).toBe(1);
    expect(s.loggedDays).toBe(1);
    expect(s.ratio).toBe(1);
  });
});

describe("coverageLine", () => {
  it("reads exactly as the spec's example", () => {
    expect(coverageLine({ loggedDays: 4, workedDays: 6 })).toBe(
      "Logs: 4 of 6 worked days logged this week",
    );
  });

  it("takes a different period label when the caller isn't looking at this week", () => {
    expect(coverageLine({ loggedDays: 2, workedDays: 2 }, "this month")).toBe(
      "Logs: 2 of 2 worked days logged this month",
    );
  });
});
