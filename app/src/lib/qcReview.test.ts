import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("./supabase", () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

const {
  classifyQcReviewDecisionError,
  fetchQcReviewJobs,
  fetchQcReviewPage,
  normalizeQcReviewNote,
  recordQcReviewDecision,
} = await import("./qcReview");

beforeEach(() => {
  rpc.mockReset();
});

describe("normalizeQcReviewNote", () => {
  it("turns blank/whitespace notes into null, never an empty string", () => {
    expect(normalizeQcReviewNote(undefined)).toBeNull();
    expect(normalizeQcReviewNote(null)).toBeNull();
    expect(normalizeQcReviewNote("   ")).toBeNull();
    expect(normalizeQcReviewNote("  trimmed  ")).toBe("trimmed");
  });
});

describe("fetchQcReviewJobs", () => {
  it("sends the exact RPC args, defaulting search/limit/after/selectedProjectId", async () => {
    rpc.mockResolvedValue({ data: { rows: [], totalCount: 0, hasMore: false, nextCursor: null, selected: null }, error: null });
    await fetchQcReviewJobs({});
    expect(rpc).toHaveBeenCalledWith("qc_review_jobs", { p_search: "", p_limit: 50, p_after: null, p_selected_project_id: null });
  });

  it("passes the previous page's cursor back verbatim, and the selected project id", async () => {
    rpc.mockResolvedValue({ data: { rows: [], totalCount: 0, hasMore: false, nextCursor: null, selected: null }, error: null });
    const cursor = { name: "Zed Co", id: "11111111-1111-4111-8111-111111111111" };
    await fetchQcReviewJobs({ search: "zed", limit: 20, after: cursor, selectedProjectId: "job-9" });
    expect(rpc).toHaveBeenCalledWith("qc_review_jobs", { p_search: "zed", p_limit: 20, p_after: cursor, p_selected_project_id: "job-9" });
  });

  it("throws the raw error on failure, for formatApiError upstream to read", async () => {
    const err = { code: "42501", message: "nope" };
    rpc.mockResolvedValue({ data: null, error: err });
    await expect(fetchQcReviewJobs({})).rejects.toBe(err);
  });
});

describe("fetchQcReviewPage", () => {
  it("sends every arg under its documented name, with only one of after/before meaningful", async () => {
    rpc.mockResolvedValue({
      data: { rows: [], totalCount: 0, hasNext: false, hasPrevious: false, nextCursor: null, previousCursor: null, selected: null },
      error: null,
    });
    await fetchQcReviewPage({
      projectId: "job-1", filter: "callbacks", search: "A1", limit: 25,
      after: { endedAt: "2026-01-01T00:00:00Z", id: "22222222-2222-4222-8222-222222222222" },
      selectedOpeningId: "33333333-3333-4333-8333-333333333333",
    });
    expect(rpc).toHaveBeenCalledWith("qc_review_page", {
      p_project_id: "job-1",
      p_filter: "callbacks",
      p_search: "A1",
      p_limit: 25,
      p_after: { endedAt: "2026-01-01T00:00:00Z", id: "22222222-2222-4222-8222-222222222222" },
      p_before: null,
      p_selected_opening_id: "33333333-3333-4333-8333-333333333333",
    });
  });
});

describe("recordQcReviewDecision", () => {
  it("binds decisionId to the exact payload and normalizes the note", async () => {
    rpc.mockResolvedValue({ data: "decision-1", error: null });
    const result = await recordQcReviewDecision({
      decisionId: "44444444-4444-4444-8444-444444444444",
      projectId: "job-1",
      openingId: "opening-1",
      status: "passed",
      expectedReviewVersion: "none",
      note: "  looks good  ",
    });
    expect(result).toBe("decision-1");
    expect(rpc).toHaveBeenCalledWith("record_qc_review_decision", {
      p_decision_id: "44444444-4444-4444-8444-444444444444",
      p_project_id: "job-1",
      p_opening_id: "opening-1",
      p_status: "passed",
      p_expected_review_version: "none",
      p_note: "looks good",
    });
  });

  it("retries with the exact same payload and id on a transport failure", async () => {
    const args = {
      decisionId: "55555555-5555-4555-8555-555555555555",
      projectId: "job-1", openingId: "opening-1", status: "callback" as const,
      expectedReviewVersion: "v1", note: null,
    };
    rpc.mockResolvedValueOnce({ data: null, error: { message: "Failed to fetch" } });
    await expect(recordQcReviewDecision(args)).rejects.toBeTruthy();
    rpc.mockResolvedValueOnce({ data: "decision-2", error: null });
    await expect(recordQcReviewDecision(args)).resolves.toBe("decision-2");
    expect(rpc).toHaveBeenNthCalledWith(1, "record_qc_review_decision", expect.objectContaining({ p_decision_id: args.decisionId }));
    expect(rpc).toHaveBeenNthCalledWith(2, "record_qc_review_decision", expect.objectContaining({ p_decision_id: args.decisionId }));
  });
});

describe("classifyQcReviewDecisionError", () => {
  it.each([
    ["40001", "stale"],
    ["23505", "conflict"],
    ["42501", "unauthorized"],
    ["22023", "unavailable"],
    ["22021", "rejected"],
    ["22P02", "rejected"],
    ["PGRST202", "rejected"],
    ["42883", "rejected"],
    ["99999", "unknown"],
    [undefined, "unknown"],
  ])("maps SQLSTATE %s to %s", (code, kind) => {
    expect(classifyQcReviewDecisionError(code === undefined ? new Error("boom") : { code })).toBe(kind);
  });
});


describe("QC request ownership signals", () => {
  it.each(["jobs", "page", "decision"])("passes a request-local AbortSignal to %s without serializing it", async kind => {
    const signal = new AbortController().signal;
    const result = { data: kind === "decision" ? "id" : { rows: [], totalCount: 0, selected: null }, error: null };
    const abortSignal = vi.fn(() => Promise.resolve(result));
    rpc.mockReturnValue({ abortSignal });
    if (kind === "jobs") await fetchQcReviewJobs({ signal });
    else if (kind === "page") await fetchQcReviewPage({ projectId: "job", filter: "all", signal });
    else await recordQcReviewDecision({ decisionId:"id", projectId:"job", openingId:"unit", status:"passed", expectedReviewVersion:"none", signal });
    expect(abortSignal).toHaveBeenCalledExactlyOnceWith(signal);
    expect(rpc.mock.calls[0][1]).not.toHaveProperty("signal");
  });
});

describe("ambiguous submission stays unresolved across refused retries", () => {
  it.each(["42501", "22023", "22021", "PGRST202", "42883", "40001", "23505"])("does not clear the original uncertainty on generic %s", code => {
    expect(classifyQcReviewDecisionError({code, message:"Later attempt failed"}, true)).toBe("unknown");
  });
  it("accepts only a guarded endpoint refusal reached after immutable-event lookup", () => {
    expect(classifyQcReviewDecisionError({code:"40001",message:"QC changed since you opened this unit. Refresh and review the current decision."}, true)).toBe("stale");
    expect(classifyQcReviewDecisionError({code:"23505",message:"This QC request ID was already used for another decision."}, true)).toBe("conflict");
  });
});
