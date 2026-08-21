import { describe, expect, it } from "vitest";
import {
  autoDistribute,
  nextForInstaller,
  orderMyWork,
  type DispatchCrew,
  type DispatchOpening,
} from "./dispatch";

const crew: DispatchCrew[] = [
  { id: "foreman", skill_level: 5, role: "foreman", active: true },
  { id: "mid", skill_level: 3, role: "installer", active: true },
  { id: "app", skill_level: 1, role: "installer", active: true },
];

function opening(p: Partial<DispatchOpening> & { id: string; opening_code: string }): DispatchOpening {
  return {
    window_type_id: "type-x",
    difficulty: 2,
    area: "p1",
    ready: true,
    blocked: false,
    assigned_to: null,
    sequence: null,
    ...p,
  };
}

describe("autoDistribute", () => {
  it("routes hard windows to high skill, easy to low skill", () => {
    const openings = [
      opening({ id: "bay", opening_code: "BAY1", difficulty: 5, area: "p1" }),
      opening({ id: "sh", opening_code: "SH1", difficulty: 1, area: "p2" }),
    ];
    const s = autoDistribute(openings, crew);
    const byOpening = Object.fromEntries(s.map((x) => [x.openingId, x.profileId]));
    expect(byOpening["bay"]).toBe("foreman"); // only foreman qualifies for 5
    expect(byOpening["sh"]).toBe("app"); // easy -> lowest skill eligible
  });

  it("never assigns above an installer's skill (apprentice can't get a 4)", () => {
    const openings = [opening({ id: "hard", opening_code: "H1", difficulty: 4, area: "p1" })];
    const s = autoDistribute(openings, [
      { id: "app", skill_level: 1, role: "installer", active: true },
    ]);
    expect(s).toHaveLength(0); // nobody qualified -> left for the foreman
  });

  it("skips blocked and already-assigned openings", () => {
    const openings = [
      opening({ id: "blk", opening_code: "B1", blocked: true }),
      opening({ id: "asg", opening_code: "A1", assigned_to: "mid" }),
      opening({ id: "ok", opening_code: "OK1" }),
    ];
    const s = autoDistribute(openings, crew);
    expect(s.map((x) => x.openingId)).toEqual(["ok"]);
  });

  it("balances load across eligible crew", () => {
    const openings = Array.from({ length: 6 }, (_, i) =>
      opening({ id: `o${i}`, opening_code: `O${i}`, difficulty: 1, area: `p${i}` }),
    );
    const s = autoDistribute(openings, crew);
    const counts = new Map<string, number>();
    for (const x of s) counts.set(x.profileId, (counts.get(x.profileId) ?? 0) + 1);
    // 6 easy windows across 3 people -> nobody hoards them all
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
  });

  it("keeps same-area openings with one person", () => {
    const openings = [
      opening({ id: "a1", opening_code: "A1", difficulty: 2, area: "roomA" }),
      opening({ id: "a2", opening_code: "A2", difficulty: 2, area: "roomA" }),
    ];
    const s = autoDistribute(openings, [
      { id: "x", skill_level: 3, role: "installer", active: true },
      { id: "y", skill_level: 3, role: "installer", active: true },
    ]);
    expect(s[0].profileId).toBe(s[1].profileId);
  });

  it("ignores inactive crew", () => {
    const openings = [opening({ id: "o", opening_code: "O", difficulty: 1 })];
    const s = autoDistribute(openings, [
      { id: "off", skill_level: 5, role: "foreman", active: false },
    ]);
    expect(s).toHaveLength(0);
  });

  it("prefers the installer with proven faster time on the type", () => {
    const openings = [
      opening({ id: "o", opening_code: "O", difficulty: 2, window_type_id: "T" }),
    ];
    const two = [
      { id: "fast", skill_level: 3, role: "installer" as const, active: true },
      { id: "slow", skill_level: 3, role: "installer" as const, active: true },
    ];
    const ctx = {
      perf: {
        fast: { fast: undefined } as never, // placeholder, overwritten below
      },
    };
    // Build a real perf index.
    ctx.perf = {
      fast: {
        T: { installer_id: "fast", window_type_id: "T", n: 4, median_minutes: 30, avg_grade: 4, fail_rate: 0 },
      },
      slow: {
        T: { installer_id: "slow", window_type_id: "T", n: 4, median_minutes: 55, avg_grade: 4, fail_rate: 0 },
      },
    } as never;
    const s = autoDistribute(openings, two, ctx);
    expect(s[0].profileId).toBe("fast");
  });

  it("lets a cleared apprentice take a type above their raw skill", () => {
    const openings = [
      opening({ id: "hard", opening_code: "H", difficulty: 5, window_type_id: "BAY" }),
    ];
    const onlyApprentice = [
      { id: "app", skill_level: 1, role: "installer" as const, active: true },
    ];
    // Without clearance: nobody qualifies.
    expect(autoDistribute(openings, onlyApprentice)).toHaveLength(0);
    // With clearance: the apprentice is eligible.
    const s = autoDistribute(openings, onlyApprentice, {
      cleared: new Set(["app:BAY"]),
    });
    expect(s.map((x) => x.profileId)).toEqual(["app"]);
  });

  it("a required badge is a hard gate an installer's number cannot jump", () => {
    const openings = [
      opening({
        id: "cw",
        opening_code: "CW1",
        difficulty: 3,
        window_type_id: "CW",
        required_capability: "curtain_wall",
      }),
    ];
    const senior = [
      { id: "sr", skill_level: 5, role: "installer" as const, active: true },
    ];
    // Skill 5, no badge: never offered.
    expect(autoDistribute(openings, senior)).toHaveLength(0);
    // Even proven history and per-type clearance don't open the family.
    expect(
      autoDistribute(openings, senior, {
        cleared: new Set(["sr:CW"]),
        perf: {
          sr: {
            CW: { installer_id: "sr", window_type_id: "CW", n: 5, median_minutes: 40, avg_grade: 5, fail_rate: 0 },
          },
        },
      }),
    ).toHaveLength(0);
    // With the badge, the normal ladder applies again.
    const s = autoDistribute(openings, senior, {
      badges: new Set(["sr:curtain_wall"]),
    });
    expect(s.map((x) => x.profileId)).toEqual(["sr"]);
  });

  it("badges gate installers only — leads still take anything", () => {
    const openings = [
      opening({
        id: "cw",
        opening_code: "CW1",
        difficulty: 3,
        window_type_id: "CW",
        required_capability: "wet_glazing",
      }),
    ];
    const foreman = [
      { id: "f", skill_level: 3, role: "foreman" as const, active: true },
    ];
    const s = autoDistribute(openings, foreman);
    expect(s.map((x) => x.profileId)).toEqual(["f"]);
  });

  it("no required badge means nothing changes for anyone", () => {
    const openings = [
      opening({ id: "o", opening_code: "O", difficulty: 2, window_type_id: "T" }),
    ];
    const crew = [
      { id: "a", skill_level: 2, role: "installer" as const, active: true },
    ];
    expect(autoDistribute(openings, crew).length).toBe(1);
  });

  it("proven history on a type qualifies even below skill tier", () => {
    const openings = [
      opening({ id: "o", opening_code: "O", difficulty: 4, window_type_id: "T" }),
    ];
    const app = [{ id: "app", skill_level: 2, role: "installer" as const, active: true }];
    const ctx = {
      perf: {
        app: {
          T: { installer_id: "app", window_type_id: "T", n: 3, median_minutes: 40, avg_grade: 4, fail_rate: 0 },
        },
      },
    };
    expect(autoDistribute(openings, app, ctx).map((x) => x.profileId)).toEqual(["app"]);
  });
});

describe("orderMyWork / nextForInstaller", () => {
  it("puts ready openings first, then by sequence", () => {
    const list = [
      opening({ id: "b", opening_code: "B", ready: true, sequence: 2 }),
      opening({ id: "a", opening_code: "A", ready: true, sequence: 1 }),
      opening({ id: "c", opening_code: "C", ready: false, sequence: 0 }),
    ];
    expect(orderMyWork(list).map((o) => o.id)).toEqual(["a", "b", "c"]);
  });

  it("nextForInstaller returns the first ready opening", () => {
    const list = [
      opening({ id: "notready", opening_code: "N", ready: false, sequence: 0 }),
      opening({ id: "ready", opening_code: "R", ready: true, sequence: 1 }),
    ];
    expect(nextForInstaller(list)?.id).toBe("ready");
  });

  it("nextForInstaller excludes blocked openings", () => {
    const list = [
      opening({ id: "blk", opening_code: "BK", ready: true, blocked: true, sequence: 0 }),
      opening({ id: "ok", opening_code: "OK", ready: true, sequence: 1 }),
    ];
    expect(nextForInstaller(list)?.id).toBe("ok");
  });
});
