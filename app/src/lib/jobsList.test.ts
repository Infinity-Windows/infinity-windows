import { describe, expect, it } from "vitest";
import {
  endTimeHasPassed,
  filterJobsByView,
  groupJobsForList,
  matchesSearch,
  nextScheduledJob,
  recentlyWorkedProjectIds,
  scheduledProjectIds,
  searchTokens,
  sortJobsAlpha,
  type ScheduleCandidate,
} from "./jobsList";

function job(over: Partial<{ id: string; name: string; job_code: string; address: string; customer_name: string }>) {
  return { id: "x", name: "", job_code: "", ...over };
}

describe("searchTokens / matchesSearch", () => {
  it("splits on whitespace, drops case and accents", () => {
    expect(searchTokens("  Peña  Blanca ")).toEqual(["pena", "blanca"]);
  });

  it("matches diacritics in either direction", () => {
    const j = job({ name: "Peña Blanca" });
    expect(matchesSearch(j, "pena")).toBe(true);
    expect(matchesSearch(j, "PEÑA")).toBe(true);
  });

  it("requires every token (AND), across name/code/address/customer", () => {
    const j = job({ name: "Sand Hollow", job_code: "SANDHOLLOW", address: "1 Sand Hollow Way", customer_name: "Dixie Builders" });
    expect(matchesSearch(j, "sand dixie")).toBe(true);
    expect(matchesSearch(j, "sand nobody")).toBe(false);
  });

  it("a blank query matches everything", () => {
    expect(matchesSearch(job({ name: "Anything" }), "")).toBe(true);
    expect(matchesSearch(job({ name: "Anything" }), "   ")).toBe(true);
  });

  it("matches a job code even when the name is blank", () => {
    expect(matchesSearch(job({ name: "", job_code: "PECAN14" }), "pecan")).toBe(true);
  });

  it("missing fields (null address/customer) never throw and never match stray tokens", () => {
    const j = { id: "x", name: "Testing", job_code: "T1", address: null, customer_name: null };
    expect(matchesSearch(j, "testing")).toBe(true);
    expect(matchesSearch(j, "nothing")).toBe(false);
  });
});

describe("groupJobsForList", () => {
  const jobs = [
    job({ id: "1", name: "Zebra Job" }),
    job({ id: "2", name: "apple Job" }),
    job({ id: "3", name: "Mango Job" }),
    job({ id: "4", name: "Banana Job" }),
  ];

  it("puts each job in exactly one group, alphabetized within it", () => {
    const scheduled = new Set(["1"]);
    const recent = new Set(["3", "4"]);
    const out = groupJobsForList(jobs, scheduled, recent, null);
    expect(out.scheduled.map((j) => j.id)).toEqual(["1"]);
    expect(out.recentlyWorked.map((j) => j.id)).toEqual(["4", "3"]); // Banana before Mango
    expect(out.other.map((j) => j.id)).toEqual(["2"]);
  });

  it("scheduled beats recently-worked when a job is both", () => {
    const out = groupJobsForList(jobs, new Set(["3"]), new Set(["3"]), null);
    expect(out.scheduled.map((j) => j.id)).toEqual(["3"]);
    expect(out.recentlyWorked).toEqual([]);
  });

  it("omits the highlighted job from every group by default", () => {
    const out = groupJobsForList(jobs, new Set(["2"]), new Set(), "2");
    expect(out.highlighted?.id).toBe("2");
    expect(out.scheduled).toEqual([]);
    expect(out.other.some((j) => j.id === "2")).toBe(false);
  });

  it("keeps the highlighted job findable in its group while searching", () => {
    const out = groupJobsForList(jobs, new Set(["2"]), new Set(), "2", true);
    expect(out.highlighted?.id).toBe("2");
    expect(out.scheduled.map((j) => j.id)).toEqual(["2"]);
  });

  it("ties on identical names resolve deterministically by id", () => {
    const tied = [job({ id: "b", name: "Same Name" }), job({ id: "a", name: "Same Name" })];
    const out = groupJobsForList(tied, new Set(), new Set(), null);
    expect(out.other.map((j) => j.id)).toEqual(["a", "b"]);
  });

  it("a job with no name falls back to its job code for sorting", () => {
    const noName = [job({ id: "1", name: "", job_code: "ZZZ" }), job({ id: "2", name: "", job_code: "AAA" })];
    const out = groupJobsForList(noName, new Set(), new Set(), null);
    expect(out.other.map((j) => j.id)).toEqual(["2", "1"]);
  });

  it("a highlighted id absent from the job list is simply ignored", () => {
    const out = groupJobsForList(jobs, new Set(), new Set(), "missing");
    expect(out.highlighted).toBeNull();
    expect(out.other).toHaveLength(4);
  });
});

describe("sortJobsAlpha", () => {
  it("sorts case/locale-insensitively, falling back to job_code, ties by id", () => {
    const out = sortJobsAlpha([
      job({ id: "1", name: "zebra" }),
      job({ id: "2", name: "Apple" }),
      job({ id: "3", name: "", job_code: "MANGO" }),
    ]);
    expect(out.map((j) => j.id)).toEqual(["2", "3", "1"]);
  });
});

describe("recentlyWorkedProjectIds", () => {
  it("unions project ids from both sessions and shifts", () => {
    const ids = recentlyWorkedProjectIds(
      [{ project_id: "a" }, { project_id: null }],
      [{ project_id: "b" }],
    );
    expect(ids).toEqual(new Set(["a", "b"]));
  });

  it("excludes voided and rejected shifts, and sessions on a voided/rejected shift", () => {
    const ids = recentlyWorkedProjectIds(
      [{ project_id: "a", shift_status: "voided" }, { project_id: "b", shift_status: "approved" }],
      [{ project_id: "c", status: "rejected" }, { project_id: "d", status: "voided" }, { project_id: "e", status: "approved" }],
    );
    expect(ids).toEqual(new Set(["b", "e"]));
  });

  it("missing data (no rows at all) is an empty set, never a throw", () => {
    expect(recentlyWorkedProjectIds([], [])).toEqual(new Set());
  });
});

describe("filterJobsByView", () => {
  const jobs = [job({ id: "1" }), job({ id: "2" }), job({ id: "3" })];
  it("all returns every job untouched", () => {
    expect(filterJobsByView(jobs, "all", new Set(), new Set())).toHaveLength(3);
  });
  it("scheduled/recent narrow to their own id sets", () => {
    expect(filterJobsByView(jobs, "scheduled", new Set(["2"]), new Set()).map((j) => j.id)).toEqual(["2"]);
    expect(filterJobsByView(jobs, "recent", new Set(), new Set(["3"])).map((j) => j.id)).toEqual(["3"]);
  });
});

function assignment(over: Partial<ScheduleCandidate> & { id: string; project_id: string | null }): ScheduleCandidate {
  return {
    kind: "install",
    start_date: "2026-10-01",
    end_date: "2026-10-01",
    start_time: null,
    end_time: null,
    status: "published",
    ...over,
  };
}

describe("scheduledProjectIds", () => {
  it("includes only published installs with a project", () => {
    const ids = scheduledProjectIds([
      assignment({ id: "a", project_id: "p1" }),
      assignment({ id: "b", project_id: null, kind: "delivery" }),
      assignment({ id: "c", project_id: "p2", status: "draft" }),
    ]);
    expect(ids).toEqual(new Set(["p1"]));
  });
});

describe("endTimeHasPassed", () => {
  it("ends at the exact end time and treats malformed times as unknown", () => {
    expect(endTimeHasPassed("08:00", "15:00", "15:00")).toBe(true);
    expect(endTimeHasPassed("08:00", "99:99", "16:00")).toBe(false);
    expect(endTimeHasPassed("08:00", "15:00garbage", "16:00")).toBe(false);
    expect(endTimeHasPassed("08:00", "15:00", "99:99")).toBe(false);
  });

  it("true once now is after a same-day end time", () => {
    expect(endTimeHasPassed("08:00", "15:00", "16:00")).toBe(true);
  });
  it("false before the end time", () => {
    expect(endTimeHasPassed("08:00", "15:00", "10:00")).toBe(false);
  });
  it("honest when there is no end time at all", () => {
    expect(endTimeHasPassed("08:00", null, "23:59")).toBe(false);
  });
  it("honest when the current time is unknown", () => {
    expect(endTimeHasPassed("08:00", "15:00", null)).toBe(false);
  });
  it("honest about an overnight span (end <= start) — never claims it already passed", () => {
    expect(endTimeHasPassed("20:00", "06:00", "23:00")).toBe(false);
    expect(endTimeHasPassed("20:00", "06:00", "05:00")).toBe(false);
  });
  it("tolerates seconds in either time string", () => {
    expect(endTimeHasPassed("08:00:00", "15:00:00", "15:01")).toBe(true);
  });
});

describe("nextScheduledJob", () => {
  const today = "2026-10-01";

  it("an ongoing (not yet ended) job today beats a future one", () => {
    const next = nextScheduledJob(
      [
        assignment({ id: "today", project_id: "p-today", start_date: today, end_date: today, start_time: "08:00", end_time: "16:00" }),
        assignment({ id: "future", project_id: "p-future", start_date: "2026-10-03", end_date: "2026-10-03" }),
      ],
      today,
      "10:00",
    );
    expect(next?.assignment.id).toBe("today");
    expect(next?.day).toBe(today);
  });

  it("today's job whose end time has passed does not beat the next remaining one", () => {
    const next = nextScheduledJob(
      [
        assignment({ id: "today", project_id: "p-today", start_date: today, end_date: today, start_time: "08:00", end_time: "15:00" }),
        assignment({ id: "future", project_id: "p-future", start_date: "2026-10-03", end_date: "2026-10-03" }),
      ],
      today,
      "18:00",
    );
    expect(next?.assignment.id).toBe("future");
  });

  it("a past job (end_date before today) is never recommended", () => {
    const next = nextScheduledJob(
      [assignment({ id: "past", project_id: "p1", start_date: "2026-09-20", end_date: "2026-09-25" })],
      today,
      "09:00",
    );
    expect(next).toBeNull();
  });

  it("unknown current time never counts today's job as over", () => {
    const next = nextScheduledJob(
      [assignment({ id: "today", project_id: "p1", start_date: today, end_date: today, start_time: "08:00", end_time: "15:00" })],
      today,
      null,
    );
    expect(next?.assignment.id).toBe("today");
  });

  it("deliveries and jobless rows are never recommended", () => {
    const next = nextScheduledJob(
      [assignment({ id: "d", project_id: null, kind: "delivery", start_date: today, end_date: today })],
      today,
      "09:00",
    );
    expect(next).toBeNull();
  });

  it("drafts and canceled assignments are never recommended", () => {
    const next = nextScheduledJob(
      [
        assignment({ id: "draft", project_id: "p1", start_date: today, end_date: today, status: "draft" }),
        assignment({ id: "canceled", project_id: "p2", start_date: today, end_date: today, status: "canceled" }),
      ],
      today,
      "09:00",
    );
    expect(next).toBeNull();
  });

  it("nothing beyond the six-week horizon is ever claimed as known", () => {
    const farFuture = "2026-12-15"; // well past 41 days out from 2026-10-01
    const next = nextScheduledJob(
      [assignment({ id: "far", project_id: "p1", start_date: farFuture, end_date: farFuture })],
      today,
      "09:00",
    );
    expect(next).toBeNull();
  });

  it("ties (same day, same/no start time) resolve deterministically by assignment id", () => {
    const a = nextScheduledJob(
      [
        assignment({ id: "b", project_id: "p1", start_date: today, end_date: today }),
        assignment({ id: "a", project_id: "p2", start_date: today, end_date: today }),
      ],
      today,
      "09:00",
    );
    expect(a?.assignment.id).toBe("a");
  });

  it("an untimed assignment sorts after a timed one on the same day", () => {
    const next = nextScheduledJob(
      [
        assignment({ id: "untimed", project_id: "p1", start_date: today, end_date: today, start_time: null }),
        assignment({ id: "timed", project_id: "p2", start_date: today, end_date: today, start_time: "07:00" }),
      ],
      today,
      "06:00",
    );
    expect(next?.assignment.id).toBe("timed");
  });

  it("no assignments at all is simply null, never a throw", () => {
    expect(nextScheduledJob([], today, "09:00")).toBeNull();
  });
});
