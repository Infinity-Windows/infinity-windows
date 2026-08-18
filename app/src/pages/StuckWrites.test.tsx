// @vitest-environment happy-dom
//
// The stuck-writes screen, read the way a person reads it.
//
// "Try again" replays a dead-lettered write exactly as it was written. The
// screen used to print a bare timestamp — "8/14/2026, 4:12 PM" — and left the
// person to work out in their head, standing in a warehouse, that the set-
// aside they are about to re-send was decided three days ago. Age is the one
// fact that changes the answer, so it has to be on the row, in words.
//
// This mounts the real page and reads the real DOM rather than unit-testing
// the label function alone: a formatter the screen never calls would pass a
// unit test and still leave a foreman with a timestamp.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxEntry } from "../lib/offline/outbox-core";
import type { InstallOutboxRecord } from "../lib/install/installOutbox";

// Both queues are held still. This test is about what the screen SAYS about
// a stuck write, not about IndexedDB — and mocking the modules keeps the real
// ones (and their Supabase client) out of the test entirely.
let failedWrites: OutboxEntry[] = [];
let failedInstalls: InstallOutboxRecord[] = [];

vi.mock("../lib/offline/outbox", () => ({
  listFailed: async () => failedWrites,
  retryFailed: async () => {},
  discardFailed: async () => {},
  subscribe: () => () => {},
}));

vi.mock("../lib/install/installOutbox", () => ({
  listFailedInstalls: async () => failedInstalls,
  retryFailedInstall: async () => {},
  discardFailedInstall: async () => {},
  subscribeSyncListeners: () => () => {},
}));

const { StuckWrites, queuedAgoLabel } = await import("./StuckWrites");

const DAY = 24 * 60 * 60 * 1000;

function stuckWrite(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: "w-1",
    op: "stage_packages",
    payload: {},
    createdAt: Date.now() - 3 * DAY,
    attemptCount: 8,
    lastError: "Failed to fetch",
    status: "failed",
    nextAttemptAt: 0,
    dependsOn: null,
    hasBlob: false,
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  failedWrites = [];
  failedInstalls = [];
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** Mount the real page and return its live DOM node. */
async function mount(): Promise<HTMLElement> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/stuck"]}>
          <StuckWrites />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // Both lists come back from a promise; let them land before reading the DOM.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

describe("the age wording itself", () => {
  const now = 1_800_000_000_000;

  it("says 'just now' rather than '0 min ago'", () => {
    expect(queuedAgoLabel(now - 20_000, now)).toBe("Queued just now");
  });

  it("never counts backwards when a phone's clock is behind the server's", () => {
    expect(queuedAgoLabel(now + 60_000, now)).toBe("Queued just now");
  });
});

describe("how old a stuck write is", () => {
  it("says how long a set-aside has been waiting, not just when it was made", async () => {
    failedWrites = [stuckWrite({ createdAt: Date.now() - 3 * DAY })];
    const el = await mount();
    expect(el.textContent).toContain("Packages set aside");
    expect(el.textContent).toContain("Queued 3 days ago");
  });

  it("counts one day as a day, not as days", async () => {
    failedWrites = [stuckWrite({ createdAt: Date.now() - 26 * 60 * 60 * 1000 })];
    const el = await mount();
    expect(el.textContent).toContain("Queued 1 day ago");
  });

  it("drops to hours and minutes for a fresh one", async () => {
    failedWrites = [
      stuckWrite({ id: "w-1", createdAt: Date.now() - 3 * 60 * 60 * 1000 }),
      stuckWrite({ id: "w-2", op: "clock_in", createdAt: Date.now() - 7 * 60_000 }),
    ];
    const el = await mount();
    expect(el.textContent).toContain("Queued 3 hr ago");
    expect(el.textContent).toContain("Queued 7 min ago");
  });

  it("keeps the exact time beside the age, for a payroll argument", async () => {
    const when = Date.now() - 2 * DAY;
    failedWrites = [stuckWrite({ op: "clock_in", createdAt: when })];
    const el = await mount();
    expect(el.textContent).toContain(new Date(when).toLocaleString());
  });

  // A queued install carries its time as TEXT, and the page turns it into a
  // number with `Date.parse(...) || 0` — so an unreadable stamp becomes 0, and
  // printing 0 as a date gives a confident "1/1/1970".
  //
  // Honest about what this covers: the real store cannot hand the page that
  // today. `enqueue` always stamps an ISO time, and `deserializeInstallOutbox`
  // fills a missing one in with `new Date().toISOString()`, so every record
  // that reaches this screen carries a readable stamp. The record below is
  // hand-built to reach the branch. It is a guard on the page's own
  // arithmetic, not a bug anyone has seen in the field.
  it("admits when an install has no time on it instead of claiming 1970", async () => {
    failedInstalls = [
      {
        id: "i-1",
        payload: { openingCode: "W1", createdAt: "" },
        step: "queued",
        installEventId: null,
        attemptCount: 8,
        lastError: "Failed to fetch",
        status: "failed",
      } as unknown as InstallOutboxRecord,
    ];
    const el = await mount();
    expect(el.textContent).toContain("Window W1 finished");
    expect(el.textContent).toContain("Queued — no time recorded");
    expect(el.textContent).not.toContain("1970");
  });

  // The screen reports the age; it does not refuse the write. Whether an old
  // write still matches the world is the server's call, where the world is.
  it("still offers Try again on an old write, and warns instead of blocking", async () => {
    failedWrites = [stuckWrite({ createdAt: Date.now() - 9 * DAY })];
    const el = await mount();
    const buttons = [...el.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toContain("Try again");
    expect(el.textContent).toContain(
      "Try again sends a write exactly as it was written",
    );
  });
});
