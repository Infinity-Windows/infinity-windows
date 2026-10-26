import { expect, it } from "vitest";
import type { ActivityRow } from "./activityRows";
import type { WorkUnit } from "../../lib/customWork/model";
import { relativeWeeklyUnitRates, weeklyUnitRates } from "./weeklyUnitRateData";
import { midnight } from "./generalLabor";
const units = [{ id: "u", opening_id: "o", project_id: "j", facts: { width_in: 24, height_in: 12 } }, { id: "v", opening_id: "p", project_id: "j", facts: { width_in: 12, height_in: 12 } }] as WorkUnit[];
const row = (id: string, started: string, ended: string, seconds: number, unitId = "u") => ({ id, started, ended, seconds, unitId, scope: "Specific", jobId: "j", job: "J", unit: unitId, activity: "Install", personId: id, person: id } as ActivityRow);
it("splits a Sunday overnight timer at Denver Monday and conserves clipped minutes", () => {
  const rows = [row("p", "2026-10-19T05:30:00Z", "2026-10-19T06:30:00Z", 3600)];
  const result = weeklyUnitRates(rows, units, midnight("2026-10-12"), midnight("2026-10-26"), midnight("2026-10-26"));
  expect(result.points.map(point => [point.week, point.seconds, point.value])).toEqual([["2026-10-12", 1800, 15], ["2026-10-19", 1800, 15]]);
  const clipped = weeklyUnitRates([{ ...rows[0], seconds: 1800 }], units, midnight("2026-10-19"), midnight("2026-10-26"), midnight("2026-10-26"));
  expect(clipped.points[0].seconds).toBe(1800);
});
it("counts opening area once per job/week and computes a median of unit rates, not a ratio of sums", () => {
  const result = weeklyUnitRates([row("a", "2026-10-20T12:00:00Z", "2026-10-20T12:02:00Z", 120), row("b", "2026-10-20T12:00:00Z", "2026-10-20T12:01:00Z", 60), row("c", "2026-10-20T12:00:00Z", "2026-10-20T12:06:00Z", 360, "v")], units, midnight("2026-10-12"), midnight("2026-10-26"), midnight("2026-10-26"));
  expect(result.weeks).toEqual(["2026-10-12", "2026-10-19"]);
  expect(result.points.map(point => point.value)).toEqual([1.5, 6]);
  expect(result.medians[0]).toMatchObject({ value: 3.75, count: 2 });
});
it("handles DST weeks, excludes unknown area, and marks incomplete windows", () => {
  const start = midnight("2026-10-26"), end = midnight("2026-11-02");
  expect((end - start) / 3600000).toBe(169);
  const result = weeklyUnitRates([row("a", new Date(start).toISOString(), new Date(end).toISOString(), (end - start) / 1000), row("bad", "bad", "bad", 60), row("unknown", "2026-10-27T12:00:00Z", "2026-10-27T12:01:00Z", 60, "absent")], units, start, end, end);
  expect(result.points[0].seconds).toBe(169 * 3600); expect(result.unlinked).toBe(1); expect(result.invalid).toBe(1);
  expect(result.partialWeeks).toEqual([]);
  expect(weeklyUnitRates([], units, midnight("2026-10-28"), end, end).partialWeeks).toEqual(["2026-10-26"]);
});

it("aligns job-start weeks without assuming shared calendar dates or phases", () => {
  const otherUnits = [...units, { ...units[0], id: "b", project_id: "B", opening_id: "bo" }] as WorkUnit[];
  const a = row("a", "2026-09-09T12:00:00Z", "2026-09-09T12:02:00Z", 120);
  const b = { ...row("b", "2026-09-30T12:00:00Z", "2026-09-30T12:01:00Z", 60, "b"), jobId: "B" };
  const report = relativeWeeklyUnitRates([a, b], otherUnits, new Map([["j", "2026-09-02"], ["B", "2026-09-28"]]), 4, midnight("2026-11-01"));
  expect(report.weeks).toEqual(["Week 1", "Week 2", "Week 3", "Week 4"]);
  expect(report.points.map(point => [point.jobId, point.week, point.actualWeek, point.seconds])).toEqual([["j", "Week 2", "2026-09-09", 120], ["B", "Week 1", "2026-09-28", 60]]);
  expect(report.points.reduce((sum, point) => sum + point.seconds, 0)).toBe(180);
  expect(relativeWeeklyUnitRates([a, b], otherUnits, new Map(), 4).points).toEqual([]);
});
it("splits at a job's own seven-day boundary and clips beyond the requested week count", () => {
  const a = row("a", "2026-09-09T05:30:00Z", "2026-09-09T06:30:00Z", 3600);
  const report = relativeWeeklyUnitRates([a], units, new Map([["j", "2026-09-02"]]), 1, midnight("2026-11-01"));
  expect(report.points).toHaveLength(1);
  expect(report.points[0].seconds).toBe(1800);
});

it("allows minutes per opening and linked timer hours without inventing area or counting unlinked labor", () => {
  const noArea = [{ ...units[0], facts: {} }] as WorkUnit[];
  const linked = row("a", "2026-10-20T12:00:00Z", "2026-10-20T12:02:00Z", 120);
  const unlinked = { ...linked, id: "bad", unitId: "absent", seconds: 10000 };
  const general = { ...linked, id: "general", scope: "General", seconds: 10000 };
  const args = [linked, unlinked, general];
  const start = midnight("2026-10-19"), end = midnight("2026-10-26");
  const opening = weeklyUnitRates(args, noArea, start, end, end, undefined, "opening");
  expect(opening.points[0].value).toBe(2); expect(opening.unlinked).toBe(1);
  const area = weeklyUnitRates(args, noArea, start, end, end, undefined, "area");
  expect(area.points).toEqual([]); expect(area.excluded).toBe(1);
  const hours = weeklyUnitRates(args, noArea, start, end, end, undefined, "hours");
  expect(hours.points[0].seconds).toBe(120); expect(hours.points[0].value).toBeCloseTo(120 / 3600);
});
