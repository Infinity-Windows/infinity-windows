// @vitest-environment happy-dom
//
// useWork.command: what the tap that sent a request learns from the server.
// A refused request normally stays queued, with its error, for a foreman's
// review and the tap resolves quietly (QueueNotice shows it). The one
// exception is the toolbox signature (20261031000000): a unit or Prep-time
// start turned away because today's talk is not signed wrote nothing and
// must not be resent after signing with the unsigned tap's time — so it is
// dropped from the queue and THROWN to the tap, which says it in words.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendWorkCommand = vi.fn(async (_c: unknown) => "ok");
vi.mock("./api", () => ({
  listWorkUnits: async () => [],
  listWorkSessions: async () => [],
  listWorkTypes: async () => [],
  sendWorkCommand: (c: unknown) => sendWorkCommand(c),
}));
vi.mock("../clockContext", () => ({
  useClock: () => ({ shift: null, profileId: "worker-a", loading: false, isOpen: false, openClock: () => {}, closeClock: () => {}, refresh: () => {} }),
}));

const { useWork } = await import("./useWork");
const { readWorkQueue } = await import("./queue");
type Store = ReturnType<typeof useWork>;

let store: Store | null = null;
function Probe() {
  store = useWork();
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  localStorage.clear();
  sendWorkCommand.mockClear();
  sendWorkCommand.mockResolvedValue("ok");
  vi.stubGlobal("navigator", {
    onLine: true,
    locks: { request: async (_key: string, fn: () => Promise<unknown>) => fn() },
  });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  store = null;
});

async function mount(): Promise<Store> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return store!;
}

const start = { id: "s1", shift_id: "sh1", unit_id: null, stage: "Idle time", description: "Hauling" };

describe("useWork.command", () => {
  it("throws the toolbox-signature refusal to the tap and drops the request — nothing to review", async () => {
    const s = await mount();
    sendWorkCommand.mockRejectedValueOnce({ code: "P0001", message: "Sign today's toolbox talk before starting work." });
    let thrown: unknown = null;
    await act(async () => {
      try {
        await s.command("start", start);
      } catch (e) {
        thrown = e;
      }
    });
    expect(String((thrown as Error)?.message)).toBe("Sign today's toolbox talk before starting work.");
    expect(readWorkQueue("worker-a")).toEqual([]);
    expect(sendWorkCommand).toHaveBeenCalledTimes(1);
  });

  it("keeps any other refusal queued for review and lets the tap resolve, as before", async () => {
    const s = await mount();
    sendWorkCommand.mockRejectedValueOnce(new Error("Your current work changed. Sync and review before retrying."));
    await act(async () => {
      await s.command("start", start);
    });
    const queue = readWorkQueue("worker-a");
    expect(queue).toHaveLength(1);
    expect(queue[0].error).toContain("Your current work changed");
  });

  it("sends and clears an accepted request", async () => {
    const s = await mount();
    await act(async () => {
      await s.command("start", start);
    });
    expect(readWorkQueue("worker-a")).toEqual([]);
    expect(sendWorkCommand).toHaveBeenCalledTimes(1);
  });
});
