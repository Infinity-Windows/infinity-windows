// Start day against the real clock path (Codex review of #642, 2026-09-25):
// the real clockIn, the real outbox and its real sender, with only the server
// stubbed — and stubbed the way 20261028000000 behaves: a repeat of a client
// id is answered with the shift it already made. The case a phone on one bar
// meets: the server saves the clock-in, the reply is lost, the phone queues
// it, and the queue sends it again. One shift — which it is only because the
// live try and the queued resend carry the same punch and the same mode.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
  supabaseConfigured: true,
}));
vi.mock("../signedIn", () => ({ signedInEmail: () => "e2e@example.test" }));
vi.mock("../offline/telemetry", () => ({ logOfflineEvent: () => {} }));

const outbox = await import("../offline/outbox");
const { startShiftOrQueue } = await import("./startShift");
const { mintPunch } = await import("../timeclock");

const ME = "00000000-0000-4000-8000-0000000000e2";
const JOB = "3cc5b810-45e0-4445-a115-efa98f8efad3";
const CODE = "11111111-aaaa-4aaa-8aaa-111111111111";

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
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  await outbox.recoverAndDrain();
});
afterEach(() => {
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
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
