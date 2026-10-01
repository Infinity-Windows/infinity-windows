// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearManualDailyLogDraft, loadManualDailyLogDraft, saveManualDailyLogDraft, type ManualDailyLogDraft } from "./manualDailyLogDraft";

const row: ManualDailyLogDraft = {
  version: 1, ownerId: "ana", projectId: "job-a", logDate: "2026-10-01", baseRevision: 2,
  fields: { headline: "Frames", notes: "Set two frames", dayFlow: "fine", reflection: { went_well: "Delivery" }, weather: "Cool" },
  savedAt: "2026-10-01T12:00:00Z",
};

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe("manual daily log drafts on a shared phone", () => {
  it("keeps the exact edited fields and original server revision for the same owner, job and day", () => {
    saveManualDailyLogDraft(row);
    expect(loadManualDailyLogDraft("ana", "job-a", "2026-10-01")).toEqual(row);
    expect(loadManualDailyLogDraft("ben", "job-a", "2026-10-01")).toBeNull();
    expect(loadManualDailyLogDraft("ana", "job-b", "2026-10-01")).toBeNull();
    expect(loadManualDailyLogDraft("ana", "job-a", "2026-10-02")).toBeNull();
  });

  it("rejects a record stamped for another owner even if placed at this owner's key", () => {
    saveManualDailyLogDraft(row);
    const key = localStorage.key(0)!;
    localStorage.setItem(key, JSON.stringify({ ...row, ownerId: "ben" }));
    expect(loadManualDailyLogDraft("ana", "job-a", "2026-10-01")).toBeNull();
  });

  it("discards only the chosen job-day draft", () => {
    saveManualDailyLogDraft(row);
    saveManualDailyLogDraft({ ...row, logDate: "2026-10-02" });
    clearManualDailyLogDraft("ana", "job-a", "2026-10-01");
    expect(loadManualDailyLogDraft("ana", "job-a", "2026-10-01")).toBeNull();
    expect(loadManualDailyLogDraft("ana", "job-a", "2026-10-02")).not.toBeNull();
  });

  it("reports storage failure instead of claiming a draft was saved", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => saveManualDailyLogDraft(row)).toThrow("quota");
  });
});
