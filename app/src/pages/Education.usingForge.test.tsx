// @vitest-environment happy-dom
//
// The one change Learn itself took for "Using Forge": a sixth tab, and the
// page's learning-time clock falling silent while it is open. A walkthrough of
// proposed screens is not study, so a minute there must not land in the
// owner's learning-time table — while every tab that was counted before is
// counted exactly as before.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { clock } = vi.hoisted(() => ({ clock: vi.fn() }));

vi.mock("../lib/useLearningTime", () => ({ useLearningTime: clock }));
vi.mock("../lib/install/api", () => ({
  getMyProfile: vi.fn(async () => ({ id: "me", role: "installer" })),
}));
vi.mock("../lib/learn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/learn")>()),
  listMyProgress: vi.fn(async () => []),
  listPriorityTerms: vi.fn(async () => []),
  getEducationProgress: vi.fn(async () => ({ termsEarned: 0, termsTotal: 0 })),
}));
vi.mock("../components/learn/SendRecordingButton", () => ({ SendRecordingButton: () => null }));
vi.mock("../components/learn/VideoLibrary", () => ({ VideoLibrary: () => <p>lesson library</p> }));
vi.mock("../components/learn/YourLearningTime", () => ({ YourLearningTime: () => <p>learning time explanation</p> }));
vi.mock("../components/learn/UsingForge", () => ({ default: () => <p>walkthrough shelf</p> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { Education } from "./Education";

let root: Root | null = null;
let container: HTMLDivElement;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  clock.mockClear();
});

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function openTab(label: string) {
  const tab = [...container.querySelectorAll(".hub-tab")].find((b) => b.textContent === label);
  expect(tab, `${label} tab`).toBeTruthy();
  clock.mockClear();
  await act(async () => {
    (tab as HTMLElement).click();
  });
  await settle();
}

/** The key the page-level 'tab' clock was last given. */
const tabClock = () => clock.mock.calls.filter(([kind]) => kind === "tab").at(-1)?.[1];

describe("Learn's Using Forge tab", () => {
  it("is a tab inside Learn, loaded on demand, and stops the learning clock", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root!.render(
        <QueryClientProvider client={qc}>
          <MemoryRouter>
            <Education />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await settle();
    expect(tabClock()).toBe("daily");

    await openTab("Using Forge");
    expect(container.textContent).toContain("walkthrough shelf");
    expect(tabClock()).toBeNull();
    expect(container.textContent).not.toContain("learning time explanation");
    // Nor does it borrow either round clock.
    for (const [kind, key] of clock.mock.calls) {
      if (kind !== "tab") expect(key).toBeNull();
    }

    // The lesson library is untouched and still counted.
    await openTab("Videos");
    expect(container.textContent).toContain("lesson library");
    expect(tabClock()).toBe("videos");
    expect(container.textContent).toContain("learning time explanation");
  });
});
