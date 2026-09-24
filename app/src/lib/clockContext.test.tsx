// @vitest-environment happy-dom
//
// The open-clock event can carry a pick (2026-09-06). This mounts the real
// provider with the sheet swapped for a probe that prints what it was handed,
// so it fails if the payload stops reaching the sheet, survives a close, or
// a bare open (the nav tab) starts inheriting the last hand-off.
//
// And since Release 0 (K0.1) the provider's shift is the server's shift with
// this phone's queued punches applied: a clock-in still on the phone is a
// shift here, a clock-out still on the phone is "off the clock", a refused
// punch is named, and a confirmed punch hands over to the server's row with
// no moment of "off the clock" in between. The outbox is a controllable fake.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxEntry } from "./offline/outbox-core";

vi.mock("../components/clock/ClockSheet", () => ({
  ClockSheet: (props: { initialPick: unknown; shift: { id: string } | null; pending: { kind: string } | null; onClose: () => void }) => (
    <div
      className="probe-sheet"
      data-pick={JSON.stringify(props.initialPick)}
      data-shift={props.shift?.id ?? "none"}
      data-pending={props.pending?.kind ?? "none"}
    >
      <button type="button" className="probe-close" onClick={props.onClose} />
    </div>
  ),
}));
vi.mock("../components/clock/FarFromJobPrompt", () => ({
  FarFromJobPrompt: () => null,
}));
vi.mock("../components/clock/LunchReminder", () => ({
  LunchReminder: () => null,
}));
vi.mock("./timeclock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./timeclock")>();
  return { ...actual, getOpenShift: vi.fn(async () => null) };
});

// The fake outbox: a snapshot the test sets, and the two announcements the
// provider listens for (a drain that sent something; a confirmed punch).
const fake = vi.hoisted(() => {
  const queueListeners = new Set<() => void>();
  const sentListeners = new Set<(entry: unknown, result: unknown) => void>();
  const syncedListeners = new Set<() => void>();
  const state = { snapshot: { entries: [] as unknown[], ready: true } };
  return {
    state,
    setQueue(entries: unknown[], ready = true) {
      state.snapshot = { entries, ready };
      for (const cb of queueListeners) cb();
    },
    confirm(entry: unknown, result: unknown) {
      for (const cb of sentListeners) cb(entry, result);
    },
    synced() {
      for (const cb of syncedListeners) cb();
    },
    module: {
      subscribe: (cb: () => void) => {
        queueListeners.add(cb);
        return () => queueListeners.delete(cb);
      },
      getClockQueueSnapshot: () => state.snapshot,
      subscribeClockSent: (cb: (entry: unknown, result: unknown) => void) => {
        sentListeners.add(cb);
        return () => sentListeners.delete(cb);
      },
      subscribeSynced: (cb: () => void) => {
        syncedListeners.add(cb);
        return () => syncedListeners.delete(cb);
      },
      initOutboxAutoFlush: () => {},
    },
  };
});
vi.mock("./offline/outbox", () => fake.module);

import { ClockProvider, OPEN_CLOCK_EVENT, openClockGlobally, useClock } from "./clockContext";
import type { TimeShift } from "./timeclock";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let qc: QueryClient | null = null;
/** Every shift id the probe rendered, in order — for "no gap" assertions. */
let rendered: string[] = [];

/** Prints the provider's value, the way a screen reads it. */
function Probe() {
  const clock = useClock();
  rendered.push(clock.shift?.id ?? "none");
  return (
    <span
      className="probe"
      data-shift={clock.shift?.id ?? "none"}
      data-loading={String(clock.loading)}
      data-pending={clock.pending?.kind ?? "none"}
      data-refused={String(clock.refused.length)}
      data-job={clock.shift?.projects?.job_code ?? ""}
    />
  );
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  qc = null;
});

beforeEach(() => {
  rendered = [];
  fake.setQueue([], true);
});

function mount(serverShift: TimeShift | null = null): HTMLElement {
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  qc.setQueryData(["myProfile"], { id: "me", role: "installer" });
  qc.setQueryData(["openShift", "me"], serverShift);
  qc.setQueryData(["projects"], [{ id: "p1", job_code: "BLACK22", name: "Black Desert" }]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc!}>
        <ClockProvider>
          <Probe />
        </ClockProvider>
      </QueryClientProvider>,
    );
  });
  return host;
}

const probe = (el: HTMLElement) => el.querySelector(".probe")!;

const PICK = { projectId: "p2", costCodeId: "cc2", note: "gate 4411", mode: "tracking" as const };
const TAP = "2026-09-23T13:02:00.000Z";

function queued(op: OutboxEntry["op"], payload: Record<string, unknown>, over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: over.id ?? `${op}-1`,
    op,
    payload: { tappedAt: TAP, ...payload },
    createdAt: over.createdAt ?? 1,
    attemptCount: 0,
    lastError: over.lastError ?? null,
    status: over.status ?? "queued",
    nextAttemptAt: 0,
    dependsOn: null,
    hasBlob: false,
  };
}

function serverShift(over: Partial<TimeShift> = {}): TimeShift {
  return {
    id: "s1",
    profile_id: "me",
    project_id: "p1",
    cost_code_id: "cc1",
    clock_in_at: "2026-09-23T12:55:00.000Z",
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    break_type: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: "2026-09-23T12:55:00.000Z",
    projects: { job_code: "BLACK22", name: "Black Desert" },
    cost_codes: null,
    ...over,
  };
}

describe("openClockGlobally", () => {
  it("dispatches a CustomEvent whose detail is the pick, or null when bare", () => {
    const seen: CustomEvent[] = [];
    const on = (e: Event) => seen.push(e as CustomEvent);
    window.addEventListener(OPEN_CLOCK_EVENT, on);
    try {
      openClockGlobally(PICK);
      openClockGlobally();
    } finally {
      window.removeEventListener(OPEN_CLOCK_EVENT, on);
    }
    expect(seen).toHaveLength(2);
    expect(seen[0].detail).toEqual(PICK);
    expect(seen[1].detail).toBeNull();
  });
});

describe("the clock provider", () => {
  it("opens the sheet with the carried pick, clears it on close, and a bare open is plain", () => {
    const el = mount();
    expect(el.querySelector(".probe-sheet")).toBeNull();

    act(() => openClockGlobally(PICK));
    expect(el.querySelector(".probe-sheet")?.getAttribute("data-pick")).toBe(JSON.stringify(PICK));

    act(() =>
      el.querySelector<HTMLButtonElement>(".probe-close")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    );
    expect(el.querySelector(".probe-sheet")).toBeNull();

    // The nav tab's bare open must not inherit the last hand-off.
    act(() => openClockGlobally());
    expect(el.querySelector(".probe-sheet")?.getAttribute("data-pick")).toBe("null");
  });

  it("ignores a detail that is not a pick, so a stray handler argument opens the sheet plain", () => {
    const el = mount();
    act(() => window.dispatchEvent(new CustomEvent(OPEN_CLOCK_EVENT, { detail: { x: 1 } })));
    expect(el.querySelector(".probe-sheet")?.getAttribute("data-pick")).toBe("null");
  });
});

describe("a clock punch still on the phone (K0.1)", () => {
  it("a queued clock-in is a shift, from its tap, on its job — and the sheet opens on the clock", () => {
    const el = mount(null);
    expect(probe(el).getAttribute("data-shift")).toBe("none");

    act(() => fake.setQueue([queued("clock_in", { projectId: "p1", costCodeId: "cc1", clientId: "c1" }, { id: "x" })]));
    expect(probe(el).getAttribute("data-shift")).toBe("pending:x");
    expect(probe(el).getAttribute("data-pending")).toBe("clock_in");
    expect(probe(el).getAttribute("data-job")).toBe("BLACK22");

    act(() => openClockGlobally());
    const sheet = el.querySelector(".probe-sheet")!;
    expect(sheet.getAttribute("data-shift")).toBe("pending:x");
    expect(sheet.getAttribute("data-pending")).toBe("clock_in");
  });

  it("keeps a relaunched phone on 'loading' until its own queue has been read, so nothing offers a clock-in first", () => {
    fake.setQueue([], false);
    const el = mount(null);
    expect(probe(el).getAttribute("data-loading")).toBe("true");
    act(() => fake.setQueue([queued("clock_in", { projectId: "p1", costCodeId: "cc1", clientId: "c1" }, { id: "x" })], true));
    expect(probe(el).getAttribute("data-loading")).toBe("false");
    expect(probe(el).getAttribute("data-shift")).toBe("pending:x");
  });

  it("hands over to the server's row the instant the punch is confirmed, with no 'off the clock' in between", () => {
    const el = mount(null);
    const entry = queued("clock_in", { projectId: "p1", costCodeId: "cc1", clientId: "c1" }, { id: "x" });
    act(() => fake.setQueue([entry]));
    expect(probe(el).getAttribute("data-shift")).toBe("pending:x");

    // The drain: the server answers with the row, THEN the entry leaves the queue.
    const row = serverShift({ id: "shift-1", client_id: "c1", clock_in_at: TAP, projects: null });
    act(() => fake.confirm(entry, row));
    act(() => fake.setQueue([]));
    act(() => fake.synced());

    expect(probe(el).getAttribute("data-shift")).toBe("shift-1");
    expect(probe(el).getAttribute("data-pending")).toBe("none");
    expect(qc!.getQueryData(["openShift", "me"])).toMatchObject({ id: "shift-1" });
    // Never a moment of "none" between the phone's copy and the server's.
    const after = rendered.slice(rendered.indexOf("pending:x"));
    expect(after).not.toContain("none");
  });

  it("a confirmed clock-out leaves the person off the clock, and a confirmed break end is the row the server sent", () => {
    const el = mount(serverShift());
    const out = queued("clock_out", { shiftRef: "s1", clientId: "c2" }, { id: "o" });
    act(() => fake.setQueue([out]));
    expect(probe(el).getAttribute("data-shift")).toBe("none");
    expect(probe(el).getAttribute("data-pending")).toBe("clock_out");

    act(() => fake.confirm(out, serverShift({ clock_out_at: "2026-09-23T22:00:00.000Z", status: "submitted" })));
    act(() => fake.setQueue([]));
    expect(probe(el).getAttribute("data-shift")).toBe("none");
    expect(qc!.getQueryData(["openShift", "me"])).toBeNull();
  });

  it("a refused clock-in is named, and the clock is honestly off", () => {
    const el = mount(null);
    act(() =>
      fake.setQueue([
        queued("clock_in", { projectId: "p1", costCodeId: "cc1", clientId: "c1" }, { id: "x", status: "failed", lastError: "Sign today's talk first." }),
      ]),
    );
    expect(probe(el).getAttribute("data-shift")).toBe("none");
    expect(probe(el).getAttribute("data-pending")).toBe("none");
    expect(probe(el).getAttribute("data-refused")).toBe("1");
  });

  it("a queued break shows the person on break on the server's own shift", () => {
    const el = mount(serverShift());
    act(() => fake.setQueue([queued("break_start", { shiftRef: "s1", breakType: "lunch", clientId: "c3" }, { id: "b" })]));
    expect(probe(el).getAttribute("data-shift")).toBe("s1");
    expect(probe(el).getAttribute("data-pending")).toBe("break_start");
    act(() => openClockGlobally());
    expect(el.querySelector(".probe-sheet")?.getAttribute("data-pending")).toBe("break_start");
  });
});
