// "Need a job for this?" — the audience math, and that requestJobForClockIn
// rings exactly that computed set (standard-tracking-jobs slice 5).

import { beforeEach, describe, expect, it, vi } from "vitest";

const clockedIn = vi.hoisted(() => ({ rows: [] as { profileId: string }[] }));
const profilesHolder = vi.hoisted(() => ({ rows: [] as { id: string; role: string }[] }));
const push = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[], returns: true }));

vi.mock("./install/summons", () => ({
  listClockedInAnywhere: () => Promise.resolve(clockedIn.rows),
}));
vi.mock("./install/api", () => ({
  listProfiles: () => Promise.resolve(profilesHolder.rows),
}));
vi.mock("./permissions/pushServer", () => ({
  sendPush: (input: Record<string, unknown>) => {
    push.calls.push(input);
    return Promise.resolve(push.returns);
  },
}));

import { needJobAudience, requestJobForClockIn } from "./needJob";

const P = {
  installer: { id: "i1", role: "installer" },
  foremanOn: { id: "f1", role: "foreman" },
  foremanOff: { id: "f2", role: "foreman" },
  supervisor: { id: "s1", role: "supervisor" },
  owner: { id: "o1", role: "owner" },
};
const ALL = Object.values(P);

describe("needJobAudience", () => {
  it("rings on-shift foreman+ plus every supervisor, minus the caller", () => {
    const audience = needJobAudience(["i1", "f1"], ALL, "i1");
    // f1 (on-shift foreman), s1 + o1 (supervisor+, always). f2 is off shift; i1
    // is the caller and an installer either way.
    expect(audience.sort()).toEqual(["f1", "o1", "s1"]);
  });

  it("falls back to just the supervisors when no foreman+ is on shift", () => {
    const audience = needJobAudience(["i1"], ALL, "i1");
    expect(audience.sort()).toEqual(["o1", "s1"]);
  });

  it("never rings an off-shift foreman", () => {
    expect(needJobAudience([], ALL, null)).toEqual(
      expect.arrayContaining(["s1", "o1"]),
    );
    expect(needJobAudience([], ALL, null)).not.toContain("f2");
    expect(needJobAudience([], ALL, null)).not.toContain("f1");
  });

  it("dedupes a supervisor who is also on the clock", () => {
    const audience = needJobAudience(["s1"], ALL, "i1");
    expect(audience.filter((id) => id === "s1")).toHaveLength(1);
  });

  it("never rings a login that was removed for good", () => {
    // Both halves of the union have to drop them: the backstop (a removed
    // supervisor) and the on-shift half (a removed foreman with a shift nobody
    // closed). The ban means their phone could not sign in anyway — the point
    // is that "a lead was told" must not be true when nobody was.
    const gone = [
      ...ALL,
      { id: "s2", role: "supervisor", retired_at: "2026-09-04T00:00:00Z" },
      { id: "f3", role: "foreman", retired_at: "2026-09-04T00:00:00Z" },
    ];
    const audience = needJobAudience(["f3"], gone, "i1");
    expect(audience).not.toContain("s2");
    expect(audience).not.toContain("f3");
    expect(audience.sort()).toEqual(["o1", "s1"]);
  });
});

describe("requestJobForClockIn", () => {
  beforeEach(() => {
    push.calls = [];
    push.returns = true;
    clockedIn.rows = [{ profileId: "i1" }, { profileId: "f1" }];
    profilesHolder.rows = ALL;
  });

  it("pushes to exactly the computed audience", async () => {
    const ok = await requestJobForClockIn({
      note: "warranty callback",
      address: "123 Main",
      callerId: "i1",
      callerName: "Dana",
    });
    expect(ok).toBe(true);
    expect(push.calls).toHaveLength(1);
    expect((push.calls[0].profileIds as string[]).sort()).toEqual(["f1", "o1", "s1"]);
    expect(String(push.calls[0].body)).toContain("Dana");
    expect(String(push.calls[0].body)).toContain("warranty callback");
  });

  it("returns false and rings no one when nobody is reachable", async () => {
    // No supervisors, no on-shift foreman: an installer-only company.
    clockedIn.rows = [{ profileId: "i1" }];
    profilesHolder.rows = [P.installer, P.foremanOff];
    const ok = await requestJobForClockIn({ callerId: "i1", callerName: "Dana" });
    expect(ok).toBe(false);
    expect(push.calls).toHaveLength(0);
  });
});
