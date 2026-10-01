import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ responses: [] as unknown[], select: vi.fn(), eq: vi.fn() }));
vi.mock("../supabase", () => ({ supabase: { from: () => {
  const query = {
    select: (...args: unknown[]) => { mock.select(...args); return query; },
    eq: (...args: unknown[]) => { mock.eq(...args); return query; },
    is: () => query, order: () => query, range: () => query,
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(mock.responses.shift()).then(resolve),
  };
  return query;
} } }));
import { listCrewWorkRecords, listUnitCrewWorkRecords } from "./api";
beforeEach(() => { mock.responses = []; vi.clearAllMocks(); });
it("the original crew ledger remains readable before correction columns are deployed", async () => {
  mock.responses.push(
    { data: null, count: null, error: { code: "42703", message: "column voided_at does not exist" } },
    { data: [{ id: "record", people: [{ profile_id: "worker" }] }], count: 1, error: null },
  );
  expect(await listCrewWorkRecords("job")).toEqual([{ id: "record", people: [{ profile_id: "worker" }] }]);
  expect(mock.select.mock.calls[1][0]).toContain("people:crew_work_record_people(profile_id)");
});
it("unit history reads the original reports for that unit rather than assuming it never moved jobs", async () => {
  mock.responses.push({ data: [], count: 0, error: null });
  expect(await listUnitCrewWorkRecords("unit")).toEqual([]);
  expect(mock.eq).toHaveBeenCalledExactlyOnceWith("unit_id", "unit");
});
it("unrelated missing columns remain errors", async () => {
  const error = { code: "42703", message: "column project_id does not exist" };
  mock.responses.push({ data: null, count: null, error });
  await expect(listCrewWorkRecords("job")).rejects.toBe(error);
  expect(mock.select).toHaveBeenCalledTimes(1);
});
