// Job-level call for hands (job-level-summons slice 4): a summon can hang off
// the JOB with no opening. These tests pin the parts that would break quietly:
//
//   * the pure strip/visibility functions must render a null-opening summon,
//     not crash on the missing window;
//   * the DEFAULT audience read must ASK the database to exclude people on
//     other jobs and off the clock — that exclusion is the whole point, and it
//     lives in the query, so the query is what gets asserted;
//   * reach-further adds names to the target set, deduped, minus the caller;
//   * where_note reaches the server;
//   * the push goes to exactly the computed list.

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  ops: [] as string[],
  rows: [] as unknown[],
  rpc: [] as { fn: string; args: Record<string, unknown> }[],
}));

vi.mock("../supabase", () => {
  const builder: Record<string, unknown> = {};
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      // Column AND value, so a test can assert WHICH job / status the read
      // pins, not merely that it filtered on some column.
      db.ops.push([method, ...args.map(String)].join(":"));
      return builder;
    };
  for (const m of ["select", "eq", "in", "is", "gte", "lte", "gt", "lt", "order", "limit"]) {
    builder[m] = record(m);
  }
  builder.then = (resolve: (value: unknown) => void) => {
    resolve({ data: db.rows, error: null });
  };
  return {
    supabase: {
      from: record("from"),
      rpc: (fn: string, args: Record<string, unknown>) => {
        db.rpc.push({ fn, args });
        db.ops.push(`rpc:${fn}`);
        // create_job_summon returns the row it wrote — echo the args so a test
        // can prove what was persisted.
        return Promise.resolve({ data: { id: "new-summon", ...(args ?? {}) }, error: null });
      },
    },
    supabaseConfigured: true,
  };
});

// notifyCallForHands rings through sendPush — mock it so the target list is
// captured instead of a network call.
const push = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock("../permissions/pushServer", () => ({
  sendPush: (input: Record<string, unknown>) => {
    push.calls.push(input);
    return Promise.resolve(true);
  },
}));

import {
  callForHandsTargets,
  createJobSummon,
  iAnswered,
  listClockedInOnJob,
  notifyCallForHands,
  summonHelperMinutes,
  summonStripLine,
  visibleSummons,
  type Summon,
} from "./summons";

const NOW = Date.parse("2026-09-03T13:00:00Z");

function jobSummon(over: Partial<Summon> = {}): Summon {
  return {
    id: "j1",
    project_id: "p1",
    opening_id: null, // the job-level shape
    requested_by: "marcus",
    needed: 2,
    status: "open",
    created_at: new Date(NOW - 30 * 60_000).toISOString(),
    closed_at: null,
    where_note: "north side, second floor",
    requester: { display_name: "Marcus" },
    project: { job_code: "BLACK22" },
    opening: null,
    ...over,
  };
}

describe("a null-opening summon renders, never crashes", () => {
  it("the strip line drops the window and reads the job alone", () => {
    expect(summonStripLine(jobSummon(), false, NOW)).toBe("Marcus needs 2 hands — BLACK22");
  });

  it("your own job-level call reads as confirmation", () => {
    expect(summonStripLine(jobSummon(), true, NOW)).toBe("You called for 2 hands — BLACK22");
  });

  it("covered and one-hand shapes still read right without a window", () => {
    expect(summonStripLine(jobSummon({ status: "covered" }), false, NOW)).toBe(
      "Marcus needs 2 hands — BLACK22 (covered)",
    );
    expect(summonStripLine(jobSummon({ needed: 1 }), false, NOW)).toBe(
      "Marcus needs 1 hand — BLACK22",
    );
  });

  it("visibleSummons and iAnswered handle the null opening", () => {
    const s = jobSummon({
      helpers: [{ profile_id: "dana", completed_at: null, canceled_at: null }],
    });
    expect(visibleSummons([s], "chris", NOW)).toHaveLength(1);
    expect(iAnswered(s, "dana")).toBe(true);
    expect(iAnswered(s, "chris")).toBe(false);
    // A job-level helper stint still counts toward man-minutes.
    expect(
      summonHelperMinutes(
        [{ joined_at: new Date(NOW - 15 * 60_000).toISOString(), completed_at: null, minutes: null, canceled_at: null }],
        NOW,
      ),
    ).toBe(15);
  });
});

describe("the same-job clocked-in audience read", () => {
  beforeEach(() => {
    db.ops = [];
    db.rows = [];
    db.rpc = [];
  });

  it("asks the database to exclude other jobs and off-clock people", async () => {
    db.rows = [{ profile_id: "a", worker: { display_name: "Ann" } }];
    await listClockedInOnJob("p1");
    // The exclusion lives in the query: this job only, status open only,
    // clock_out_at null only.
    expect(db.ops).toContain("eq:project_id:p1"); // this job, not another
    expect(db.ops).toContain("eq:status:open"); // on the clock, not submitted/voided
    expect(db.ops).toContain("is:clock_out_at:null"); // hasn't clocked out
  });

  it("returns one person per open shift, deduped, with names", async () => {
    db.rows = [
      { profile_id: "a", worker: { display_name: "Ann" } },
      { profile_id: "a", worker: { display_name: "Ann" } }, // a second row for the same person
      { profile_id: "b", worker: { display_name: "Bo" } },
    ];
    const people = await listClockedInOnJob("p1");
    expect(people.map((p) => p.profileId)).toEqual(["a", "b"]);
    expect(people.map((p) => p.displayName)).toEqual(["Ann", "Bo"]);
  });
});

describe("callForHandsTargets (reach-further math)", () => {
  it("adds reached names to the same-job crew, deduped, minus the caller", () => {
    expect(callForHandsTargets(["a", "b"], ["c", "b"], "me").sort()).toEqual(["a", "b", "c"]);
  });

  it("never rings the caller, even if they're on the clock on the job", () => {
    expect(callForHandsTargets(["a", "me"], [], "me")).toEqual(["a"]);
  });

  it("reach-further alone (no same-job crew) still targets the chosen", () => {
    expect(callForHandsTargets([], ["x", "y"], null).sort()).toEqual(["x", "y"]);
  });
});

describe("createJobSummon persists the where-I-am note", () => {
  beforeEach(() => {
    db.rpc = [];
  });

  it("passes the project, note and where_note to the server", async () => {
    await createJobSummon("p1", 3, "carry the storefront", "back of the lot");
    expect(db.rpc).toHaveLength(1);
    expect(db.rpc[0].fn).toBe("create_job_summon");
    expect(db.rpc[0].args).toMatchObject({
      p_project_id: "p1",
      p_needed: 3,
      p_note: "carry the storefront",
      p_where_note: "back of the lot",
      p_lead_minutes: null,
    });
  });

  it("trims and nulls an empty where_note rather than sending blanks", async () => {
    db.rpc = [];
    await createJobSummon("p1", 2, "  ", "   ");
    expect(db.rpc[0].args.p_note).toBeNull();
    expect(db.rpc[0].args.p_where_note).toBeNull();
  });
});

describe("notifyCallForHands targets exactly the computed list", () => {
  beforeEach(() => {
    push.calls = [];
  });

  it("rings the same-job crew plus reach-further, minus the caller", async () => {
    const ok = await notifyCallForHands({
      summonId: "j1",
      projectId: "p1",
      jobLabel: "BLACK22",
      callerId: "marcus",
      callerName: "Marcus",
      needed: 2,
      note: "carry it",
      whereNote: "north side",
      sameJobIds: ["marcus", "dana", "bo"], // marcus is the caller
      extraIds: ["chris"],
    });
    expect(ok).toBe(true);
    expect(push.calls).toHaveLength(1);
    expect((push.calls[0].profileIds as string[]).sort()).toEqual(["bo", "chris", "dana"]);
    // The deep link lands on the job, not a window — there isn't one.
    expect(push.calls[0].url).toBe("/projects/p1");
  });

  it("sends nothing, and says so, when the computed list is empty", async () => {
    const ok = await notifyCallForHands({
      summonId: "j1",
      projectId: "p1",
      jobLabel: "BLACK22",
      callerId: "marcus",
      callerName: "Marcus",
      needed: 2,
      sameJobIds: ["marcus"], // only the caller is on the clock
      extraIds: [],
    });
    expect(ok).toBe(false);
    expect(push.calls).toHaveLength(0);
  });
});
