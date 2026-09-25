// @vitest-environment happy-dom
//
// Group sign-in stays online-only in the first version of offline toolbox
// signing (2026-09-25). The roster's Clock in files every person's punch AND
// the supervisor's attestation that the talk was given, on the server, in one
// go — nothing about it is queued. With no signal the supervisor is told so
// in plain words, and pointed at the thing that does work offline: each
// person signing on their own phone. Never a network error, never a silent
// dead button.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { clockInCrewSpy } = vi.hoisted(() => ({ clockInCrewSpy: vi.fn() }));
vi.mock("../../lib/timeclock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/timeclock")>();
  return { ...actual, clockInCrew: clockInCrewSpy, clockOutCrew: vi.fn() };
});
vi.mock("../../lib/costCodes", () => ({
  getClockCostCodesForProject: vi.fn(async () => [{ id: "cc1", code: "100", label: "Install", active: true }]),
}));
vi.mock("../../lib/permissions/pushServer", () => ({ sendPush: vi.fn() }));

import { CrewClockBar } from "./CrewClockBar";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  clockInCrewSpy.mockReset();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

const PROJECT = {
  id: "p1",
  job_code: "BLACK22",
  name: "Black Desert",
  address: null,
  status: "active",
  allowed_modes: ["data"],
} as unknown as import("../../lib/types").Project;

function mount(): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(["myProfile"], { id: "boss", role: "supervisor", display_name: "Sam" });
  qc.setQueryData(["clockCostCodes", "p1"], [{ id: "cc1", code: "100", label: "Install", active: true }]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <CrewClockBar
          members={[{ id: "a", name: "Ana", onClock: false, openProjectId: null }]}
          selected={["a"]}
          projects={[PROJECT]}
          onDone={() => {}}
        />
      </QueryClientProvider>,
    );
  });
  return host;
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const b = Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`no "${text}" button in: ${el.textContent}`);
  return b;
}

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function readyToClockIn(el: HTMLElement) {
  act(() => button(el, "Clock in…").dispatchEvent(new MouseEvent("click", { bubbles: true })));
  choose(el.querySelector<HTMLSelectElement>("#crewclock-job")!, "p1");
  await act(async () => {
    await Promise.resolve();
  });
  choose(el.querySelector<HTMLSelectElement>("#crewclock-code")!, "cc1");
  const attest = Array.from(el.querySelectorAll<HTMLInputElement>("input[type=checkbox]")).find((c) =>
    c.closest("label")?.textContent?.includes("I gave today's toolbox talk"),
  )!;
  act(() => attest.click());
}

describe("the roster's group sign-in with no signal", () => {
  it("says it needs signal, and that each person can sign on their own phone — and sends nothing", async () => {
    const el = mount();
    await readyToClockIn(el);
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    await act(async () => {
      button(el, "Clock them in").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(clockInCrewSpy).not.toHaveBeenCalled();
    const line = el.querySelector("[data-testid=crewclock-offline]");
    expect(line?.textContent).toContain("Group sign-in needs signal");
    expect(line?.textContent).toContain("on their own phone");
  });

  it("says the same when the signal drops on the way", async () => {
    clockInCrewSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const el = mount();
    await readyToClockIn(el);
    await act(async () => {
      button(el, "Clock them in").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(clockInCrewSpy).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain("Group sign-in needs signal");
    expect(el.textContent).not.toContain("Failed to fetch");
  });
});
