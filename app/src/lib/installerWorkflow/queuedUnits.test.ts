import { describe, expect, it } from "vitest";
import type { WorkCommand } from "../customWork/model";
import type { ProjectOpening } from "../install/types";
import { queuedUnitWrites, unitNumberTaken, withQueuedUnits } from "./queuedUnits";

const write = { editId: "e1", projectId: "job-1", id: "new-unit", create: true, code: "9-9",
  details: { placeholder: true, floor: "2" }, previousCode: null, previousDetails: {} };
const create: WorkCommand = { id: "c1", userId: "me", action: "unit_create", data: write };
const saved = [{ id: "u1", project_id: "job-1", opening_code: "1-12" }] as unknown as ProjectOpening[];

describe("units created on the phone and not saved yet", () => {
  it("are shown with the job's saved units, once", () => {
    const rows = withQueuedUnits(saved, [create], "job-1");
    expect(rows.map(row => row.opening_code)).toEqual(["1-12", "9-9"]);
    expect(rows[1]).toMatchObject({ id: "new-unit", project_id: "job-1", unit_details: { placeholder: true } });
    // After Forge saves it, the list already holds it and it is not added twice.
    expect(withQueuedUnits(rows, [create], "job-1")).toHaveLength(2);
  });

  it("belong to their own job, and a refused one is not shown", () => {
    expect(queuedUnitWrites([create], "job-2")).toEqual([]);
    expect(withQueuedUnits(saved, [{ ...create, error: "refused" }], "job-1")).toBe(saved);
  });

  it("a number already on the job is caught on the phone", () => {
    const rows = withQueuedUnits(saved, [create], "job-1");
    expect(unitNumberTaken(rows, " 1-12 ")).toBe(true);
    expect(unitNumberTaken(rows, "9-9")).toBe(true);
    expect(unitNumberTaken(rows, "2-1")).toBe(false);
  });
});
