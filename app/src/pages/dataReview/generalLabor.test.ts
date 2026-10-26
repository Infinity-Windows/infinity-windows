import { expect, it } from "vitest";
import type { ActivityRow } from "./activityRows";
import { generalLabor, midnight } from "./generalLabor";
const row = (id: string, activity: string, started: string, ended: string) => ({ id, activity, scope: "General", started, ended } as ActivityRow);
it("splits a visit at Monday midnight and keeps weekly percentages on all General labor", () => {
  const rows = [row("a", "Problem solving", "2026-10-19T05:00:00Z", "2026-10-19T07:00:00Z"), row("b", "Cleanup", "2026-10-19T07:00:00Z", "2026-10-19T08:00:00Z")];
  const buckets = generalLabor(rows, "Problem solving", true, -Infinity, Infinity, Date.parse("2026-10-27T00:00:00Z"));
  expect(buckets.map(b => [b.key, b.seconds, b.percent])).toEqual([["2026-10-12", 3600, 100], ["2026-10-19", 3600, 50]]);
  expect(buckets[1].ids).toEqual(["a"]);
  expect(buckets[1].segments).toEqual([{ activity: "Problem solving", seconds: 3600, ids: ["a"] }]);
});
it("uses Denver DST boundaries, clips dates, and keeps empty intervening weeks", () => {
  expect(midnight("2026-11-02") - midnight("2026-11-01")).toBe(25 * 3600000);
  const rows = [row("a", "Cleanup", "2026-10-05T06:00:00Z", "2026-10-05T08:00:00Z"), row("b", "Cleanup", "2026-10-19T06:00:00Z", "2026-10-19T07:00:00Z")];
  const buckets = generalLabor(rows, null, true, Date.parse("2026-10-05T07:00:00Z"), Infinity, Date.parse("2026-10-20T00:00:00Z"));
  expect(buckets.map(b => b.seconds)).toEqual([3600, 0, 3600]);
  expect(buckets[0].partial).toBe(true);
  expect(buckets[1].percent).toBeNull();
  expect(buckets[2].partial).toBe(true);
});
it("uses all activities as the activity-share denominator", () => {
  const rows = [row("a", "Cleanup", "2026-10-19T06:00:00Z", "2026-10-19T07:00:00Z"), row("b", "Problem solving", "2026-10-19T07:00:00Z", "2026-10-19T10:00:00Z")];
  expect(generalLabor(rows, "Cleanup", false, -Infinity, Infinity, Date.parse("2026-10-27T00:00:00Z"))[0].percent).toBe(25);
});


it("aggregates Specific and General evidence across the job timeline with gap weeks", () => {
  const rows = [
    { ...row("install", "Install", "2026-10-05T06:00:00Z", "2026-10-05T08:00:00Z"), scope: "Specific" },
    row("support", "Cleanup", "2026-10-19T06:00:00Z", "2026-10-19T07:00:00Z"),
  ];
  const buckets = generalLabor(rows, null, true, -Infinity, Infinity, Date.parse("2026-10-27T00:00:00Z"), "all");
  expect(buckets.map(bucket => [bucket.key, bucket.seconds])).toEqual([["2026-10-05", 7200], ["2026-10-12", 0], ["2026-10-19", 3600]]);
  expect(buckets[0].segments[0].ids).toEqual(["install"]);
  expect(buckets[2].segments[0].ids).toEqual(["support"]);
});
