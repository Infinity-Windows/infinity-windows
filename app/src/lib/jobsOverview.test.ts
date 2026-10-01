import { describe, expect, it } from "vitest";
import {
  buildConcern,
  buildConcerns,
  buildMeaningfulChanges,
  customWorkProgress,
  earliestStartTime,
  hasActivityOn,
  hasPassedStartTime,
  isAttentionWorthy,
  latestActivity,
  nextStepFor,
  pickMainIssue,
  planFor,
  sortJobRows,
  type JobOverviewConcern,
  type JobOverviewRow,
  type StrictAssignment,
} from "./jobsOverview";
import type { Issue } from "./issues";

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "i1",
    project_id: "p1",
    opening_id: null,
    window_id: null,
    kind: "complication",
    urgency: "normal",
    status: "open",
    note: null,
    created_by: null,
    created_at: "2026-09-29T10:00:00Z",
    resolved_by: null,
    resolved_at: null,
    assigned_to: null,
    ...over,
  };
}

function assignment(over: Partial<StrictAssignment> = {}): StrictAssignment {
  return {
    id: "a1",
    project_id: "p1",
    kind: "install",
    start_date: "2026-10-01",
    end_date: "2026-10-01",
    start_time: null,
    status: "published",
    note: null,
    published_at: "2026-09-30T12:00:00Z",
    updated_at: "2026-09-30T12:00:00Z",
    created_at: "2026-09-30T12:00:00Z",
    members: [{ profile_id: "u1", role: "installer", display_name: "Ammon" }],
    ...over,
  };
}

// ---- finding 1: sessions/activity must be scoped PER PROJECT ----------

describe("latestActivity (finding 1 regression)", () => {
  const session = (projectId: string, startedAt: string) => ({
    id: "s1",
    started_at: startedAt,
    ended_at: null,
    opening_id: "o1",
    end_reason: "finish",
    role: "install",
    project_id: projectId,
  });

  it("never attributes another job's session to this job", () => {
    const a = latestActivity({
      sessions: [session("p2", "2026-09-30T12:00:00Z")],
      customSessions: [],
      crewRecords: [],
      dailyLogs: [],
      projectId: "p1",
    });
    expect(a).toBeNull();
  });

  it("picks the right job out of two with activity on different days", () => {
    const sessions = [session("p1", "2026-09-28T08:00:00Z"), session("p2", "2026-09-30T08:00:00Z")];
    const p1 = latestActivity({ sessions, customSessions: [], crewRecords: [], dailyLogs: [], projectId: "p1" });
    const p2 = latestActivity({ sessions, customSessions: [], crewRecords: [], dailyLogs: [], projectId: "p2" });
    expect(p1?.atISO).toBe("2026-09-28T08:00:00Z");
    expect(p2?.atISO).toBe("2026-09-30T08:00:00Z");
  });

  it("uses a daily log's FILED time, never its edit time", () => {
    const a = latestActivity({
      sessions: [],
      customSessions: [],
      crewRecords: [],
      dailyLogs: [{ id: "l1", project_id: "p1", log_date: "2026-09-20", headline: null, created_at: "2026-09-20T18:00:00Z", updated_at: "2026-10-01T09:00:00Z" }],
      projectId: "p1",
    });
    expect(a?.atISO).toBe("2026-09-20T18:00:00Z");
    expect(a?.source).toBe("dailyLog");
  });

  it("includes a dated crew report as activity", () => {
    const a = latestActivity({
      sessions: [],
      customSessions: [],
      crewRecords: [{ id: "r1", project_id: "p1", unit_id: "u1", filed_by: "f1", work_date: "2026-09-30", stage: "Installing", outcome: "finished", whole_complete: false, description: "", created_at: "2026-09-30T19:00:00Z" }],
      dailyLogs: [],
      projectId: "p1",
    });
    expect(a?.source).toBe("crewReport");
  });
});

describe("hasActivityOn", () => {
  const session = (projectId: string, startedAt: string, endedAt: string | null) => ({
    id: "s1",
    started_at: startedAt,
    ended_at: endedAt,
    opening_id: "o1",
    end_reason: "finish",
    role: "install",
    project_id: projectId,
  });

  it("is scoped per project — finding 1 again, at the boolean gate", () => {
    const sessions = [session("p2", "2026-10-01T08:00:00Z", null)];
    expect(hasActivityOn({ sessions, customSessions: [], crewRecords: [], dailyLogs: [], projectId: "p1", dayISO: "2026-10-01" })).toBe(false);
  });

  it("counts a session that STARTED yesterday but ENDED today", () => {
    const sessions = [session("p1", "2026-09-30T23:00:00", "2026-10-01T01:00:00")];
    expect(hasActivityOn({ sessions, customSessions: [], crewRecords: [], dailyLogs: [], projectId: "p1", dayISO: "2026-10-01" })).toBe(true);
  });

  it("matches a crew report by its own work_date, not by when it was filed", () => {
    const crewRecords = [{ id: "r1", project_id: "p1", unit_id: "u1", filed_by: null, work_date: "2026-10-01", stage: "Installing", outcome: "finished", whole_complete: false, description: "", created_at: "2026-09-28T00:00:00Z" }];
    expect(hasActivityOn({ sessions: [], customSessions: [], crewRecords, dailyLogs: [], projectId: "p1", dayISO: "2026-10-01" })).toBe(true);
  });

  it("matches a daily log by its log_date, never by an edit timestamp (finding 3)", () => {
    const dailyLogs = [{ id: "l1", project_id: "p1", log_date: "2026-10-01", headline: null, created_at: "2026-09-20T00:00:00Z", updated_at: "2026-10-01T23:00:00Z" }];
    expect(hasActivityOn({ sessions: [], customSessions: [], crewRecords: [], dailyLogs, projectId: "p1", dayISO: "2026-10-01" })).toBe(true);
  });

  it("does not count an edit of yesterday's log as today's activity", () => {
    // log_date is yesterday; only updated_at (an edit) falls today — must not count.
    const dailyLogs = [{ id: "l1", project_id: "p1", log_date: "2026-09-30", headline: null, created_at: "2026-09-30T20:00:00Z", updated_at: "2026-10-01T09:00:00Z" }];
    expect(hasActivityOn({ sessions: [], customSessions: [], crewRecords: [], dailyLogs, projectId: "p1", dayISO: "2026-10-01" })).toBe(false);
  });
});

// ---- finding 4: concern ranking and retention --------------------------

describe("pickMainIssue (finding 4 ranking)", () => {
  it("ranks a normal-severity blocker ahead of an older routine issue", () => {
    const issues = [
      issue({ id: "routine", urgency: "normal", kind: "complication", created_at: "2026-09-01T00:00:00Z" }),
      issue({ id: "blocker", urgency: "normal", kind: "blocker", created_at: "2026-09-29T00:00:00Z" }),
    ];
    expect(pickMainIssue(issues)?.id).toBe("blocker");
  });

  it("still ranks urgent/emergency ahead of a normal blocker", () => {
    const issues = [
      issue({ id: "blocker", urgency: "normal", kind: "blocker" }),
      issue({ id: "urgent", urgency: "urgent", kind: "complication" }),
    ];
    expect(pickMainIssue(issues)?.id).toBe("urgent");
  });
});

describe("buildConcerns (finding 4)", () => {
  it("retains every open concern, ranked — a routine issue never hides a blocker", () => {
    const concerns = buildConcerns({
      issues: [
        issue({ id: "routine", urgency: "normal", kind: "complication" }),
        issue({ id: "blocker", urgency: "normal", kind: "blocker" }),
      ],
      projectId: "p1",
      nowMs: Date.now(),
      names: new Map(),
      namesOk: true,
      readinessOpenCount: 2,
      readinessApplicable: true,
    });
    expect(concerns.map((c) => c.kind === "issue" ? c.issueKind : c.kind)).toEqual(["blocker", "readiness", "complication"]);
  });

  it("never surfaces a readiness concern for a job with no applicable scheduled work", () => {
    const concerns = buildConcerns({
      issues: [],
      projectId: "p1",
      nowMs: Date.now(),
      names: new Map(),
      namesOk: true,
      readinessOpenCount: 3,
      readinessApplicable: false,
    });
    expect(concerns).toHaveLength(0);
  });

  it("is empty — a real, positive answer — with nothing open", () => {
    expect(buildConcerns({ issues: [], projectId: "p1", nowMs: Date.now(), names: new Map(), namesOk: true, readinessOpenCount: 0, readinessApplicable: true })).toHaveLength(0);
  });
});

describe("issue concern fields (finding 5)", () => {
  it("links to the exact issue — /issues?issue=<id> — regardless of opening_id", () => {
    const [c] = buildConcerns({
      issues: [issue({ id: "i9", opening_id: null })],
      projectId: "p1",
      nowMs: Date.now(),
      names: new Map(),
      namesOk: true,
      readinessOpenCount: null,
      readinessApplicable: false,
    });
    expect(c.href).toBe("/issues?issue=i9");
    expect(c.exactLink).toBe(true);
  });

  it("says Unassigned only when no assignee is recorded at all", () => {
    const [c] = buildConcerns({
      issues: [issue({ assigned_to: null })],
      projectId: "p1",
      nowMs: Date.now(),
      names: new Map(),
      namesOk: true,
      readinessOpenCount: null,
      readinessApplicable: false,
    });
    expect(c.assignedToName).toBe("Unassigned");
    expect(c.assignedToId).toBeUndefined();
  });

  it("never says Unassigned when a name lookup fails for a real assignee (finding 5)", () => {
    const [c] = buildConcerns({
      issues: [issue({ assigned_to: "u9" })],
      projectId: "p1",
      nowMs: Date.now(),
      names: new Map(), // lookup failed, map is empty
      namesOk: false,
      readinessOpenCount: null,
      readinessApplicable: false,
    });
    expect(c.assignedToName).toBe("Assigned (name unavailable)");
    expect(c.assignedToId).toBe("u9");
  });

  it("uses the real name once the lookup succeeds", () => {
    const [c] = buildConcerns({
      issues: [issue({ assigned_to: "u9" })],
      projectId: "p1",
      nowMs: Date.now(),
      names: new Map([["u9", "Jordan"]]),
      namesOk: true,
      readinessOpenCount: null,
      readinessApplicable: false,
    });
    expect(c.assignedToName).toBe("Jordan");
  });

  it("carries the issue's own createdAt", () => {
    const [c] = buildConcerns({
      issues: [issue({ created_at: "2026-09-15T00:00:00Z" })],
      projectId: "p1",
      nowMs: Date.now(),
      names: new Map(),
      namesOk: true,
      readinessOpenCount: null,
      readinessApplicable: false,
    });
    expect(c.createdAt).toBe("2026-09-15T00:00:00Z");
  });
});

describe("buildConcern (status-unknown timing)", () => {
  it("never warns before a given start time has passed", () => {
    const c = buildConcern({
      issues: [],
      projectId: "p1",
      nowMs: Date.now(),
      names: new Map(),
      readinessOpenCount: 0,
      publishedToday: true,
      hasActivityToday: false,
      pastScheduledStart: false,
    });
    expect(c).toBeNull();
  });

  it("flags status-unknown (never 'blocked') once the start time has passed with nothing recorded", () => {
    const c = buildConcern({
      issues: [],
      projectId: "p1",
      nowMs: Date.now(),
      names: new Map(),
      readinessOpenCount: 0,
      publishedToday: true,
      hasActivityToday: false,
      pastScheduledStart: true,
    });
    expect(c?.kind).toBe("statusUnknown");
    expect(c?.severity).toBe("info");
  });

  it("never warns a quiet job with no published work today", () => {
    const c = buildConcern({
      issues: [],
      projectId: "p1",
      nowMs: Date.now(),
      names: new Map(),
      readinessOpenCount: 0,
      publishedToday: false,
      hasActivityToday: false,
    });
    expect(c).toBeNull();
  });
});

describe("isAttentionWorthy", () => {
  const base: JobOverviewConcern = {
    kind: "issue",
    severity: "normal",
    label: "Complication",
    note: null,
    assignedToName: "Unassigned",
    ageLabel: null,
    href: "/issues?issue=i1",
    exactLink: true,
  };
  it("is false for a routine issue, true for a blocker or urgent/emergency, true for readiness, false for status-unknown", () => {
    expect(isAttentionWorthy(base)).toBe(false);
    expect(isAttentionWorthy({ ...base, issueKind: "blocker" })).toBe(true);
    expect(isAttentionWorthy({ ...base, severity: "urgent" })).toBe(true);
    expect(isAttentionWorthy({ ...base, kind: "readiness" })).toBe(true);
    expect(isAttentionWorthy({ ...base, kind: "statusUnknown", severity: "info" })).toBe(false);
    expect(isAttentionWorthy(null)).toBe(false);
  });
});

describe("sortJobRows", () => {
  function row(over: Partial<JobOverviewRow>): JobOverviewRow {
    return {
      id: "p", name: "Job", jobCode: "J1", href: "/projects/p", isUpcoming: false,
      scope: null, customWork: null, today: null, nextStep: null, concern: null,
      lastActivity: null, needsAttention: false, ...over,
    };
  }
  it("needs-attention first, then today's planned jobs, then the rest, stable within a tier", () => {
    const rows = [
      row({ id: "other" }),
      row({ id: "today", today: { crewNames: ["Ammon"], note: null } }),
      row({ id: "attn", needsAttention: true }),
    ];
    expect(sortJobRows(rows).map((r) => r.id)).toEqual(["attn", "today", "other"]);
  });
});

describe("customWorkProgress", () => {
  it("counts only free-standing (no opening_id) units, scoped to one project", () => {
    const units = [
      { project_id: "p1", opening_id: null, facts: { installation_complete: "Yes" } },
      { project_id: "p1", opening_id: "o1", facts: { installation_complete: "Yes" } },
      { project_id: "p2", opening_id: null, facts: { installation_complete: "Yes" } },
    ];
    expect(customWorkProgress(units, "p1")).toEqual({ total: 1, completed: 1 });
  });
});

// ---- finding 6: ongoing assignment covering tomorrow -------------------

describe("planFor / nextStepFor (finding 6)", () => {
  it("never shows a draft or canceled assignment as today's plan", () => {
    expect(planFor([assignment({ status: "draft" })], "p1", "2026-10-01")).toBeNull();
    expect(planFor([assignment({ status: "canceled" })], "p1", "2026-10-01")).toBeNull();
  });

  it("includes in_progress only when it carries publication evidence", () => {
    expect(planFor([assignment({ status: "in_progress", published_at: null })], "p1", "2026-10-01")).toBeNull();
    expect(planFor([assignment({ status: "in_progress", published_at: "2026-09-30T00:00:00Z" })], "p1", "2026-10-01")?.crewNames).toEqual(["Ammon"]);
  });

  it("finds tomorrow inside an ONGOING multi-day assignment that already started", () => {
    // Started two days ago, runs a week — tomorrow is covered, not a later start_date.
    const rows = [assignment({ start_date: "2026-09-29", end_date: "2026-10-06" })];
    const step = nextStepFor(rows, "p1", "2026-10-01");
    expect(step?.dateISO).toBe("2026-10-02");
  });

  it("uses the real next start_date when the assignment hasn't begun yet", () => {
    const rows = [assignment({ start_date: "2026-10-05", end_date: "2026-10-05" })];
    expect(nextStepFor(rows, "p1", "2026-10-01")?.dateISO).toBe("2026-10-05");
  });

  it("names the crew for the chosen next step", () => {
    const rows = [assignment({ start_date: "2026-10-05", end_date: "2026-10-05", members: [{ profile_id: "u2", role: "foreman", display_name: "Jordan" }] })];
    expect(nextStepFor(rows, "p1", "2026-10-01")?.crewNames).toEqual(["Jordan"]);
  });

  it("is null when nothing covers tomorrow or later", () => {
    expect(nextStepFor([assignment({ start_date: "2026-09-01", end_date: "2026-09-01" })], "p1", "2026-10-01")).toBeNull();
  });
});

describe("earliestStartTime / hasPassedStartTime", () => {
  it("is null when no matching assignment carries a start time", () => {
    expect(earliestStartTime([assignment({ start_time: null })], "p1", "2026-10-01")).toBeNull();
  });

  it("treats a missing start time as already passed (no precision to gate on)", () => {
    expect(hasPassedStartTime("2026-10-01", null, Date.now())).toBe(true);
  });

  it("does not report passed before the given time of day", () => {
    const before = Date.parse("2026-10-01T07:00:00");
    expect(hasPassedStartTime("2026-10-01", "08:00", before)).toBe(false);
  });

  it("reports passed once the given time of day has arrived", () => {
    const after = Date.parse("2026-10-01T09:00:00");
    expect(hasPassedStartTime("2026-10-01", "08:00", after)).toBe(true);
  });
});

// ---- finding 7: changes window, real timestamps, no installed-count ----

describe("buildMeaningfulChanges (finding 7)", () => {
  const jobsById = new Map([["p1", { name: "Oak House", jobCode: "OAK1" }]]);
  const since = "2026-09-30T00:00:00Z"; // local-midnight-yesterday, supplied by the caller

  it("reports a new issue and a resolved issue separately, with real timestamps", () => {
    const changes = buildMeaningfulChanges({
      issues: [
        issue({ id: "a", created_at: "2026-09-30T12:00:00Z" }),
        issue({ id: "b", created_at: "2026-09-01T00:00:00Z", status: "resolved", resolved_at: "2026-09-30T13:00:00Z" }),
      ],
      assignments: [],
      dailyLogs: [],
      jobsById,
      sinceISO: since,
    });
    const created = changes.find((c) => c.kind === "issueNew");
    const resolved = changes.find((c) => c.kind === "issueResolved");
    expect(created?.atISO).toBe("2026-09-30T12:00:00Z");
    expect(created?.href).toBe("/issues?issue=a");
    expect(resolved?.atISO).toBe("2026-09-30T13:00:00Z");
    expect(resolved?.href).toBe("/issues?issue=b");
  });

  it("omits an issue created before the window", () => {
    const changes = buildMeaningfulChanges({
      issues: [issue({ created_at: "2026-09-01T00:00:00Z" })],
      assignments: [],
      dailyLogs: [],
      jobsById,
      sinceISO: since,
    });
    expect(changes).toHaveLength(0);
  });

  it("reports a newly published assignment", () => {
    const changes = buildMeaningfulChanges({
      issues: [],
      assignments: [assignment({ published_at: "2026-09-30T18:00:00Z" })],
      dailyLogs: [],
      jobsById,
      sinceISO: since,
    });
    expect(changes[0].kind).toBe("schedulePublished");
    expect(changes[0].atISO).toBe("2026-09-30T18:00:00Z");
  });

  it("reports a real post-publish EDIT as 'changed', not a second publish", () => {
    const changes = buildMeaningfulChanges({
      issues: [],
      assignments: [assignment({ published_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-30T20:00:00Z" })],
      dailyLogs: [],
      jobsById,
      sinceISO: since,
    });
    expect(changes[0].kind).toBe("scheduleChanged");
    expect(changes[0].atISO).toBe("2026-09-30T20:00:00Z");
  });

  it("ignores a draft or canceled assignment entirely", () => {
    const changes = buildMeaningfulChanges({
      issues: [],
      assignments: [assignment({ status: "draft", published_at: null, updated_at: "2026-09-30T20:00:00Z" })],
      dailyLogs: [],
      jobsById,
      sinceISO: since,
    });
    expect(changes).toHaveLength(0);
  });

  it("reports a filed daily log by its FILED time, with its headline", () => {
    const changes = buildMeaningfulChanges({
      issues: [],
      assignments: [],
      dailyLogs: [{ id: "l1", project_id: "p1", log_date: "2026-09-30", headline: "Framing finished", created_at: "2026-09-30T19:00:00Z", updated_at: "2026-09-30T19:00:00Z" }],
      jobsById,
      sinceISO: since,
    });
    expect(changes[0]).toMatchObject({ kind: "dailyLog", headline: "Framing finished", dateISO: "2026-09-30" });
  });

  it("has no way to report a 'recorded installed' change — buildMeaningfulChanges takes no session data at all", () => {
    // Finding 7: session/helper/stage data cannot establish a distinct
    // installed-opening count, so this function's own signature omits
    // sessions entirely — there's nothing to pass it even if some caller
    // wanted to. This test is a type-level guarantee as much as a runtime one.
    const changes = buildMeaningfulChanges({ issues: [], assignments: [], dailyLogs: [], jobsById, sinceISO: since });
    expect(changes).toHaveLength(0);
  });

  it("ignores every source entirely for a job outside scope", () => {
    const changes = buildMeaningfulChanges({
      issues: [issue({ project_id: "ghost", created_at: "2026-09-30T12:00:00Z" })],
      assignments: [],
      dailyLogs: [],
      jobsById,
      sinceISO: since,
    });
    expect(changes).toHaveLength(0);
  });
});
