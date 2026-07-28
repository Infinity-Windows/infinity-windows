import { describe, expect, it } from "vitest";
import {
  describeSpecPages,
  emptySpecPages,
  failedSpecPages,
  formatPageList,
  parseSpecPageStatus,
  parseSpecPageStatuses,
  type SpecPageStatus,
} from "./specPageStatus";

/** A successful page as the edge function reports it. */
function page(
  pageNumber: number,
  over: Partial<SpecPageStatus> = {},
): SpecPageStatus {
  return { pageNumber, ok: true, attempts: 1, markCount: 4, error: null, ...over };
}

describe("parseSpecPageStatus", () => {
  it("parses a healthy page", () => {
    expect(
      parseSpecPageStatus({ pageNumber: 3, ok: true, attempts: 1, markCount: 5 }),
    ).toEqual({ pageNumber: 3, ok: true, attempts: 1, markCount: 5, error: null });
  });

  it("parses a failed page and keeps the short reason", () => {
    expect(
      parseSpecPageStatus({
        pageNumber: 5,
        ok: false,
        attempts: 3,
        markCount: 0,
        error: "Anthropic vision chat failed: 529 overloaded",
      }),
    ).toEqual({
      pageNumber: 5,
      ok: false,
      attempts: 3,
      markCount: 0,
      error: "Anthropic vision chat failed: 529 overloaded",
    });
  });

  it("treats a missing ok as success so an older function looks healthy", () => {
    expect(parseSpecPageStatus({ pageNumber: 2 })?.ok).toBe(true);
  });

  it("rejects entries with no usable page number", () => {
    expect(parseSpecPageStatus({ ok: true })).toBeNull();
    expect(parseSpecPageStatus({ pageNumber: 0 })).toBeNull();
    expect(parseSpecPageStatus({ pageNumber: 1.5 })).toBeNull();
    expect(parseSpecPageStatus(null)).toBeNull();
    expect(parseSpecPageStatus("page 3")).toBeNull();
  });

  it("coerces loose numbers and blank errors", () => {
    expect(
      parseSpecPageStatus({
        pageNumber: "4",
        ok: false,
        attempts: "3",
        markCount: "0",
        error: "   ",
      }),
    ).toEqual({ pageNumber: 4, ok: false, attempts: 3, markCount: 0, error: null });
  });
});

describe("parseSpecPageStatuses", () => {
  it("sorts by page and drops junk", () => {
    const parsed = parseSpecPageStatuses([
      { pageNumber: 3, ok: true, markCount: 2 },
      "nope",
      { pageNumber: 1, ok: true, markCount: 5 },
      null,
    ]);
    expect(parsed.map((p) => p.pageNumber)).toEqual([1, 3]);
  });

  it("returns [] for a missing or non-array payload", () => {
    expect(parseSpecPageStatuses(undefined)).toEqual([]);
    expect(parseSpecPageStatuses({})).toEqual([]);
  });
});

describe("failedSpecPages / emptySpecPages", () => {
  const pages = [
    page(1),
    page(2, { ok: false, attempts: 3, markCount: 0, error: "429 rate limited" }),
    page(3, { markCount: 0 }),
  ];

  it("separates a failure from a legitimately empty sheet", () => {
    expect(failedSpecPages(pages).map((p) => p.pageNumber)).toEqual([2]);
    expect(emptySpecPages(pages).map((p) => p.pageNumber)).toEqual([3]);
  });
});

describe("formatPageList", () => {
  it("reads like a person listing pages", () => {
    expect(formatPageList([page(5)])).toBe("5");
    expect(formatPageList([page(5), page(6)])).toBe("5 and 6");
    expect(formatPageList([page(5), page(6), page(9)])).toBe("5, 6 and 9");
    expect(formatPageList([])).toBe("");
  });
});

describe("describeSpecPages", () => {
  it("says nothing when all six Smith pages read cleanly", () => {
    const pages = [1, 2, 3, 4, 5, 6].map((n) => page(n));
    expect(describeSpecPages(pages)).toBeNull();
  });

  it("names the failed page and how hard we tried", () => {
    expect(
      describeSpecPages([
        page(4),
        page(5, { ok: false, attempts: 3, markCount: 0, error: "529 overloaded" }),
      ]),
    ).toBe("Page 5 of the specs sheet failed to read after 3 attempts.");
  });

  it("reports several failed pages together", () => {
    expect(
      describeSpecPages([
        page(2, { ok: false, attempts: 3, markCount: 0, error: "timeout" }),
        page(5, { ok: false, attempts: 3, markCount: 0, error: "timeout" }),
      ]),
    ).toBe("Pages 2 and 5 of the specs sheet failed to read after 3 attempts.");
  });

  it("mentions empty pages more gently, alongside failures", () => {
    expect(
      describeSpecPages([
        page(1, { markCount: 0 }),
        page(5, { ok: false, attempts: 3, markCount: 0, error: "timeout" }),
      ]),
    ).toBe(
      "Page 5 of the specs sheet failed to read after 3 attempts. Page 1 has no marks on it.",
    );
  });

  it("handles an unreadable page image, which never got an attempt", () => {
    expect(
      describeSpecPages([
        page(3, { ok: false, attempts: 0, markCount: 0, error: "page image missing" }),
      ]),
    ).toBe("Page 3 of the specs sheet failed to read.");
  });
});
