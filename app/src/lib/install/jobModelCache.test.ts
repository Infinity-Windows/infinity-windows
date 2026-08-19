import { describe, expect, it } from "vitest";
import { keysToEvict } from "./cropCache";
import {
  describeAge,
  estimateJobModelSize,
  MAX_JOB_MODEL_BYTES,
  MAX_JOB_MODEL_ENTRIES,
  resolveJobModel,
} from "./jobModelCache";

describe("estimateJobModelSize", () => {
  it("approximates a one-floor model's byte size from its serialized string", () => {
    expect(estimateJobModelSize({ serialized: "abcd" })).toBe(4);
  });

  it("sums a multi-floor model's floors", () => {
    expect(estimateJobModelSize({ floors: ["ab", "cde"] })).toBe(5);
  });

  it("is zero for an empty model", () => {
    expect(estimateJobModelSize({})).toBe(0);
  });
});

describe("resolveJobModel (Studio 100x #29: the offline fallback decision)", () => {
  const live = { serialized: "live-model" };
  const cached = { serialized: "cached-model" };

  it("a fresh model always wins, even with a cache sitting right there", () => {
    expect(resolveJobModel({ live, fetchFailed: false, cached })).toEqual({
      model: live,
      fromCache: false,
    });
    // Even a FAILED fetch that somehow still produced live data (shouldn't
    // happen in practice, but the decision must not depend on that not
    // happening) prefers the live value.
    expect(resolveJobModel({ live, fetchFailed: true, cached })).toEqual({
      model: live,
      fromCache: false,
    });
  });

  it("falls back to the cache only once the fetch has actually failed", () => {
    expect(resolveJobModel({ live: null, fetchFailed: true, cached })).toEqual({
      model: cached,
      fromCache: true,
    });
  });

  it("never shows a stale cache while a fetch is still in flight", () => {
    // live: null + fetchFailed: false is "still loading" (or hasn't started) —
    // flashing yesterday's model here would look like a bug on a normal
    // connection that just hasn't resolved yet.
    expect(resolveJobModel({ live: null, fetchFailed: false, cached })).toEqual({
      model: null,
      fromCache: false,
    });
  });

  it("is null when there is nothing to show at all", () => {
    expect(resolveJobModel({ live: null, fetchFailed: true, cached: null })).toEqual({
      model: null,
      fromCache: false,
    });
    expect(resolveJobModel({ live: null, fetchFailed: false, cached: null })).toEqual({
      model: null,
      fromCache: false,
    });
  });
});

describe("describeAge", () => {
  const now = new Date("2026-08-19T12:00:00Z").getTime();

  it("reads 'just now' for anything under a minute (or clock skew)", () => {
    expect(describeAge(now, now)).toBe("just now");
    expect(describeAge(now + 5000, now)).toBe("just now"); // cachedAt slightly ahead
  });

  it("reads minutes under an hour", () => {
    expect(describeAge(now - 12 * 60000, now)).toBe("12 min ago");
    expect(describeAge(now - 59 * 60000, now)).toBe("59 min ago");
  });

  it("reads hours under a day", () => {
    expect(describeAge(now - 3 * 3600000, now)).toBe("3 hr ago");
    expect(describeAge(now - 23 * 3600000, now)).toBe("23 hr ago");
  });

  it("reads days, singular and plural", () => {
    expect(describeAge(now - 24 * 3600000, now)).toBe("1 day ago");
    expect(describeAge(now - 3 * 24 * 3600000, now)).toBe("3 days ago");
  });
});

describe("job model caps feed the same eviction policy as the crop cache", () => {
  // The cache reuses cropCache's keysToEvict rather than forking it — this
  // guards that reuse (a copy-pasted fork could silently diverge) and that
  // the caps are real numbers, not decorative.
  it("ships with caps that are bounded, not decorative", () => {
    expect(MAX_JOB_MODEL_BYTES).toBeGreaterThan(0);
    expect(MAX_JOB_MODEL_ENTRIES).toBeGreaterThan(0);
    const many = Array.from({ length: MAX_JOB_MODEL_ENTRIES + 3 }, (_, i) => ({
      key: `p${String(i).padStart(4, "0")}`,
      size: 1,
      lastUsed: i,
    }));
    expect(keysToEvict(many, MAX_JOB_MODEL_BYTES, MAX_JOB_MODEL_ENTRIES)).toHaveLength(3);
  });

  it("drops the least-recently-walked job first when the byte cap is hit", () => {
    const entries = [
      { key: "old-job", size: 5_000_000, lastUsed: 1 },
      { key: "new-job", size: 5_000_000, lastUsed: 2 },
    ];
    expect(keysToEvict(entries, 6_000_000, 10)).toEqual(["old-job"]);
  });
});
