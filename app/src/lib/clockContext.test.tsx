// @vitest-environment happy-dom
//
// The open-clock event can carry a pick (2026-09-06). This mounts the real
// provider with the sheet swapped for a probe that prints what it was handed,
// so it fails if the payload stops reaching the sheet, survives a close, or
// a bare open (the nav tab) starts inheriting the last hand-off.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../components/clock/ClockSheet", () => ({
  ClockSheet: (props: { initialPick: unknown; onClose: () => void }) => (
    <div className="probe-sheet" data-pick={JSON.stringify(props.initialPick)}>
      <button type="button" className="probe-close" onClick={props.onClose} />
    </div>
  ),
}));
vi.mock("../components/clock/FarFromJobPrompt", () => ({
  FarFromJobPrompt: () => null,
}));
vi.mock("./timeclock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./timeclock")>();
  return { ...actual, getOpenShift: vi.fn(async () => null) };
});
vi.mock("./offline/outbox", () => ({ subscribeSynced: () => () => {} }));

import { ClockProvider, OPEN_CLOCK_EVENT, openClockGlobally } from "./clockContext";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(): HTMLElement {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  qc.setQueryData(["myProfile"], { id: "me", role: "installer" });
  qc.setQueryData(["openShift", "me"], null);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <ClockProvider>
          <span />
        </ClockProvider>
      </QueryClientProvider>,
    );
  });
  return host;
}

const PICK = { projectId: "p2", costCodeId: "cc2", note: "gate 4411", mode: "tracking" as const };

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
