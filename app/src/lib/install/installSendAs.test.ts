// A queued install is filed as the person who submitted it (Codex's full
// re-check of #660, P1). The install queue checks the saved owner against the
// session, then hands submitInstallEvent and awardPoints a client locked to
// that session's token and the installer read from that same session. Neither
// may reach for the shared client or ask auth who is signed in by then —
// finish_unit files the install under the caller and closes the CALLER's unit
// session.

import { describe, expect, it, vi } from "vitest";

// Touching the shared client at all is the bug.
vi.mock("../supabase", () => ({
  supabase: new Proxy(
    {},
    {
      get: (_t, prop) => {
        throw new Error(`the shared client was used (${String(prop)})`);
      },
    },
  ),
}));

const { submitInstallEvent } = await import("./api");
const { awardPoints } = await import("../points");

function lockedClient(calls: { fn: string; args: Record<string, unknown> }[]) {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: { id: "event-1" }, error: null };
    },
  } as unknown as Parameters<typeof awardPoints>[4];
}

describe("sending a queued install as its submitter", () => {
  it("files finish_unit through the client it is handed, naming the installer it is handed", async () => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const event = await submitInstallEvent(
      { openingId: "opening-1", minutes: 12, qualityGrade: 4 },
      { client: lockedClient(calls)!, installer: { id: "installer-a", email: "a@crew.com" } },
    );
    expect(event).toEqual({ id: "event-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe("finish_unit");
    expect(calls[0].args).toMatchObject({
      p_opening_id: "opening-1",
      p_installer: "a@crew.com",
      p_installer_id: "installer-a",
    });
  });

  it("awards the install's points through that same client", async () => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    await awardPoints("installer-a", [{ kind: "install", points: 20 }], "opening-1", "pending", lockedClient(calls));
    expect(calls.map((c) => c.fn)).toEqual(["award_install_points"]);
    expect(calls[0].args).toMatchObject({ p_ref: "opening-1" });
  });
});
