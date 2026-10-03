import { beforeEach, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../supabase", () => ({ supabase: { rpc } }));
const {
  fetchMyValuesTasks, fetchMyValuesOwedCount, fetchMyValuesSummary,
  fetchValuesOwnerReport, ValuesReadMalformedError,
} = await import("./api");

const reply = (data: unknown) => rpc.mockResolvedValue({ data, error: null });
beforeEach(() => rpc.mockReset());

const task = () => ({
  assignment_id: "assignment", period_start: "2026-10-01", subject_id: "subject",
  subject_name: "Ana", reason: "crew", solo: false, status: "pending",
  submitted_at: null, rubric_version: 1,
});

it("keeps a real empty task list and rejects a null or non-array list", async () => {
  reply([]);
  await expect(fetchMyValuesTasks()).resolves.toEqual([]);
  for (const value of [null, {}, 0]) {
    reply(value);
    await expect(fetchMyValuesTasks()).rejects.toBeInstanceOf(ValuesReadMalformedError);
  }
});

it("accepts a complete task but rejects missing identity and invalid status, flag, or rubric", async () => {
  reply([task()]);
  await expect(fetchMyValuesTasks()).resolves.toMatchObject([{ assignmentId: "assignment", status: "pending", solo: false }]);
  for (const patch of [
    { assignment_id: null }, { period_start: "" }, { status: "canceled" },
    { solo: 0 }, { rubric_version: "1" }, { submitted_at: undefined },
  ]) {
    reply([{ ...task(), ...patch }]);
    await expect(fetchMyValuesTasks()).rejects.toBeInstanceOf(ValuesReadMalformedError);
  }
});

it("preserves real zero owed and rejects missing, fractional, negative, or coerced counts", async () => {
  reply(0);
  await expect(fetchMyValuesOwedCount()).resolves.toBe(0);
  for (const value of [null, undefined, -1, 0.5, NaN, "0"]) {
    reply(value);
    await expect(fetchMyValuesOwedCount()).rejects.toBeInstanceOf(ValuesReadMalformedError);
  }
});

it("preserves a null summary and a real empty summary but rejects incomplete roots", async () => {
  reply(null);
  await expect(fetchMyValuesSummary()).resolves.toBeNull();
  const summary = { subjectId: "subject", windowStart: "2026-07-01", windowEnd: "2026-10-03", mirror: {}, allTime: {}, quarters: [] };
  reply(summary);
  await expect(fetchMyValuesSummary()).resolves.toMatchObject({ mirror: { byValue: {} }, quarters: [] });
  for (const value of [undefined, {}, { ...summary, mirror: null }, { ...summary, quarters: undefined }]) {
    reply(value);
    await expect(fetchMyValuesSummary()).rejects.toBeInstanceOf(ValuesReadMalformedError);
  }
});

it("preserves owner false/empty and rejects missing owner root fields", async () => {
  const owner = { periodStart: "2026-10-01", schedulerEnabled: false, people: [] };
  reply(owner);
  await expect(fetchValuesOwnerReport()).resolves.toEqual(owner);
  for (const value of [null, {}, { ...owner, schedulerEnabled: undefined }, { ...owner, people: undefined }]) {
    reply(value);
    await expect(fetchValuesOwnerReport()).rejects.toBeInstanceOf(ValuesReadMalformedError);
  }
});

it("validates owner identities and received-review details without placeholder fallbacks", async () => {
  const person = () => ({
    userId: "person", name: "Ana", mirror: {}, owedCount: 0,
    suspended: false, retired: false,
    asRater: { assigned: 0, accepted: 0, late: 0, pending: 0, canceled: 0, suspended: 0 },
    coverage: { expectedReceived: 2, actualReceived: 0, missingCoverage: true },
    received: [{ raterName: "Rosa", raterClass: "worker", solo: false,
      periodStart: "2026-10-01", comment: null, scores: { safety: 7 } }],
  });
  reply({ periodStart: "2026-10-01", schedulerEnabled: false, people: [person()] });
  await expect(fetchValuesOwnerReport()).resolves.toMatchObject({ people: [{
    userId: "person", received: [{ raterName: "Rosa", comment: null, scores: { safety: 7 } }],
  }] });
  const badRows = [
    { userId: null }, { name: "" }, { received: null },
    { received: [{}] },
    { received: [{ ...person().received[0], raterName: null }] },
    { received: [{ ...person().received[0], solo: 0 }] },
    { received: [{ ...person().received[0], comment: undefined }] },
    { received: [{ ...person().received[0], scores: null }] },
    { received: [{ ...person().received[0], scores: { safety: "7" } }] },
    { received: [{ ...person().received[0], scores: { unknown: 7 } }] },
  ];
  for (const patch of badRows) {
    reply({ periodStart: "2026-10-01", schedulerEnabled: false, people: [{ ...person(), ...patch }] });
    await expect(fetchValuesOwnerReport()).rejects.toBeInstanceOf(ValuesReadMalformedError);
  }
});
