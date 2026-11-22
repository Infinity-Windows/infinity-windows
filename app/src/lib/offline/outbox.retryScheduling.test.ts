// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: "owner-a", rpc: vi.fn(), changed: null as null | (() => void),
}));
vi.mock("../signedIn", () => ({
  signedInUserId: () => state.user || null,
  signedInEmail: () => state.user ? `${state.user}@example.invalid` : null,
  subscribeSignedIn: (cb: () => void) => { state.changed = cb; return () => {}; },
}));
vi.mock("../supabase", () => {
  const client = {
    rpc: (...args: unknown[]) => state.rpc(...args),
    auth: { getSession: async () => ({ data: { session: state.user ? {
      access_token: `fixture-${state.user}`,
      user: { id: state.user, email: `${state.user}@example.invalid` },
    } : null }, error: null }) },
  };
  return { supabase: client, clientWithToken: () => client, supabaseConfigured: true };
});
vi.mock("./telemetry", () => ({ logOfflineEvent: () => {} }));

let outbox: typeof import("./outbox");
const online = (value: boolean) => Object.defineProperty(navigator, "onLine", { value, configurable: true });
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ now: new Date("2026-10-17T12:00:00Z") });
  state.user = "owner-a"; state.changed = null; state.rpc.mockReset();
  outbox = await import("./outbox");
});
afterEach(() => { outbox.stopOutboxAutoFlush(); vi.useRealTimers(); online(true); });

async function failedPunch() {
  online(false);
  const id = await outbox.enqueueClockIn({
    projectId: "synthetic-project", costCodeId: "synthetic-code", profileId: "owner-a",
    punch: { clientId: "stable-punch", tappedAt: new Date().toISOString(), clockCheckedAt: null, clockSkewMs: null },
  });
  state.rpc.mockResolvedValueOnce({ error: new TypeError("Failed to fetch") });
  state.rpc.mockResolvedValue({ data: { id: "synthetic-shift" }, error: null });
  online(true); outbox.initOutboxAutoFlush();
  await vi.advanceTimersByTimeAsync(0);
  expect(state.rpc).toHaveBeenCalledTimes(1);
  const row = (await outbox.listAll()).find(e => e.id === id)!;
  expect(row).toMatchObject({ ownerId: "owner-a", attemptCount: 1, status: "queued" });
  expect(row.nextAttemptAt - Date.now()).toBe(10_000);
  return id;
}

it("reconnect preserves backoff but retries at its due time, before the 30-second poll", async () => {
  await failedPunch();
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(9_999);
  expect(state.rpc).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(state.rpc).toHaveBeenCalledTimes(2);
  expect(state.rpc.mock.calls.map(c => c[1].p_client_id)).toEqual(["stable-punch", "stable-punch"]);
  expect(await outbox.listAll()).toEqual([]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(state.rpc).toHaveBeenCalledTimes(2);
});

it("a due wake cannot send another owner's punch; the original owner can resume it", async () => {
  const id = await failedPunch();
  state.user = "owner-b";
  await vi.advanceTimersByTimeAsync(10_000);
  expect(state.rpc).toHaveBeenCalledTimes(1);
  expect((await outbox.listAll()).find(e => e.id === id)?.ownerId).toBe("owner-a");
  state.user = "owner-a"; state.changed!();
  await vi.advanceTimersByTimeAsync(0);
  expect(state.rpc).toHaveBeenCalledTimes(2);
  expect(await outbox.listAll()).toEqual([]);
});

it("due, focus and reconnect wakes share one in-flight retry", async () => {
  await failedPunch();
  let finish!: (value: unknown) => void;
  state.rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(state.rpc).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(1);
  expect(state.rpc).toHaveBeenCalledTimes(2);
  finish({ data: { id: "synthetic-shift" }, error: null });
  await vi.advanceTimersByTimeAsync(0);
  expect(await outbox.listAll()).toEqual([]);
  expect(state.rpc).toHaveBeenCalledTimes(2);
});

it("an offline due time waits for reconnect rather than sending without signal", async () => {
  await failedPunch();
  online(false); window.dispatchEvent(new Event("offline"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(state.rpc).toHaveBeenCalledTimes(1);
  online(true); window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(0);
  expect(state.rpc).toHaveBeenCalledTimes(2);
  expect(await outbox.listAll()).toEqual([]);
});

it("a second failure retains exponential backoff and the original command identity", async () => {
  await failedPunch();
  state.rpc.mockResolvedValueOnce({ error: new TypeError("Failed to fetch") });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(state.rpc).toHaveBeenCalledTimes(2);
  expect((await outbox.listAll())[0].nextAttemptAt - Date.now()).toBe(20_000);
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(19_999);
  expect(state.rpc).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(state.rpc.mock.calls.map(c => c[1].p_client_id)).toEqual(["stable-punch", "stable-punch", "stable-punch"]);
  expect(await outbox.listAll()).toEqual([]);
});

it("stopping auto-flush cancels due wakes and removes reconnect listeners", async () => {
  await failedPunch();
  outbox.stopOutboxAutoFlush();
  await vi.advanceTimersByTimeAsync(30_000);
  window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(state.rpc).toHaveBeenCalledTimes(1);
  expect(await outbox.listAll()).toHaveLength(1);
});
