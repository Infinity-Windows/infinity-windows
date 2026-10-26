import { expect, it } from "vitest";
import type { ActivityRow } from "./activityRows";
import { emptyFacets, matchesFacets, groupPaths } from "./dataDimensions";
import { laborMetricContext } from "./laborMetrics";
import type { WorkUnit } from "../../lib/customWork/model";

const rows: ActivityRow[] = [
  { id: "a", jobId: "j1", job: "Job", unitId: "u1", unit: "1", floor: "1", personId: "p1", person: "Sam", scope: "Specific", activity: "Installing", seconds: 600 },
  { id: "b", jobId: "j2", job: "Job", unitId: "u2", unit: "1", floor: "Unknown", personId: "p2", person: "Sam", scope: "Specific", activity: "Flashing", seconds: 1200 },
  { id: "c", jobId: "j1", job: "Job", unitId: null, unit: "No unit", floor: "Not allocated", personId: "p1", person: "Sam", scope: "General", activity: "Hauling", seconds: 300 },
] as ActivityRow[];

it("uses OR inside a dimension, AND across dimensions, and exclusion precedence", () => {
  const facets = emptyFacets();
  facets.job.include = ["j1", "j2"];
  facets.activity.include = ["Installing", "Flashing"];
  facets.person.exclude = ["p2"];
  expect(rows.filter(row => matchesFacets(row, facets)).map(row => row.id)).toEqual(["a"]);
  facets.job.exclude = ["j1"];
  expect(rows.filter(row => matchesFacets(row, facets))).toEqual([]);
  expect(rows.filter(row => matchesFacets(row, emptyFacets()))).toHaveLength(3);
  expect(matchesFacets(rows[1], facets, "person")).toBe(true);
});

it("uses IDs for equal-name jobs, units and people, and preserves unknown values", () => {
  expect(groupPaths(rows, ["job"])).toHaveLength(2);
  expect(groupPaths(rows, ["person"])).toHaveLength(2);
  expect(groupPaths(rows, ["unit"])).toHaveLength(3);
  const facets = emptyFacets(); facets.floor.include = ["Unknown"];
  expect(rows.filter(row => matchesFacets(row, facets)).map(row => row.id)).toEqual(["b"]);
});

it("reordering changes hierarchy but neither row membership nor normalized denominators", () => {
  const units = [{ id: "u1", project_id: "j1", opening_id: "o1", facts: { width_in: 12, height_in: 12 } }, { id: "u2", project_id: "j2", opening_id: "o2", facts: { width_in: 24, height_in: 12 } }] as WorkUnit[];
  const context = laborMetricContext(rows, units, "area");
  for (const order of [["job", "floor"], ["floor", "job"]] as const) {
    const groups = groupPaths(rows, [...order]);
    expect(groups.flatMap(group => group.rows).map(row => row.id).sort()).toEqual(["a", "b", "c"]);
    expect(context.measure(rows)).toMatchObject({ value: 10, area: 3, openings: 2 });
    expect(groups[0].path).toHaveLength(2);
  }
  expect(groupPaths(rows, ["job", "floor"])[0].path).not.toEqual(groupPaths(rows, ["floor", "job"])[0].path);
  expect(groupPaths(rows, [])[0].records).toBe(3);
});

it("groups job-specific unit classification facts without inventing unknown or general allocations", () => {
  const records = [
    { id:"a", jobId:"j1", job:"One", scope:"Specific", category:"Window", subtype:"Casement", material:"Aluminum" },
    { id:"b", jobId:"j2", job:"Two", scope:"Specific", category:"Window", subtype:null, material:null },
    { id:"c", jobId:"j1", job:"One", scope:"General", category:null, subtype:null, material:null },
  ] as ActivityRow[];
  expect(groupPaths(records, ["material"]).map(group => group.label)).toEqual(["Aluminum", "Not allocated", "Unknown"]);
  expect(groupPaths(records, ["job", "category"]).map(group => group.label)).toEqual(["One › Not allocated", "One › Window", "Two › Window"]);
  expect(groupPaths(records, ["subtype"]).find(group => group.label === "Unknown")?.rows.map(row => row.id)).toEqual(["b"]);
});
