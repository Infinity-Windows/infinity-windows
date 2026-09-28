// Start day against the real clock path (Codex review of #642, 2026-09-25):
// the real clockIn, the real outbox and its real sender, with only the server
// stubbed — and stubbed the way 20261028000000 behaves: a repeat of a client
// id is answered with the shift it already made. The case a phone on one bar
// meets: the server saves the clock-in, the reply is lost, the phone queues
// it, and the queue sends it again. One shift — which it is only because the
// live try and the queued resend carry the same punch and the same mode.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ME = "00000000-0000-4000-8000-0000000000e2";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const JOB = "3cc5b810-45e0-4445-a115-efa98f8efad3";
const CODE = "11111111-aaaa-4aaa-8aaa-111111111111";

const rpc = vi.fn();
// The session getSession() answers with, and how long it takes to answer.
// Tests swap these to play out the account-switch race: a slow resolve lets
// signedInUserId() move to another account WHILE the read is still pending.
let sessionUserId: string | null = ME;
let sessionDelayMs = 0;
vi.mock("../supabase", () => {
  // The outbox sends a write only as the person who queued it, through a
  // client bound to that person's token (2026-09-25): here, the same stub.
  const supabase = {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: {
      getSession: async () => {
        if (sessionDelayMs > 0) await new Promise((r) => setTimeout(r, sessionDelayMs));
        const id = sessionUserId;
        return {
          data: { session: id ? { access_token: `token-${id}`, user: { id, email: `${id}@example.test` } } : null },
          error: null,
        };
      },
    },
  };
  // Tags every RPC sent through a bound client with the token it was bound to
  // (a 3rd arg the real clientWithToken client never sends) — how the tests
  // below tell "went out as A" from "went out as B" after the switch.
  return {
    supabase,
    clientWithToken: (token: string) => ({ rpc: (...args: unknown[]) => rpc(...args, token) }),
    supabaseConfigured: true,
  };
});
// signedInUserId() tracks the SAME switch sessionUserId does, so the two
// stay consistent the way the app's real signedIn module keeps them (App
// hands every session change to both auth storage and signedIn together).
vi.mock("../signedIn", () => ({
  signedInEmail: () => (sessionUserId ? `${sessionUserId}@example.test` : null),
  signedInUserId: () => sessionUserId,
  subscribeSignedIn: () => () => {},
}));
vi.mock("../offline/telemetry", () => ({ logOfflineEvent: () => {} }));

const outbox = await import("../offline/outbox");
const { startShiftOrQueue, SESSION_WAIT_MS } = await import("./startShift");
const { mintPunch } = await import("../timeclock");

/** What supabase-js hands back when fetch itself failed: the reply is lost. */
const LOST_REPLY = { data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" } };

type Args = Record<string, unknown>;

/** A keyed clock_in server. `loseFirstReply`: the first call is SAVED, and its reply never arrives. */
function keyedServer(opts: { loseFirstReply: boolean }) {
  const shifts = new Map<string, Args>();
  const calls: Args[] = [];
  rpc.mockImplementation(async (fn: string, args: Args) => {
    if (fn !== "clock_in") return { data: null, error: { message: `unexpected ${fn}`, code: "P0001" } };
    calls.push(args);
    const id = String(args.p_client_id ?? "");
    if (!id) return { data: null, error: { message: "This clock-in is missing its id.", code: "P0001" } };
    if (!shifts.has(id)) {
      shifts.set(id, {
        id: `shift-${shifts.size + 1}`,
        profile_id: ME,
        project_id: args.p_project_id,
        cost_code_id: args.p_cost_code_id,
        client_id: id,
        job_mode: args.p_mode ?? null,
        clock_in_at: args.p_tapped_at ?? new Date().toISOString(),
        clock_out_at: null,
        status: "open",
      });
    }
    if (opts.loseFirstReply && calls.length === 1) return LOST_REPLY;
    return { data: shifts.get(id), error: null };
  });
  return { shifts, calls };
}

const input = () => ({
  profileId: ME,
  projectId: JOB,
  costCodeId: CODE,
  note: null,
  mode: "tracking" as const,
  geo: {},
  punch: mintPunch(),
  projects: [{ id: JOB, job_code: "OAKRIDGE", name: "Oakridge Apartments Bldg C" }],
  costCodes: [{ id: CODE, code: "000", label: "General" }],
});

beforeEach(async () => {
  rpc.mockReset();
  sessionUserId = ME;
  sessionDelayMs = 0;
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  await outbox.recoverAndDrain();
});
afterEach(() => {
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  vi.useRealTimers();
});

async function queueSettled() {
  await vi.waitFor(() => expect(outbox.getClockQueueSnapshot().entries).toEqual([]), { timeout: 2000, interval: 10 });
}

describe("a Start day the server saved whose reply was lost", () => {
  it("is resent by the queue with the same punch and mode, and is one shift", async () => {
    const server = keyedServer({ loseFirstReply: true });
    const i = input();
    const out = await startShiftOrQueue(i);
    // The phone cannot know it was saved, so it shows the punch as kept,
    // from the moment of the tap.
    expect(out.queued).toBe(true);
    expect(out.shift.clock_in_at).toBe(i.punch.tappedAt);
    await outbox.drain();
    await queueSettled();

    expect(server.calls).toHaveLength(2);
    const [first, resend] = server.calls;
    expect(resend.p_client_id).toBe(i.punch.clientId);
    expect(first.p_client_id).toBe(i.punch.clientId);
    expect(resend.p_tapped_at).toBe(first.p_tapped_at);
    expect([first.p_mode, resend.p_mode]).toEqual(["tracking", "tracking"]);
    expect([first.p_project_id, resend.p_project_id]).toEqual([JOB, JOB]);
    // One shift on the server.
    expect(server.shifts.size).toBe(1);
  });

  it("a reply that arrives is one call and nothing queued", async () => {
    const server = keyedServer({ loseFirstReply: false });
    const i = input();
    const out = await startShiftOrQueue(i);
    expect(out).toMatchObject({ queued: false, shift: { client_id: i.punch.clientId } });
    await outbox.drain();
    expect(server.calls).toHaveLength(1);
    expect(outbox.getClockQueueSnapshot().entries).toEqual([]);
  });

  it("a refusal the server wrote is thrown, never queued", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "complete today's toolbox talk before clocking in", code: "P0001" } });
    await expect(startShiftOrQueue(input())).rejects.toMatchObject({ message: expect.stringContaining("toolbox talk") });
    expect(outbox.getClockQueueSnapshot().entries).toEqual([]);
  });
});

describe("the direct-RPC identity race (A taps, B signs in on the shared phone)", () => {
  it("B signing in while getSession() is still pending refuses the tap — no RPC, nothing queued", async () => {
    sessionUserId = ME;
    // Long enough that the switch below lands well before getSession answers.
    sessionDelayMs = 50;
    keyedServer({ loseFirstReply: false });
    const i = input();
    const pending = startShiftOrQueue(i);
    await new Promise((r) => setTimeout(r, 10));
    sessionUserId = OTHER; // B signs in mid-read
    await expect(pending).rejects.toMatchObject({ message: expect.stringContaining("another account") });
    expect(rpc).not.toHaveBeenCalled();
    expect(outbox.getClockQueueSnapshot().entries).toEqual([]);
  });

  it("a session read that never comes back in time queues the original tap once, and its own late reply sends nothing extra", async () => {
    vi.useFakeTimers();
    sessionUserId = ME;
    sessionDelayMs = SESSION_WAIT_MS + 5000; // resolves long after the bounded wait gives up
    const server = keyedServer({ loseFirstReply: false });
    const i = input();
    const pending = startShiftOrQueue(i);

    await vi.advanceTimersByTimeAsync(SESSION_WAIT_MS + 10);
    const out = await pending;
    expect(out.queued).toBe(true);
    expect(out.shift.clock_in_at).toBe(i.punch.tappedAt);
    // Nothing sent yet from startShiftOrQueue's own (now-abandoned) session
    // read — only the queue's own fire-and-forget drain may still be in flight.
    expect(outbox.getClockQueueSnapshot().entries).toHaveLength(1);

    // Let BOTH the queue's own drain AND the stale getSession() (bound to the
    // live try that was abandoned at the timeout) finish. If the stale read
    // were still wired to send, this tap would reach the server twice — once
    // from the abandoned live try, once from the queue.
    await vi.advanceTimersByTimeAsync(sessionDelayMs);
    vi.useRealTimers();
    await queueSettled();
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].p_client_id).toBe(i.punch.clientId);
  });

  it("A's token carries every RPC of one live call, even if B signs in between the overload fallbacks", async () => {
    sessionUserId = ME;
    sessionDelayMs = 0;
    let n = 0;
    rpc.mockImplementation(async (fn: string, args: Args) => {
      if (fn !== "clock_in") return { data: null, error: { message: `unexpected ${fn}`, code: "P0001" } };
      n++;
      if (n <= 2) {
        if (n === 2) sessionUserId = OTHER; // B signs in mid-cascade
        return { data: null, error: { code: "PGRST202", message: "could not find the function clock_in" } };
      }
      return {
        data: {
          id: "shift-bound",
          profile_id: ME,
          project_id: args.p_project_id,
          cost_code_id: args.p_cost_code_id,
          client_id: args.p_client_id,
          clock_in_at: args.p_tapped_at ?? new Date().toISOString(),
          clock_out_at: null,
          status: "open",
        },
        error: null,
      };
    });
    const i = input();
    const out = await startShiftOrQueue(i);
    expect(out.queued).toBe(false);
    expect(out.shift.id).toBe("shift-bound");
    expect(rpc).toHaveBeenCalledTimes(3);
    // Every one of the three calls — the keyed try and both older-overload
    // fallbacks — went out tagged with A's token, never B's, because the
    // whole cascade runs on the client startShiftOrQueue bound BEFORE the
    // first RPC, not the ambient session-following client.
    for (const call of rpc.mock.calls) {
      expect(call[2]).toBe(`token-${ME}`);
    }
    expect(outbox.getClockQueueSnapshot().entries).toEqual([]);
  });
});
