import { expect, it } from "vitest";
import { workAttribution } from "./workAttribution";
import { groupActivities, type ActivityRow } from "./activityRows";
import { dimensionValue, matchesFacets, emptyFacets } from "./dataDimensions";

const row = { id: "r", jobId: "j", scope: "Specific", unitId: "u", openingId: "o", seconds: 600, activity: "Install" } as ActivityRow;
it("requires an opening link, not just unit intent, and preserves source records", () => {
  expect(workAttribution(row)).toBe("Unit-linked work");
  expect(workAttribution({ ...row, openingId: undefined })).toBe("Missing attribution");
  expect(workAttribution({ ...row, jobId: undefined })).toBe("Missing attribution");
  expect(workAttribution({ ...row, unitFacts: { linkConflict: true } as ActivityRow["unitFacts"] })).toBe("Missing attribution");
  expect(row.scope).toBe("Specific");
});
it("keeps explicit job-level timers separate from missing or contradictory attribution", () => {
  const general = { ...row, scope: "General", unitId: null, openingId: undefined };
  expect(workAttribution(general)).toBe("Job-level work");
  expect(workAttribution({ ...general, unitId: "unexpected" })).toBe("Missing attribution");
  expect(workAttribution({ ...general, jobId: undefined })).toBe("Missing attribution");
  expect(workAttribution({ ...general, scope: "unexpected" })).toBe("Missing attribution");
});
it("groups and filters missing attribution without dropping its hours or assigning units", () => {
  const rows = [row, { ...row, id: "missing", openingId: undefined }, { ...row, id: "job", scope: "General", unitId: null, openingId: undefined }];
  const groups = groupActivities(rows, "scope");
  expect(groups.map(group => group.label).sort()).toEqual(["Job-level work", "Missing attribution", "Unit-linked work"]);
  expect(groups.reduce((sum, group) => sum + group.seconds, 0)).toBe(1800);
  const filters = emptyFacets(); filters.scope.include = ["Missing attribution"];
  expect(rows.filter(record => matchesFacets(record, filters)).map(record => record.id)).toEqual(["missing"]);
  expect(dimensionValue(rows[1], "scope").label).toBe("Missing attribution");
});
