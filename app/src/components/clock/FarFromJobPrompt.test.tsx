// @vitest-environment happy-dom
//
// The far-from-job prompt asks one question of the one phone in the company
// most likely to have no signal: somebody who has just driven away from a job.
// So the two things worth proving here are not about the wording — they are
// that the answer SURVIVES bad signal.
//
//   1. The Travel cost code is read from the cache the clock already loaded,
//      never from a fresh network read at tap time. A read that throws before
//      clockIn is even attempted loses the whole one-tap answer.
//   2. A clockIn that fails on the network goes to the offline outbox, exactly
//      the way every other punch in this app does, and the person is told it is
//      queued rather than shown an error.
//
// Mounted for real rather than source-scanned: the defect this covers was a
// missing try/catch, and only running the mutation can see it.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../../lib/i18n";
import { subscribeToasts, type Toast } from "../../lib/toast";
import { FarFromJobPrompt } from "./FarFromJobPrompt";
import type { TimeShift } from "../../lib/timeclock";

// A job in Salt Lake and a supply house ~14 miles north — the same geometry the
// pure tests in lib/farFromJob.test.ts use.
const JOB = { lat: 40.76, lng: -111.89 };
const AWAY = { lat: 40.96, lng: -111.89, accuracyM: 20 };

const TRAVEL = { id: "cc-travel", code: "900", label: "Travel", active: true };

const clockIn = vi.fn();
const getTravelCostCode = vi.fn(async () => TRAVEL);
const touchShiftLocation = vi.fn(async () => {});
const enqueueClockIn = vi.fn(async () => "entry-1");

vi.mock("../../lib/geo", () => ({
  captureGeoIfGranted: vi.fn(async () => AWAY),
  // {} is what captureGeoSoft gives when the phone has nothing to say, which is
  // the honest state for a punch made with no signal.
  captureGeoSoft: vi.fn(async () => ({})),
}));

vi.mock("../../lib/timeclock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/timeclock")>();
  return {
    ...actual,
    clockIn: (...args: unknown[]) => clockIn(...args),
    getTravelCostCode: () => getTravelCostCode(),
    getJobLastGeo: vi.fn(async () => JOB),
    listCostCodes: vi.fn(async () => [TRAVEL]),
    touchShiftLocation: (...args: unknown[]) => touchShiftLocation(...args),
  };
});

vi.mock("../../lib/offline/outbox", () => ({
  enqueueClockIn: (...args: unknown[]) => enqueueClockIn(...args),
  pendingRefForShift: (id: string) => `pending:${id}`,
}));

function openShift(): TimeShift {
  return {
    id: "shift-1",
    profile_id: "me",
    project_id: "p1",
    cost_code_id: "cc-install",
    clock_in_at: new Date(Date.now() - 3600_000).toISOString(),
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    break_type: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: new Date().toISOString(),
    note: "framing the back elevation",
    projects: { job_code: "MADMOOSE", name: "Mad Moose" },
    cost_codes: { code: "100", label: "Install" },
  };
}

describe("the far-from-job switch survives no signal", () => {
  let container: HTMLElement;
  let root: Root;
  let qc: QueryClient;
  let seen: Toast[] = [];
  let unsubscribe: () => void;
  /** The toast bus is module-global and toasts live 4.5s, so ignore leftovers. */
  let sinceId = 0;
  const mine = () =>
    seen.filter((x) => x.id > sinceId).map((x) => `${x.kind}:${x.message}`);

  beforeEach(() => {
    clockIn.mockReset();
    getTravelCostCode.mockClear();
    enqueueClockIn.mockClear();
    seen = [];
    unsubscribe = subscribeToasts((list) => {
      seen = list;
    });
    sinceId = seen.reduce((max, x) => Math.max(max, x.id), 0);
  });

  afterEach(() => {
    unsubscribe();
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  /** Mount and let the foreground check run, so the sheet is on screen. */
  async function mountAndAsk() {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    qc.setQueryData(["myRealProfile"], {
      id: "me",
      language: "en",
      role: "installer",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <LanguageProvider>
            <FarFromJobPrompt shift={openShift()} onChanged={() => {}} />
          </LanguageProvider>
        </QueryClientProvider>,
      );
    });
    // The check is async (a fix, then the job's reference point); let it land.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function switchButton(): HTMLButtonElement {
    const btn = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Switch to Travel"),
    );
    if (!btn) throw new Error(`no Switch button in: ${container.textContent}`);
    return btn as HTMLButtonElement;
  }

  it("asks the question when the phone is miles from the job", async () => {
    clockIn.mockResolvedValue({});
    await mountAndAsk();
    expect(container.textContent).toContain("14 miles from Mad Moose");
  });

  it("takes the Travel code from the cache, without a fresh read at tap time", async () => {
    clockIn.mockResolvedValue({});
    await mountAndAsk();
    await act(async () => {
      switchButton().click();
      await Promise.resolve();
    });
    // The list query already holds it, so nothing has to go to the network for
    // a code the app has known all day.
    expect(getTravelCostCode).not.toHaveBeenCalled();
    // The fix the check already ran on is reused when a fresh one is not
    // available, so the punch still lands with real coordinates.
    expect(clockIn).toHaveBeenCalledWith(
      "p1",
      "cc-travel",
      AWAY,
      "framing the back elevation",
      null,
    );
  });

  it("queues the switch when the punch fails on the network", async () => {
    // A fetch failure is a TypeError, which is what a dead connection produces.
    clockIn.mockRejectedValue(new TypeError("Failed to fetch"));
    await mountAndAsk();
    await act(async () => {
      switchButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(enqueueClockIn).toHaveBeenCalledWith({
      projectId: "p1",
      costCodeId: "cc-travel",
      lat: AWAY.lat,
      lng: AWAY.lng,
      note: "framing the back elevation",
    });
    // Told it is saved, not told it failed.
    expect(mine()).toEqual([
      "success:Switch saved — we'll sync it when you're back online",
    ]);
    // And the clock reads Travel immediately, rather than sitting on the job it
    // is no longer charging.
    const cached = qc.getQueryData<TimeShift>(["openShift", "me"]);
    expect(cached?.cost_code_id).toBe("cc-travel");
    expect(cached?.cost_codes?.code).toBe("900");
    expect(cached?.id).toBe("pending:entry-1");
  });

  it("keeps the question on screen when the server refuses for a real reason", async () => {
    // Not a network failure: a rejection the person needs to see, and the sheet
    // must not swallow the question along with it.
    clockIn.mockRejectedValue(
      Object.assign(new Error("that punch overlaps another"), { code: "P0001" }),
    );
    await mountAndAsk();
    await act(async () => {
      switchButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(enqueueClockIn).not.toHaveBeenCalled();
    expect(mine().some((x) => x.startsWith("error:"))).toBe(true);
    expect(container.textContent).toContain("Switch to Travel");
  });
});
