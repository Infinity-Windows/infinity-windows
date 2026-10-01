// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_QC_REVIEW_VIEW,
  buildQcReviewSearchParams,
  clearQcReviewSession,
  createQcReviewDecisionIds,
  decodeQcReviewCursorParam,
  encodeQcReviewCursorParam,
  isQcReviewFilter,
  isUuid,
  parseQcReviewUrlState,
  qcReviewDecisionKey,
  readQcReviewSession,
  sanitizeQcReviewCursor,
  writeQcReviewSession,
  type QcReviewViewState,
} from "./qcReviewState";

const JOB = "11111111-1111-4111-8111-111111111111";
const SEL = "22222222-2222-4222-8222-222222222222";
const VIEWER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("isUuid / isQcReviewFilter", () => {
  it("accepts only well-formed UUIDs", () => {
    expect(isUuid(JOB)).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
  it("accepts only the three documented filters", () => {
    expect(isQcReviewFilter("all")).toBe(true);
    expect(isQcReviewFilter("new")).toBe(true);
    expect(isQcReviewFilter("callbacks")).toBe(true);
    expect(isQcReviewFilter("passed")).toBe(false);
    expect(isQcReviewFilter(undefined)).toBe(false);
  });
});

describe("cursor encode/decode", () => {
  it("round-trips a valid cursor through a URL-safe string", () => {
    const cursor = { endedAt: "2026-01-01T00:00:00Z", id: JOB };
    const encoded = encodeQcReviewCursorParam(cursor);
    expect(encoded).not.toBeNull();
    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeQcReviewCursorParam(encoded)).toEqual(cursor);
  });
  it("round-trips a null endedAt", () => {
    const cursor = { endedAt: null, id: JOB };
    expect(decodeQcReviewCursorParam(encodeQcReviewCursorParam(cursor))).toEqual(cursor);
  });
  it("fails closed on corrupted, oversized, or hand-edited input", () => {
    expect(decodeQcReviewCursorParam(null)).toBeNull();
    expect(decodeQcReviewCursorParam("not base64 json")).toBeNull();
    expect(decodeQcReviewCursorParam("a".repeat(1000))).toBeNull();
    expect(sanitizeQcReviewCursor({ endedAt: "x", id: "not-a-uuid" })).toBeNull();
    expect(sanitizeQcReviewCursor({ endedAt: 5, id: JOB })).toBeNull();
    expect(sanitizeQcReviewCursor(null)).toBeNull();
    expect(sanitizeQcReviewCursor({ endedAt: "not-a-date", id: JOB })).toBeNull();
  });
});

describe("parseQcReviewUrlState / buildQcReviewSearchParams", () => {
  it("round-trips a full view through the URL", () => {
    const state: QcReviewViewState = {
      job: JOB, filter: "callbacks", search: "west wing", sel: SEL,
      after: { endedAt: "2026-02-01T00:00:00Z", id: SEL }, before: null,
    };
    const params = buildQcReviewSearchParams(state);
    expect(parseQcReviewUrlState(params)).toEqual(state);
  });

  it("defaults every field from an empty URL", () => {
    expect(parseQcReviewUrlState(new URLSearchParams())).toEqual(DEFAULT_QC_REVIEW_VIEW);
  });

  it("rejects an invalid job/sel UUID and an unknown filter instead of throwing", () => {
    const params = new URLSearchParams({ job: "../../etc", sel: "<script>", filter: "bogus", q: "ok" });
    expect(parseQcReviewUrlState(params)).toEqual({ ...DEFAULT_QC_REVIEW_VIEW, search: "ok" });
  });

  it("caps an oversized search string", () => {
    const params = new URLSearchParams({ q: "x".repeat(5000) });
    expect(parseQcReviewUrlState(params).search.length).toBeLessThanOrEqual(200);
  });

  it("keeps only one of after/before when both are present", () => {
    const after = encodeQcReviewCursorParam({ endedAt: null, id: JOB })!;
    const before = encodeQcReviewCursorParam({ endedAt: null, id: SEL })!;
    const params = new URLSearchParams({ after, before });
    const parsed = parseQcReviewUrlState(params);
    expect(parsed.after).toEqual({ endedAt: null, id: JOB });
    expect(parsed.before).toBeNull();
  });

  it("omits default-valued fields when writing the URL, to keep it clean", () => {
    const params = buildQcReviewSearchParams(DEFAULT_QC_REVIEW_VIEW);
    expect([...params.keys()]).toEqual([]);
  });

  it("preserves unrelated existing params", () => {
    const existing = new URLSearchParams({ tab: "exceptions" });
    const params = buildQcReviewSearchParams({ ...DEFAULT_QC_REVIEW_VIEW, job: JOB }, existing);
    expect(params.get("tab")).toBe("exceptions");
    expect(params.get("job")).toBe(JOB);
  });
});

describe("session storage, scoped per real viewer", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("round-trips a saved view for one viewer", () => {
    const state: QcReviewViewState = { ...DEFAULT_QC_REVIEW_VIEW, job: JOB, filter: "new", search: "a1" };
    writeQcReviewSession(VIEWER_A, state);
    expect(readQcReviewSession(VIEWER_A)).toEqual(state);
  });

  it("never hands one viewer's restored scope to another", () => {
    writeQcReviewSession(VIEWER_A, { ...DEFAULT_QC_REVIEW_VIEW, job: JOB });
    expect(readQcReviewSession(VIEWER_B)).toBeNull();
  });

  it("reads nothing for a missing or empty viewer id", () => {
    expect(readQcReviewSession(null)).toBeNull();
    expect(readQcReviewSession(undefined)).toBeNull();
    expect(readQcReviewSession("")).toBeNull();
  });

  it("clears without throwing when nothing was ever stored", () => {
    expect(() => clearQcReviewSession(VIEWER_A)).not.toThrow();
  });

  it("treats corrupted stored JSON as nothing to restore", () => {
    window.sessionStorage.setItem(`qcReview:v1:${VIEWER_A}`, "{not json");
    expect(readQcReviewSession(VIEWER_A)).toBeNull();
  });

  it("drops an invalid UUID or filter found in storage rather than restoring it", () => {
    window.sessionStorage.setItem(`qcReview:v1:${VIEWER_A}`, JSON.stringify({ job: "bad", filter: "nope", search: "ok", sel: null, after: null, before: null }));
    expect(readQcReviewSession(VIEWER_A)).toEqual({ ...DEFAULT_QC_REVIEW_VIEW, search: "ok" });
  });

  it("clear removes only that viewer's entry", () => {
    writeQcReviewSession(VIEWER_A, { ...DEFAULT_QC_REVIEW_VIEW, job: JOB });
    writeQcReviewSession(VIEWER_B, { ...DEFAULT_QC_REVIEW_VIEW, job: SEL });
    clearQcReviewSession(VIEWER_A);
    expect(readQcReviewSession(VIEWER_A)).toBeNull();
    expect(readQcReviewSession(VIEWER_B)?.job).toBe(SEL);
  });
  it("normalizes cursor UUIDs without losing timestamp precision and keeps one direction", () => {
    const after = { endedAt: "2026-09-01T10:00:00.123456+00:00", id: VIEWER_A.toUpperCase() };
    window.sessionStorage.setItem(`qcReview:v1:${VIEWER_A}`, JSON.stringify({
      ...DEFAULT_QC_REVIEW_VIEW, job: VIEWER_B.toUpperCase(), after,
      before: { endedAt: null, id: SEL },
    }));
    expect(readQcReviewSession(VIEWER_A)).toEqual({ ...DEFAULT_QC_REVIEW_VIEW,
      job: VIEWER_B, after: { ...after, id: VIEWER_A }, before: null });
  });
});

describe("decision-id binding", () => {
  it("returns the same id for the same key, a different id once the key changes", () => {
    const ids = createQcReviewDecisionIds();
    const keyA = qcReviewDecisionKey({ projectId: JOB, openingId: SEL, status: "passed", note: null, expectedReviewVersion: "none" });
    const keyB = qcReviewDecisionKey({ projectId: JOB, openingId: SEL, status: "passed", note: "different note", expectedReviewVersion: "none" });
    const first = ids.idFor(keyA);
    expect(ids.idFor(keyA)).toBe(first);
    expect(ids.idFor(keyB)).not.toBe(first);
  });

  it("mints a fresh id once the old one is forgotten", () => {
    const ids = createQcReviewDecisionIds();
    const key = qcReviewDecisionKey({ projectId: JOB, openingId: SEL, status: "callback", note: null, expectedReviewVersion: "v1" });
    const first = ids.idFor(key);
    ids.forget(key);
    expect(ids.idFor(key)).not.toBe(first);
  });

  it("a refreshed expectedReviewVersion after a stale retry forces a new id", () => {
    const ids = createQcReviewDecisionIds();
    const staleKey = qcReviewDecisionKey({ projectId: JOB, openingId: SEL, status: "passed", note: null, expectedReviewVersion: "v1" });
    const refreshedKey = qcReviewDecisionKey({ projectId: JOB, openingId: SEL, status: "passed", note: null, expectedReviewVersion: "v2" });
    expect(ids.idFor(staleKey)).not.toBe(ids.idFor(refreshedKey));
  });
});

afterEach(() => {
  window.sessionStorage.clear();
});
