import { describe, expect, it } from "vitest";
import {
  canResumeExtraction,
  describeProgress,
  pendingPages,
  summarizeProgress,
  type StoredPageProgress,
} from "./extractionProgress";

function page(
  pageNumber: number,
  ok: boolean,
  markCount = 0,
  error: string | null = null,
): StoredPageProgress {
  return { pageNumber, ok, attempts: 1, markCount, error, updatedAt: null };
}

describe("summarizeProgress", () => {
  it("counts a fresh run as zero", () => {
    const p = summarizeProgress(14, []);
    expect(p).toMatchObject({ total: 14, attempted: 0, done: 0, marks: 0, percent: 0, complete: false });
  });

  it("counts attempted pages, marks and failures", () => {
    const p = summarizeProgress(4, [page(1, true, 5), page(2, false, 0, "timeout"), page(3, true, 2)]);
    expect(p.attempted).toBe(3);
    expect(p.done).toBe(2);
    expect(p.failed).toEqual([2]);
    expect(p.marks).toBe(7);
    expect(p.percent).toBe(75);
    expect(p.complete).toBe(false);
  });

  it("is complete once every page has been attempted, even with failures", () => {
    const p = summarizeProgress(2, [page(1, true, 3), page(2, false)]);
    expect(p.complete).toBe(true);
    expect(p.percent).toBe(100);
  });

  it("ignores stale rows past the page count instead of exceeding 100%", () => {
    const p = summarizeProgress(2, [page(1, true), page(2, true), page(9, true, 4)]);
    expect(p.attempted).toBe(2);
    expect(p.percent).toBe(100);
    expect(p.marks).toBe(0);
  });

  it("survives an unknown page count", () => {
    const p = summarizeProgress(0, [page(1, true, 2)]);
    expect(p.total).toBe(0);
    expect(p.percent).toBe(0);
    expect(p.complete).toBe(false);
  });

  it("de-duplicates repeated rows for one page", () => {
    const p = summarizeProgress(3, [page(2, false), page(2, true, 6)]);
    expect(p.attempted).toBe(1);
    expect(p.done).toBe(1);
    expect(p.marks).toBe(6);
    expect(p.failed).toEqual([]);
  });
});

describe("pendingPages", () => {
  it("returns every page for a run that never started", () => {
    expect(pendingPages(4, [])).toEqual([1, 2, 3, 4]);
  });

  it("resumes at the first page that never completed", () => {
    expect(pendingPages(5, [page(1, true), page(2, true), page(3, true)])).toEqual([4, 5]);
  });

  it("retries pages that completed but failed", () => {
    expect(pendingPages(4, [page(1, true), page(2, false), page(3, true), page(4, true)])).toEqual([2]);
  });

  it("treats a clean page with zero marks as done", () => {
    expect(pendingPages(2, [page(1, true, 0), page(2, true, 3)])).toEqual([]);
  });

  it("honours an explicit subset for a targeted retry", () => {
    expect(pendingPages(6, [page(1, true)], [3, 1, 3])).toEqual([1, 3]);
  });

  it("drops out-of-range pages from an explicit subset", () => {
    expect(pendingPages(3, [], [0, 2, 99])).toEqual([2]);
  });

  it("returns nothing when the page count is unknown", () => {
    expect(pendingPages(0, [])).toEqual([]);
  });
});

describe("canResumeExtraction", () => {
  const stuck = { kind: "specs", status: "extracting" };

  it("offers resume for a specs planset parked in extracting", () => {
    expect(canResumeExtraction(stuck, null, "p1")).toBe(true);
  });

  it("does not offer resume while this tab is driving the run", () => {
    expect(canResumeExtraction(stuck, "p1", "p1")).toBe(false);
  });

  it("offers resume when a different planset is running", () => {
    expect(canResumeExtraction(stuck, "other", "p1")).toBe(true);
  });

  it("ignores plansets that are not mid-extraction", () => {
    expect(canResumeExtraction({ kind: "specs", status: "ready" }, null, "p1")).toBe(false);
    expect(canResumeExtraction({ kind: "specs", status: "failed" }, null, "p1")).toBe(false);
  });

  it("ignores building plansets", () => {
    expect(canResumeExtraction({ kind: "building", status: "extracting" }, null, "p1")).toBe(false);
  });

  it("handles a missing planset", () => {
    expect(canResumeExtraction(null, null, "p1")).toBe(false);
    expect(canResumeExtraction(undefined, null, "p1")).toBe(false);
  });
});

describe("describeProgress", () => {
  it("names the page being read during a live run", () => {
    const p = summarizeProgress(14, [page(1, true, 3)]);
    expect(describeProgress(p, 2)).toBe("Reading page 2 of 14 · 3 marks so far");
  });

  it("uses the singular for one mark", () => {
    const p = summarizeProgress(4, [page(1, true, 1)]);
    expect(describeProgress(p, 2)).toContain("1 mark so far");
  });

  it("reports a clean finish", () => {
    const p = summarizeProgress(2, [page(1, true, 4), page(2, true, 2)]);
    expect(describeProgress(p, null)).toBe("Finished all 2 pages · 6 marks so far");
  });

  it("calls out pages that still need re-reading", () => {
    const p = summarizeProgress(2, [page(1, true, 4), page(2, false)]);
    expect(describeProgress(p, null)).toContain("1 still need re-reading");
  });

  it("describes an interrupted run in terms of what is left", () => {
    const p = summarizeProgress(14, [page(1, true, 2), page(2, true, 1)]);
    expect(describeProgress(p, null)).toBe("Stopped after 2 of 14 pages · 12 left · 3 marks so far");
  });

  it("says preparing when the page count is unknown", () => {
    expect(describeProgress(summarizeProgress(0, []), null)).toBe("Preparing…");
  });
});
