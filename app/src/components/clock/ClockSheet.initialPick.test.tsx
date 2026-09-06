// @vitest-environment happy-dom
//
// The sheet opened from a refused landing-block punch (2026-09-06) must show
// the job, cost code and note the person already picked — and keep them when
// the schedule / recents priming lands a moment later pointing at a different
// job. Before this, the sheet always primed itself from yesterday, which is
// the "select a project twice" the owner asked to end. Mounted for real and
// read from the DOM, with every query the off-clock sheet touches seeded.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { clockInSpy } = vi.hoisted(() => ({
  clockInSpy: vi.fn(async () => ({}) as unknown),
}));
vi.mock("../../lib/timeclock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/timeclock")>();
  return {
    ...actual,
    clockIn: clockInSpy,
    listRecentJobs: vi.fn(async () => []),
  };
});
vi.mock("../../lib/costCodes", () => ({
  getClockCostCodesForProject: vi.fn(async () => []),
}));
// The pick screen mounts WrongClockBanner, which fetches the server's clock
// from a mount effect. Hold that still (skew 0 → banner renders nothing) so
// the mount never reaches for the network; every query is seeded below.
vi.mock("../../lib/clockSkew", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/clockSkew")>();
  return { ...actual, fetchServerNowMs: vi.fn(async () => Date.now()) };
});

import { ClockSheet } from "./ClockSheet";
import type { ClockInPick } from "../../lib/timeclock";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  clockInSpy.mockClear();
});

const CC1 = { id: "cc1", code: "100", label: "Install", active: true };
const CC2 = { id: "cc2", code: "200", label: "Service call", active: true };
const P1 = { id: "p1", job_code: "BLACK22", name: "Black Desert", address: null, status: "active", allowed_modes: ["data"] };
const P2 = { id: "p2", job_code: "OAK-2", name: "Oakridge", address: null, status: "active", allowed_modes: ["data", "tracking"] };

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function mount(initialPick: ClockInPick | null): HTMLElement {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnMount: false, gcTime: Infinity },
    },
  });
  const today = todayLocalISO();
  qc.setQueryData(["projects"], [P1, P2]);
  for (const scope of ["all", "p1", "p2"]) qc.setQueryData(["clockCostCodes", scope], [CC1, CC2]);
  // Yesterday was BLACK22, and BLACK22 is on today's schedule too — both
  // primings point AWAY from the carried pick.
  qc.setQueryData(["recentJobs", "me"], [
    { projectId: "p1", jobCode: "BLACK22", name: "Black Desert", costCodeId: "cc1", lastClockInAt: new Date().toISOString() },
  ]);
  qc.setQueryData(["mySchedule", "me", today, today], [
    { id: "sched1", project_id: "p1", project: { job_code: "BLACK22", name: "Black Desert" } },
  ]);
  qc.setQueryData(["todayTalk"], null);
  qc.setQueryData(["toolboxToday", "me"], { id: "done1" });
  qc.setQueryData(["myOpenings", "me"], []);

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ClockSheet
            profileId="me"
            shift={null}
            initialPick={initialPick}
            onClose={() => {}}
            onChanged={() => {}}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return host;
}

/** The pick summary — the one `.clock-pick-summary` that names a job in bold. */
function pickSummary(el: HTMLElement): Element | null {
  return (
    Array.from(el.querySelectorAll(".clock-pick-summary")).find((n) => n.querySelector("strong")) ??
    null
  );
}

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("the clock sheet opened with a carried pick", () => {
  it("pre-fills the job, cost code and note, and priming does not overwrite them", async () => {
    const el = mount({ projectId: "p2", costCodeId: "cc2", note: "gate 4411", mode: "tracking" });
    await flush();
    const summary = pickSummary(el)!;
    expect(summary.textContent).toContain("OAK-2");
    expect(summary.textContent).toContain("200 — Service call");
    expect(el.querySelector(".clock-costcode-item.selected")?.textContent).toContain("200");
    expect(el.querySelector<HTMLTextAreaElement>("#clock-note")!.value).toBe("gate 4411");
    // The schedule chip and the recent chip both name BLACK22, and neither is
    // the current one.
    expect(el.querySelector(".clock-chip.current")).toBeNull();
    expect(el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!.disabled).toBe(false);
  });

  it("records the carried mode on the punch", async () => {
    // OAK-2 allows both modes; the block asked, the person said tracking, and
    // the block's punch was refused. The sheet's Start must send that answer,
    // not null (which is what every sheet punch recorded before 2026-09-06).
    const el = mount({ projectId: "p2", costCodeId: "cc2", note: null, mode: "tracking" });
    await flush();
    await act(async () => {
      el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();
    expect(clockInSpy).toHaveBeenCalledTimes(1);
    expect(clockInSpy.mock.calls[0]).toEqual(["p2", "cc2", expect.anything(), null, "tracking"]);
  });

  it("opened bare, records a single-mode job's one mode and nothing for a both-mode job", async () => {
    // Primed from the schedule onto BLACK22 (data only) → "data" rides along.
    const el = mount(null);
    await flush();
    await act(async () => {
      el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();
    expect(clockInSpy.mock.calls[0]).toEqual(["p1", "cc1", expect.anything(), null, "data"]);
    clockInSpy.mockClear();

    // Tap over to OAK-2 (both modes): the sheet has no mode step, so null.
    const chip = Array.from(el.querySelectorAll<HTMLButtonElement>(".clock-list-toggle")).find(
      (b) => b.textContent?.includes("Choose a different job"),
    )!;
    act(() => chip.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const oak = Array.from(el.querySelectorAll<HTMLButtonElement>(".clock-project-item")).find(
      (b) => b.textContent?.includes("OAK-2"),
    )!;
    act(() => oak.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flush();
    await act(async () => {
      el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();
    expect(clockInSpy).toHaveBeenCalledTimes(1);
    expect(clockInSpy.mock.calls[0]).toEqual(["p2", "cc1", expect.anything(), null, null]);
  });

  it("still primes from the schedule when opened bare", async () => {
    const el = mount(null);
    await flush();
    expect(pickSummary(el)?.textContent).toContain("BLACK22");
    expect(el.querySelector(".clock-chip.current")?.textContent).toContain("BLACK22");
  });
});
