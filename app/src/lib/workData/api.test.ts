// Shape validation and the auth-binding contract of fetchWorkDataSnapshot,
// mirroring work/startShift.replay.test.ts's mock style: a stubbed
// supabase/signedIn pair, never the real network or the real session module.
import { describe, expect, it, vi } from "vitest";

const JOB = "3cc5b810-45e0-4445-a115-efa98f8efad3";
const OTHER_JOB = "00000000-0000-4000-8000-00000000f0f0";
const ME = "00000000-0000-4000-8000-0000000000e2";

let sessionUserId: string | null = ME;
let markUserId: string | null = ME;
let generation = 0;
const rpcCalls: { token: string; args: unknown[] }[] = [];

function baseSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    asOf: "2026-11-07T12:00:00Z",
    project: { id: JOB, jobCode: "PECAN14", name: "Pecan" },
    shifts: [],
    claims: [],
    units: [],
    untimed: [],
    ...overrides,
  };
}

function rpcBuilder(result: { data: unknown; error: unknown }, token: string) {
  const builder = {
    abortSignal: (_signal: AbortSignal) => builder,
    then: (resolve: (v: typeof result) => void) => {
      rpcCalls.push({ token, args: [] });
      if (changeAfterRpc) generation++;
      resolve(result);
    },
  };
  return builder as unknown as Promise<typeof result> & { abortSignal: (s: AbortSignal) => unknown };
}

let nextResult: { data: unknown; error: unknown } = { data: baseSnapshot(), error: null };
let changeAfterRpc = false;

vi.mock("../supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: {
          session: sessionUserId
            ? { access_token: `token-${sessionUserId}`, user: { id: sessionUserId } }
            : null,
        },
        error: null,
      }),
    },
  },
  clientWithToken: (token: string) => ({
    rpc: () => rpcBuilder(nextResult, token),
  }),
}));

vi.mock("../signedIn", () => ({
  signInMark: () => ({ userId: markUserId, generation }),
  stillSignedInAs: (mark: { userId: string | null; generation: number }, who: string) =>
    mark.generation === generation && mark.userId === who && sessionUserId === who,
}));

const { fetchWorkDataSnapshot, validateWorkDataSnapshot, WorkDataUnavailableError } = await import("./api");

function reset() {
  sessionUserId = ME;
  markUserId = ME;
  generation = 0;
  changeAfterRpc = false;
  rpcCalls.length = 0;
  nextResult = { data: baseSnapshot(), error: null };
}

describe("fetchWorkDataSnapshot", () => {
  it("returns a valid empty snapshot for the requested job", async () => {
    reset();
    const snap = await fetchWorkDataSnapshot({ projectId: JOB, from: "2026-11-01T00:00:00Z", until: "2026-11-08T00:00:00Z" });
    expect(snap.project.id).toBe(JOB);
    expect(snap.shifts).toEqual([]);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].token).toBe(`token-${ME}`);
  });

  it("accepts a unit with every dimension null — honest, not a failure", async () => {
    reset();
    nextResult = {
      data: baseSnapshot({
        units: [
          {
            id: "custom:1111", label: "West wall", category: null, subtype: null,
            material: null, floor: null, widthIn: null, heightIn: null,
            dimensionSource: null, dimensionsVerified: false, complete: false,
            qcAccepted: false, hasUntimedEvidence: false,
          },
        ],
      }),
      error: null,
    };
    const snap = await fetchWorkDataSnapshot({ projectId: JOB, from: "2026-11-01T00:00:00Z", until: "2026-11-08T00:00:00Z" });
    expect(snap.units[0].widthIn).toBeNull();
    expect(snap.units[0].dimensionsVerified).toBe(false);
  });

  it("rejects a snapshot naming a different job than was requested", async () => {
    reset();
    nextResult = { data: baseSnapshot({ project: { id: OTHER_JOB, jobCode: "OTHER", name: "Other" } }), error: null };
    await expect(
      fetchWorkDataSnapshot({ projectId: JOB, from: "2026-11-01T00:00:00Z", until: "2026-11-08T00:00:00Z" }),
    ).rejects.toThrow(/different job/);
  });

  it("rejects duplicate shift ids", async () => {
    reset();
    const shift = {
      id: "s1", profileId: ME, profileName: "Ana", projectId: JOB,
      startedAt: "2026-11-01T13:00:00Z", endedAt: "2026-11-01T21:00:00Z",
      breakSeconds: 0, breakStartedAt: null, status: "approved", reviewReason: null,
    };
    nextResult = { data: baseSnapshot({ shifts: [shift, shift] }), error: null };
    await expect(
      fetchWorkDataSnapshot({ projectId: JOB, from: "2026-11-01T00:00:00Z", until: "2026-11-08T00:00:00Z" }),
    ).rejects.toThrow(/duplicate shift id/);
  });

  it("rejects duplicate claim sourceIds", async () => {
    reset();
    const claim = {
      sourceId: "custom_work_sessions:1", sourceTable: "custom_work_sessions", revision: 1,
      profileId: ME, projectId: JOB, shiftId: "s1", unitId: "custom:1",
      activityId: "unit:Installing", label: "Installing", scope: "specific",
      startedAt: "2026-11-01T13:00:00Z", endedAt: "2026-11-01T14:00:00Z",
    };
    nextResult = { data: baseSnapshot({ claims: [claim, claim] }), error: null };
    await expect(
      fetchWorkDataSnapshot({ projectId: JOB, from: "2026-11-01T00:00:00Z", until: "2026-11-08T00:00:00Z" }),
    ).rejects.toThrow(/duplicate claim sourceId/);
  });

  it("rejects a claim with an unknown scope", async () => {
    reset();
    nextResult = {
      data: baseSnapshot({
        claims: [{
          sourceId: "x:1", sourceTable: "x", revision: null, profileId: ME, projectId: JOB,
          shiftId: null, unitId: null, activityId: "a", label: "A", scope: "payroll",
          startedAt: "2026-11-01T13:00:00Z", endedAt: null,
        }],
      }),
      error: null,
    };
    await expect(
      fetchWorkDataSnapshot({ projectId: JOB, from: "2026-11-01T00:00:00Z", until: "2026-11-08T00:00:00Z" }),
    ).rejects.toThrow(/invalid scope/);
  });

  it("throws WorkDataUnavailableError, never a successful empty snapshot, when the RPC is missing", async () => {
    reset();
    nextResult = { data: null, error: { code: "42883", message: "function public.work_data_snapshot does not exist" } };
    await expect(
      fetchWorkDataSnapshot({ projectId: JOB, from: "2026-11-01T00:00:00Z", until: "2026-11-08T00:00:00Z" }),
    ).rejects.toBeInstanceOf(WorkDataUnavailableError);
  });

  it("rejects a malformed date range before any network call", async () => {
    reset();
    await expect(
      fetchWorkDataSnapshot({ projectId: JOB, from: "not-a-date", until: "2026-11-08T00:00:00Z" }),
    ).rejects.toThrow(/valid date range/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses when the signed-in account has changed since the mark was taken (auth-switch mid-flight)", async () => {
    reset();
    markUserId = ME;
    sessionUserId = "00000000-0000-4000-8000-0000000000aa"; // somebody else is now signed in
    await expect(
      fetchWorkDataSnapshot({ projectId: JOB, from: "2026-11-01T00:00:00Z", until: "2026-11-08T00:00:00Z" }),
    ).rejects.toThrow(/Sign in again/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses a late response after sign-out and back to the same user", async () => {
    reset(); changeAfterRpc = true;
    await expect(fetchWorkDataSnapshot({ projectId: JOB, from: "2026-11-01T00:00:00Z", until: "2026-11-08T00:00:00Z" })).rejects.toThrow(/changed while loading/);
    expect(rpcCalls).toHaveLength(1);
  });

  it("rejects reversed and oversized windows before sending", async () => {
    reset();
    for (const [from, until] of [["2026-11-08", "2026-11-01"], ["2026-01-01", "2026-11-08"]])
      await expect(fetchWorkDataSnapshot({ projectId: JOB, from, until })).rejects.toThrow(/positive and at most/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("sends the RPC on a client bound to the current session's own access token", async () => {
    reset();
    await fetchWorkDataSnapshot({ projectId: JOB, from: "2026-11-01T00:00:00Z", until: "2026-11-08T00:00:00Z" });
    expect(rpcCalls[0].token).toBe(`token-${ME}`);
  });
});

describe("validateWorkDataSnapshot", () => {
  it("rejects a non-object response rather than treating it as empty", () => {
    expect(() => validateWorkDataSnapshot(null, JOB)).toThrow(/not an object/);
    expect(() => validateWorkDataSnapshot(undefined, JOB)).toThrow(/not an object/);
  });

  it("rejects an unknown schemaVersion", () => {
    expect(() => validateWorkDataSnapshot(baseSnapshot({ schemaVersion: 2 }), JOB)).toThrow(/schemaVersion/);
  });

  it("refuses nonfinite revisions and truthy text flags", () => {
    const c = { sourceId: "x:1", sourceTable: "x", revision: 1, profileId: ME, projectId: JOB,
      shiftId: null, unitId: null, activityId: "a", label: "A", scope: "general",
      startedAt: "2026-11-01T13:00:00Z", endedAt: null };
    expect(() => validateWorkDataSnapshot(baseSnapshot({ claims: [{ ...c, revision: NaN }] }), JOB)).toThrow(/revision/);
    expect(() => validateWorkDataSnapshot(baseSnapshot({ claims: [{ ...c, unresolved: "false" }] }), JOB)).toThrow(/unresolved/);
  });

  it("refuses duplicate untimed evidence", () => {
    const row = { sourceId: "crew:1", sourceTable: "crew_work_records", profileId: ME, projectId: JOB,
      unitId: null, activityId: "frame", label: "Frame", workDate: "2026-11-01", reportedSeconds: null };
    expect(() => validateWorkDataSnapshot(baseSnapshot({ untimed: [row, row] }), JOB)).toThrow(/duplicate untimed/);
  });

  it("accepts the base empty snapshot for the matching job", () => {
    expect(validateWorkDataSnapshot(baseSnapshot(), JOB).project.id).toBe(JOB);
  });
});
