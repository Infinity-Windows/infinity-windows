// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQueueCoordinator } from "./queueCoordinator";

let coordinator: ReturnType<typeof createQueueCoordinator>;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { coordinator?.stop(); vi.useRealTimers(); });
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const port = { online: () => true, recover: vi.fn(async () => {}), recoverSigner: vi.fn(async () => {}),
    execute: vi.fn(async (_force: boolean) => {}), publish: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({ hasPending: false, nextRetryAt: null as number | null })),
    subscribeAuth: (_changed: () => void) => () => {}, report: vi.fn(), ...overrides };
  coordinator = createQueueCoordinator(port);
  return port;
}

it("serializes startup recovery with early enqueue requests and coalesces event bursts", async () => {
  const recovery = gate();
  const port = fixture({ recover: vi.fn(() => recovery.promise) });
  coordinator.start();
  await coordinator.request();
  window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online"));
  expect(port.recover).toHaveBeenCalledTimes(1);
  expect(port.execute).not.toHaveBeenCalled();
  recovery.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(port.recover).toHaveBeenCalledTimes(1);
  // At most one follow-up turn for all wakes received during recovery.
  expect(port.execute.mock.calls.length).toBeLessThanOrEqual(2);
  expect(port.execute).toHaveBeenCalled();
});

it("stop during asynchronous inspection cannot leave a late timer running", async () => {
  const inspection = gate();
  const port = fixture({ inspect: vi.fn(async () => { await inspection.promise; return { hasPending: true, nextRetryAt: Date.now() + 100 }; }) });
  coordinator.start(); await vi.advanceTimersByTimeAsync(0);
  expect(port.execute).toHaveBeenCalledTimes(1);
  coordinator.stop(); inspection.resolve();
  await vi.advanceTimersByTimeAsync(30_000);
  window.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(0);
  expect(port.execute).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("hydrates retained work offline without executing it, then recovers only once", async () => {
  let connected = false;
  const port = fixture({ online: () => connected });
  coordinator.start(); await vi.advanceTimersByTimeAsync(0);
  expect(port.recover).toHaveBeenCalledTimes(1);
  expect(port.publish).toHaveBeenCalled();
  expect(port.execute).not.toHaveBeenCalled();
  connected = true; window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(0);
  expect(port.execute).toHaveBeenCalledTimes(1);
  coordinator.stop(); coordinator.start(); await vi.advanceTimersByTimeAsync(0);
  expect(port.recover).toHaveBeenCalledTimes(1);
});

it("an auth generation change retires a queued manual override", async () => {
  let authChanged!: () => void;
  const sending = gate();
  const port = fixture({ subscribeAuth: (cb: () => void) => { authChanged = cb; return () => {}; },
    execute: vi.fn(async (_force: boolean) => { await sending.promise; }) });
  coordinator.start(); await vi.advanceTimersByTimeAsync(0);
  await coordinator.request(true);
  authChanged(); sending.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(port.execute.mock.calls.map(c => c[0])).toEqual([false, false]);
  expect(port.recoverSigner).toHaveBeenCalledTimes(1);
});

it("failed recovery blocks sending and is retried rather than marked complete", async () => {
  const port = fixture();
  port.recover.mockRejectedValueOnce(new Error("storage unavailable"));
  coordinator.start(); await vi.advanceTimersByTimeAsync(0);
  expect(port.report).toHaveBeenCalledTimes(1);
  expect(port.execute).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(port.recover).toHaveBeenCalledTimes(2);
  expect(port.execute).toHaveBeenCalledTimes(1);
});
