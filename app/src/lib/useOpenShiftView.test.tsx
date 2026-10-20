// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxEntry } from "./offline/outbox-core";
import type { TimeShift } from "./timeclock";

const fake = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { snapshot: { entries: [] as OutboxEntry[], ready: true }, aliases: {} as Record<string, string> };
  return {
    state,
    read: vi.fn(),
    set(entries: OutboxEntry[], ready = true) {
      state.snapshot = { entries, ready };
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
});
vi.mock("./offline/outbox", () => ({
  getClockQueueSnapshot: () => fake.state.snapshot,
  subscribe: fake.subscribe,
  initOutboxAutoFlush: () => {},
  resolveShiftRef: (ref: string) => fake.state.aliases[ref] ?? null,
}));
vi.mock("./timeclock", async (original) => ({
  ...await original<typeof import("./timeclock")>(),
  getOpenShift: fake.read,
}));

import { useOpenShiftView, type OpenShiftView } from "./useOpenShiftView";
import { clockReadFor } from "./clockRead";
import { CLOCK_READ_MAX_AGE_MS, CLOCK_READ_TIMEOUT_MS } from "./clockReadState";
import { rememberSignedIn } from "./signedIn";

const NOW = new Date(2026, 9, 20, 14).getTime();
const row = (over: Partial<TimeShift> = {}): TimeShift => ({
  id: "today", profile_id: "a", project_id: "job", cost_code_id: "code",
  clock_in_at: new Date(NOW - 3_600_000).toISOString(), clock_out_at: null,
  status: "open", break_seconds: 0, break_started_at: null, break_type: null,
  injured: null, time_confirmed: null, created_at: new Date(NOW - 3_600_000).toISOString(), ...over,
});
const entry = (op: OutboxEntry["op"], payload: Record<string, unknown>, id = op): OutboxEntry => ({
  id, op, ownerId: "a", payload: { tappedAt: new Date(NOW).toISOString(), ...payload },
  createdAt: NOW, attemptCount: 0, lastError: null, status: "queued", nextAttemptAt: 0,
  dependsOn: null, hasBlob: false,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let root: Root;
let host: HTMLDivElement;
let qc: QueryClient;
let latest: OpenShiftView;
let renders: OpenShiftView[];
function Probe({ profileId }: { profileId: string }) {
  latest = useOpenShiftView(profileId);
  renders.push(latest);
  return <span>{latest.verification.status}</span>;
}
async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(1); }); }
async function mount(cached: TimeShift | null | undefined, ready = true) {
  fake.set(fake.state.snapshot.entries, ready);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  if (cached !== undefined) qc.setQueryData(["openShift", "a"], cached);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(<QueryClientProvider client={qc}><Probe profileId="a" /></QueryClientProvider>); });
  await flush();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  rememberSignedIn({ user: { id: "a" } });
  fake.set([]);
  fake.state.aliases = {};
  fake.read.mockReset().mockImplementation(() => new Promise(() => {}));
  renders = [];
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  qc?.clear();
  host?.remove();
  rememberSignedIn(null);
  vi.useRealTimers();
});

describe("mounted shared clock evidence", () => {
  it("never presents hydrated success as a verified old shift; read failure preserves recovery", async () => {
    const read = deferred<TimeShift | null>();
    fake.read.mockReturnValue(read.promise);
    const old = row({ clock_in_at: "2026-09-11T12:36:39Z" });
    await mount(old);
    expect(renders.every((view) => view.verification.recoveryRequired)).toBe(true);
    expect(latest.shift?.id).toBe(old.id);
    await act(async () => read.reject(new Error("network failed")));
    await flush();
    expect(latest.query.data).toEqual(old);
    expect(latest.verification).toMatchObject({ status: "unavailable", recoveryRequired: true });
  });

  it("accepts a newly delivered null immediately, before the next clock tick, and expires it", async () => {
    const read = deferred<TimeShift | null>();
    fake.read.mockReturnValueOnce(read.promise).mockRejectedValue(new Error("offline"));
    await mount(null);
    expect(latest.verification.recoveryRequired).toBe(true);
    await act(async () => { vi.setSystemTime(NOW + 10); read.resolve(null); });
    await flush();
    expect(latest.verification).toMatchObject({ status: "verified", recoveryRequired: false });
    await act(async () => { latest.recheck(); });
    await flush();
    expect(latest.verification).toMatchObject({ status: "saved", recoveryRequired: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(CLOCK_READ_MAX_AGE_MS + 1000); });
    expect(latest.verification.recoveryRequired).toBe(true);
  });

  it("keeps the original queued clock-in and dependent clock-out through failed reads", async () => {
    fake.read.mockRejectedValue(new Error("offline"));
    const clockIn = entry("clock_in", { projectId: "job", clientId: "tap" });
    fake.set([clockIn]);
    await mount(null);
    expect(latest.shift).toMatchObject({ id: `pending:${clockIn.id}`, clock_in_at: clockIn.payload.tappedAt });
    expect(latest.verification.recoveryRequired).toBe(false);
    const clockOut = entry("clock_out", { shiftRef: `pending:${clockIn.id}` });
    clockOut.createdAt++;
    await act(async () => { fake.set([clockIn, clockOut]); qc.setQueryData(["openShift", "a"], null); });
    await flush();
    expect(latest.shift).toBeNull();
    expect(latest.pending?.entryId).toBe(clockOut.id);
    expect(latest.verification.recoveryRequired).toBe(false);
    expect(fake.state.snapshot.entries).toEqual([clockIn, clockOut]);
  });

  it("retains a matching queued clock-out when its optimistic null and queue arrive in one batch", async () => {
    fake.read.mockRejectedValue(new Error("offline"));
    await mount(row());
    const clockOut = entry("clock_out", { shiftRef: "today" });
    await act(async () => { fake.set([clockOut]); qc.setQueryData(["openShift", "a"], null); });
    await flush();
    expect(latest.shift).toBeNull();
    expect(latest.verification).toMatchObject({ status: "saved", recoveryRequired: false });
    await act(async () => { latest.recheck(); fake.set([{ ...clockOut, status: "sending" }]); });
    await flush();
    expect(latest.verification.recoveryRequired).toBe(false);
    await act(async () => fake.set([{ ...clockOut, status: "failed" }]));
    expect(latest.verification.recoveryRequired).toBe(true);
    expect(latest.refused).toHaveLength(1);
  });

  it("does not accept an arbitrary queued clock-out or a changed reference", async () => {
    await mount(row());
    const unrelated = entry("clock_out", { shiftRef: "someone-else" });
    await act(async () => { fake.set([unrelated]); qc.setQueryData(["openShift", "a"], null); });
    await flush();
    expect(latest.verification.recoveryRequired).toBe(true);
    expect(clockReadFor(qc, "a").acknowledge(unrelated, null)).toBe(false);
  });

  it("a matching acknowledgement survives queue deletion as saved state, never as a fresh read", async () => {
    await mount(row());
    const clockOut = entry("clock_out", { shiftRef: "today" });
    await act(async () => { fake.set([clockOut]); qc.setQueryData(["openShift", "a"], null); });
    await flush();
    const reader = clockReadFor(qc, "a");
    await act(async () => { expect(reader.acknowledge(clockOut, null)).toBe(true); fake.set([]); });
    expect(reader.snapshot().checkedAt).toBe(0);
    expect(latest.verification).toMatchObject({ status: "saved", recoveryRequired: false });
    await act(async () => { rememberSignedIn({ user: { id: "b" } }); rememberSignedIn({ user: { id: "a" } }); });
    expect(reader.acknowledge(clockOut, null)).toBe(false);
    expect(latest.verification.recoveryRequired).toBe(true);
  });

  it("does not authorize an unrelated acknowledgement beside an applied clock-in", async () => {
    const clockIn = entry("clock_in", { projectId: "job", clientId: "tap" });
    const unrelated = entry("clock_out", { shiftRef: "unrelated" });
    unrelated.createdAt++;
    fake.set([clockIn, unrelated]);
    await mount(null);
    const reader = clockReadFor(qc, "a");
    expect(latest.verification.recoveryRequired).toBe(false);
    expect(reader.acknowledge(unrelated, null)).toBe(false);
    expect(reader.acknowledge({ ...clockIn, ownerId: "b" }, row())).toBe(false);
  });

  it("does not reauthorize an old ACK when a queued clock-in survives A to B to A", async () => {
    const clockIn = entry("clock_in", { projectId: "job", clientId: "tap" });
    fake.set([clockIn]);
    await mount(null);
    const reader = clockReadFor(qc, "a");
    await act(async () => { rememberSignedIn({ user: { id: "b" } }); rememberSignedIn({ user: { id: "a" } }); });
    await flush();
    expect(latest.shift?.id).toBe(`pending:${clockIn.id}`);
    expect(latest.verification.recoveryRequired).toBe(false);
    expect(reader.acknowledge(clockIn, row())).toBe(false);
  });

  it("does not replace a newer read of another shift with an earlier queued acknowledgement", async () => {
    const clockIn = entry("clock_in", { projectId: "job", clientId: "tap" });
    fake.set([clockIn]);
    await mount(null);
    fake.read.mockResolvedValueOnce(row({ id: "newer-server-shift" }));
    await act(async () => latest.recheck());
    await flush();
    expect(clockReadFor(qc, "a").acknowledge(clockIn, row({ id: "old-ack" }))).toBe(false);
    expect(qc.getQueryData<TimeShift>(["openShift", "a"])?.id).toBe("newer-server-shift");
  });

  it("keeps a confirmed queued break end after deletion while the read hangs", async () => {
    const onBreak = row({ break_started_at: new Date(NOW - 60_000).toISOString(), break_type: "lunch" });
    await mount(onBreak);
    const end = entry("break_stop", { shiftRef: "today" });
    await act(async () => fake.set([end]));
    expect(latest.shift?.break_started_at).toBeNull();
    const returned = row({ break_seconds: 60 });
    await act(async () => {
      expect(clockReadFor(qc, "a").acknowledge(end, returned)).toBe(true);
      qc.setQueryData(["openShift", "a"], returned);
      fake.set([]);
    });
    await flush();
    expect(latest.shift?.break_started_at).toBeNull();
    expect(latest.shift?.break_seconds).toBe(60);
    expect(latest.verification).toMatchObject({ status: "saved", recoveryRequired: false });
  });

  it("an acknowledged clock-in supersedes a pre-ACK read of the old empty state", async () => {
    const oldRead = deferred<TimeShift | null>();
    fake.read.mockReturnValueOnce(oldRead.promise);
    const clockIn = entry("clock_in", { projectId: "job", clientId: "tap" });
    fake.set([clockIn]);
    await mount(null);
    const returned = row({ client_id: "tap" });
    await act(async () => {
      expect(clockReadFor(qc, "a").acknowledge(clockIn, returned)).toBe(true);
      await qc.cancelQueries({ queryKey: ["openShift", "a"], exact: true });
      qc.setQueryData(["openShift", "a"], returned);
      fake.set([]);
    });
    await act(async () => oldRead.resolve(null));
    await flush();
    expect(latest.shift?.id).toBe(returned.id);
    expect(latest.verification).toMatchObject({ status: "saved", recoveryRequired: false });
  });

  it("invalidating an unaccepted own ACK removes prior empty-read proof before queue deletion", async () => {
    fake.read.mockResolvedValueOnce(null);
    await mount(null);
    expect(latest.verification.status).toBe("verified");
    await act(async () => clockReadFor(qc, "a").invalidateReadProof());
    expect(latest.verification.recoveryRequired).toBe(true);
    expect(latest.verification.status).toBe("unavailable");
  });

  it("accepts the queued clock-out ACK after a newer read still reports its same target", async () => {
    await mount(row());
    const out = entry("clock_out", { shiftRef: "today" });
    await act(async () => { fake.set([out]); qc.setQueryData(["openShift", "a"], null); });
    await flush();
    fake.read.mockResolvedValueOnce(row());
    await act(async () => latest.recheck());
    await flush();
    expect(latest.shift).toBeNull();
    await act(async () => {
      expect(clockReadFor(qc, "a").acknowledge(out, null)).toBe(true);
      qc.setQueryData(["openShift", "a"], null);
      fake.set([]);
    });
    await flush();
    expect(latest.shift).toBeNull();
    expect(latest.verification).toMatchObject({ status: "saved", recoveryRequired: false });
  });

  it("bounds auth-before-fetch hangs and ignores a late answer after a successful retry", async () => {
    const first = deferred<TimeShift | null>();
    fake.read.mockReturnValueOnce(first.promise).mockResolvedValueOnce(row());
    await mount(null);
    await act(async () => { await vi.advanceTimersByTimeAsync(CLOCK_READ_TIMEOUT_MS); });
    expect(fake.read.mock.calls[0][1].aborted).toBe(true);
    expect(latest.verification).toMatchObject({ status: "unavailable", recoveryRequired: true });
    await act(async () => latest.recheck());
    await flush();
    expect(latest.verification.status).toBe("verified");
    await act(async () => first.resolve(row({ id: "late-old" })));
    await flush();
    expect(latest.shift?.id).toBe("today");
  });

  it("fences an old read and old queue when the profile changes", async () => {
    const first = deferred<TimeShift | null>();
    fake.read.mockReturnValueOnce(first.promise).mockResolvedValueOnce(null);
    fake.set([entry("clock_in", { profileId: "a", projectId: "job" })]);
    await mount(null);
    await act(async () => {
      rememberSignedIn({ user: { id: "b" } });
      root.render(<QueryClientProvider client={qc}><Probe profileId="b" /></QueryClientProvider>);
      first.resolve(row());
    });
    await flush();
    expect(latest.pending).toBeNull();
    expect(latest.shift).toBeNull();
    expect(clockReadFor(qc, "a").snapshot().checkedAt).toBe(0);
  });

  it("keeps controls guarded until the owned queue has loaded even with a successful read", async () => {
    fake.read.mockResolvedValue(null);
    await mount(null, false);
    expect(latest.verification.recoveryRequired).toBe(true);
    await act(async () => fake.set([], true));
    expect(latest.verification.recoveryRequired).toBe(false);
  });
});
