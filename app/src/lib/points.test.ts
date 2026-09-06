import { beforeEach, describe, expect, it, vi } from "vitest";

// Every RPC this module fires, and with what. The point of the 2026-09-05 tests
// at the bottom: the ledger takes no writes from a phone any more, so what
// leaves the browser is an RPC CALL with a payload, and the payload is the
// thing worth pinning.
const rpcCalls: { fn: string; args: unknown }[] = [];
let rpcError: unknown = null;

vi.mock("./supabase", () => ({
  supabase: {
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: null, error: rpcError });
    },
    from: () => {
      throw new Error("points.ts must not write points_ledger directly");
    },
  },
}));

import {
  awardPoints,
  computeInstallPoints,
  POINT_KINDS,
  pointsByCategory,
  POINT_RULES,
  rankLeaderboard,
  resolvePendingPoints,
  sumPoints,
} from "./points";

describe("computeInstallPoints", () => {
  it("awards base + par + photos + teach + quality when all conditions met", () => {
    const entries = computeInstallPoints({
      minutes: 40,
      parMinutes: 45,
      grade: 5,
      hasPhotos: true,
      hasMemo: true,
    });
    expect(sumPoints(entries)).toBe(
      POINT_RULES.installBase +
        POINT_RULES.parBeat +
        POINT_RULES.photos +
        POINT_RULES.teach +
        POINT_RULES.quality,
    );
  });

  it("no par bonus when over par, no quality bonus under grade 4", () => {
    const entries = computeInstallPoints({
      minutes: 60,
      parMinutes: 45,
      grade: 3,
      hasPhotos: false,
      hasMemo: false,
    });
    expect(entries.map((e) => e.kind)).toEqual(["install"]);
    expect(sumPoints(entries)).toBe(POINT_RULES.installBase);
  });

  it("par bonus is exactly at par (<=), missing data skips par", () => {
    expect(
      computeInstallPoints({ minutes: 45, parMinutes: 45, grade: null, hasPhotos: false, hasMemo: false })
        .some((e) => e.kind === "par"),
    ).toBe(true);
    expect(
      computeInstallPoints({ minutes: null, parMinutes: 45, grade: null, hasPhotos: false, hasMemo: false })
        .some((e) => e.kind === "par"),
    ).toBe(false);
  });
});

describe("pointsByCategory", () => {
  it("returns all six categories in canonical order with zeros for missing kinds", () => {
    const result = pointsByCategory([]);
    expect(result.map((r) => r.kind)).toEqual([
      "install",
      "par",
      "photos",
      "teach",
      "quality",
      "quiz",
    ]);
    expect(result.map((r) => r.kind)).toEqual(POINT_KINDS);
    expect(result.every((r) => r.points === 0)).toBe(true);
  });

  it("sums only confirmed rows, ignoring pending and void", () => {
    const result = pointsByCategory([
      { kind: "install", points: 20, status: "confirmed" },
      { kind: "install", points: 20, status: "pending" },
      { kind: "install", points: 20, status: "void" },
      { kind: "quality", points: 5, status: "confirmed" },
    ]);
    const byKind = Object.fromEntries(result.map((r) => [r.kind, r.points]));
    expect(byKind.install).toBe(20);
    expect(byKind.quality).toBe(5);
    expect(byKind.par).toBe(0);
  });

  it("accumulates correct subtotals per category and keeps categories separate", () => {
    const result = pointsByCategory([
      { kind: "install", points: 20, status: "confirmed" },
      { kind: "install", points: 20, status: "confirmed" },
      { kind: "par", points: 15, status: "confirmed" },
      { kind: "teach", points: 15, status: "confirmed" },
      { kind: "quality", points: 5, status: "confirmed" },
      { kind: "quiz", points: 10, status: "confirmed" },
      { kind: "photos", points: 10, status: "confirmed" },
    ]);
    expect(result).toEqual([
      { kind: "install", points: 40 },
      { kind: "par", points: 15 },
      { kind: "photos", points: 10 },
      { kind: "teach", points: 15 },
      { kind: "quality", points: 5 },
      { kind: "quiz", points: 10 },
    ]);
  });

  it("ignores unknown kinds without throwing", () => {
    const result = pointsByCategory([
      { kind: "mystery", points: 99, status: "confirmed" },
      { kind: "install", points: 20, status: "confirmed" },
    ]);
    expect(result).toHaveLength(POINT_KINDS.length);
    expect(result.find((r) => r.kind === "install")?.points).toBe(20);
  });
});

describe("rankLeaderboard", () => {
  const crew = [
    { id: "mike", display_name: "Mike Alvarez" },
    { id: "sam", display_name: "Sam Reed" },
  ];

  it("totals points per person, highest first", () => {
    const rows = rankLeaderboard(
      [
        { profile_id: "mike", points: 20 },
        { profile_id: "sam", points: 15 },
        { profile_id: "mike", points: 20 },
      ],
      crew,
    );
    expect(rows).toEqual([
      { profile_id: "mike", display_name: "Mike Alvarez", points: 40 },
      { profile_id: "sam", display_name: "Sam Reed", points: 15 },
    ]);
  });

  it("leaves a test account out of the ranking entirely", () => {
    const rows = rankLeaderboard(
      [
        { profile_id: "mike", points: 20 },
        { profile_id: "bot", points: 9999 },
      ],
      [...crew, { id: "bot", display_name: "TEST — automation", is_test: true }],
    );
    expect(rows.map((r) => r.profile_id)).toEqual(["mike"]);
  });

  it("counts everyone when the test flag is absent, so an old database still ranks", () => {
    const rows = rankLeaderboard(
      [{ profile_id: "mike", points: 20 }, { profile_id: "sam", points: 5 }],
      crew,
    );
    expect(rows.map((r) => r.profile_id)).toEqual(["mike", "sam"]);
  });

  it("names someone it has no profile for rather than dropping their points", () => {
    const rows = rankLeaderboard([{ profile_id: "ghost", points: 7 }], crew);
    expect(rows).toEqual([{ profile_id: "ghost", display_name: "crew", points: 7 }]);
  });
});

// ---------------------------------------------------------------------------
// Server-only writes (2026-09-05)
// ---------------------------------------------------------------------------
// points_ledger used to carry one policy — FOR ALL to authenticated — so every
// signed-in phone could insert any row it liked, and the Education quiz tab did
// exactly that after every round. These pin the two wrappers that replaced the
// direct writes: what they send, and that they still send nothing else.
describe("awardPoints", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    rpcError = null;
  });

  it("sends the ref, the entries and the status to award_install_points", async () => {
    await awardPoints(
      "profile-1",
      [
        { kind: "install", points: POINT_RULES.installBase },
        { kind: "photos", points: POINT_RULES.photos },
      ],
      "opening-1",
      "pending",
    );
    expect(rpcCalls).toEqual([
      {
        fn: "award_install_points",
        args: {
          p_ref: "opening-1",
          p_entries: [
            { kind: "install", points: POINT_RULES.installBase },
            { kind: "photos", points: POINT_RULES.photos },
          ],
          p_status: "pending",
        },
      },
    ]);
  });

  it("does not send the profile id — the server pays whoever installed it", async () => {
    await awardPoints("profile-1", [{ kind: "install", points: 20 }], "opening-1");
    const args = rpcCalls[0].args as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(["p_entries", "p_ref", "p_status"]);
    expect(JSON.stringify(args)).not.toContain("profile-1");
  });

  // The server ignores this argument and files every install row pending, so a
  // "confirmed" default here would be a caller saying something that does not
  // happen — and on the build before this one it was a caller asking to skip
  // QC entirely.
  it("asks for pending when the caller does not say, because only QC confirms", async () => {
    await awardPoints("profile-1", [{ kind: "install", points: 20 }], "opening-1");
    const args = rpcCalls[0].args as Record<string, unknown>;
    expect(args.p_status).toBe("pending");
  });

  it("says nothing at all when there is nothing to award", async () => {
    await awardPoints("profile-1", [], "opening-1");
    expect(rpcCalls).toEqual([]);
  });

  it("refuses to award points with no window to hang them on", async () => {
    await expect(
      awardPoints("profile-1", [{ kind: "install", points: 20 }]),
    ).rejects.toThrow(/window/);
    expect(rpcCalls).toEqual([]);
  });

  it("passes a server refusal on rather than swallowing it", async () => {
    rpcError = { message: "Points go to whoever installed the window." };
    await expect(
      awardPoints("profile-1", [{ kind: "install", points: 20 }], "opening-1"),
    ).rejects.toEqual(rpcError);
  });
});

describe("resolvePendingPoints", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    rpcError = null;
  });

  it("sends QC's decision as one call naming only that unit", async () => {
    await resolvePendingPoints("opening-9", "confirmed");
    expect(rpcCalls).toEqual([
      { fn: "resolve_install_points", args: { p_ref: "opening-9", p_status: "confirmed" } },
    ]);
  });

  it("voids the same way a callback does", async () => {
    await resolvePendingPoints("opening-9", "void");
    expect(rpcCalls[0].args).toEqual({ p_ref: "opening-9", p_status: "void" });
  });
});
