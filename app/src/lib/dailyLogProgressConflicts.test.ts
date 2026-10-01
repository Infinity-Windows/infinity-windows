// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearProgressConflicts,
  loadProgressConflicts,
  saveProgressConflicts,
  type DailyLogProgressConflictRecord,
} from "./dailyLogProgressConflicts";
import { emptyProgressFields } from "./dailyLogStages";

const record: DailyLogProgressConflictRecord = {
  version: 1,
  ownerId: "ana",
  projectId: "job-a",
  logDate: "2026-10-01",
  serverRevision: 3,
  conflicts: [{ field: "unitsRemaining", queuedValue: 11 }],
  queuedSnapshot: { ...emptyProgressFields(), unitsRemaining: 11 },
  detectedAt: "2026-10-01T18:00:00Z",
};

beforeEach(() => { localStorage.clear(); });

describe("daily log progress conflicts, kept local only", () => {
  it("round-trips for the same owner/job/day", () => {
    saveProgressConflicts(record);
    expect(loadProgressConflicts("ana", "job-a", "2026-10-01")).toEqual(record);
  });

  it("is invisible to a different owner, job or day", () => {
    saveProgressConflicts(record);
    expect(loadProgressConflicts("ben", "job-a", "2026-10-01")).toBeNull();
    expect(loadProgressConflicts("ana", "job-b", "2026-10-01")).toBeNull();
    expect(loadProgressConflicts("ana", "job-a", "2026-10-02")).toBeNull();
  });

  it("clears on explicit dismissal", () => {
    saveProgressConflicts(record);
    clearProgressConflicts("ana", "job-a", "2026-10-01");
    expect(loadProgressConflicts("ana", "job-a", "2026-10-01")).toBeNull();
  });

  it("never writes a record for an empty conflict list — nothing to review", () => {
    saveProgressConflicts({ ...record, conflicts: [] });
    expect(loadProgressConflicts("ana", "job-a", "2026-10-01")).toBeNull();
  });
});
