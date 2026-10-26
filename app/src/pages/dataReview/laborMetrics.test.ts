import { expect, it } from "vitest";
import type { WorkUnit } from "../../lib/customWork/model";
import type { ActivityRow } from "./activityRows";
import { laborMetricContext } from "./laborMetrics";

const unit = (id: string, opening: string | null, width?: number): WorkUnit => ({ id, opening_id: opening, project_id: "job", facts: { width_in: width, height_in: 12 } }) as WorkUnit;
const row = (id: string, unitId: string | null, seconds: number, scope = "Specific"): ActivityRow => ({ id, jobId: "job", unitId, seconds, scope }) as ActivityRow;

it("counts an opening's area once across people, visits and activity segments", () => {
  const rows = [row("a", "u", 600), row("b", "u", 1200), row("c", "v", 600), row("g", null, 600, "General")];
  const units = [unit("u", "o", 24), unit("v", "o2", 12)];
  const area = laborMetricContext(rows, units, "area");
  expect(area.measure([rows[3]], rows).value).toBeNull();
  expect(area.measure(rows)).toMatchObject({ value: 40 / 3, area: 3, openings: 2, seconds: 2400 });
  expect(area.measure([rows[0]], rows).value! + area.measure(rows.slice(1), rows).value!).toBeCloseTo(area.measure(rows).value!);
  expect(laborMetricContext(rows, units, "opening").measure(rows).value).toBe(20);
  expect(laborMetricContext(rows, units, "hours").measure(rows).value).toBe(3000 / 3600);
});

it("keeps dimensionless openings in per-opening rates but never turns unknown area into zero", () => {
  const rows = [row("a", "u", 600), row("b", "v", 300), row("c", "unmapped", 60)];
  const units = [unit("u", "o", 12), unit("v", "o2")];
  const area = laborMetricContext(rows, units, "area");
  expect(area.measure(rows).value).toBe(10);
  expect(area.missingDimensions).toBe(1); expect(area.unlinkedRecords).toBe(1);
  expect(area.measure([rows[1]]).value).toBeNull();
  expect(laborMetricContext(rows, units, "opening").measure(rows).value).toBe(7.5);
  expect(laborMetricContext([], units, "area").measure([]).value).toBeNull();
});

it("does not count duplicate opening links twice or normalize conflicting areas", () => {
  const rows = [row("a", "u", 600), row("b", "v", 600)];
  const units = [unit("u", "o", 12), unit("v", "o", 24)];
  expect(laborMetricContext(rows, units, "opening").measure(rows).value).toBe(20);
  const context = laborMetricContext(rows, units, "area");
  expect(context.dimensionConflicts).toBe(1); expect(context.measure(rows).value).toBeNull();
});


it("counts historical physical openings without inventing dimensions", () => {
  const rows = [{ id: "historic", scope: "Specific", unitId: "opening:o", openingId: "o", seconds: 120, jobId: "job" }] as ActivityRow[];
  expect(laborMetricContext(rows, [], "opening").measure(rows).value).toBe(2);
  expect(laborMetricContext(rows, [], "area").measure(rows).value).toBeNull();
});
