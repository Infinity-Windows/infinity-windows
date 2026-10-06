// @vitest-environment happy-dom
// Recovery must remain visible when a refused punch no longer has a shift.
// These are presentation fixtures, not native paid-clock or RLS evidence.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { QueuedClockAction, RefusedClockAction } from "../../lib/clockQueueView";

const state = vi.hoisted(() => ({
  profileId: "practice-person" as string | null,
  shift: null as { id: string } | null,
  loading: false,
  restoring: false,
  pending: null as QueuedClockAction | null,
  refused: [] as RefusedClockAction[],
}));
vi.mock("../../lib/clockContext", () => ({ useClock: () => state }));
vi.mock("@tanstack/react-query", () => ({
  useIsRestoring: () => state.restoring,
  useQuery: () => ({ isError: false }),
  skipToken: Symbol("no-new-read"),
}));
vi.mock("../../lib/useToolboxGate", () => ({
  todayTalkKey: (day: string) => ["todayTalk", day],
  useLocalDay: () => "2026-10-06",
  useTodayTalk: () => ({ isSuccess: true, data: null }),
  useToolboxToday: () => ({ isSuccess: true, data: null }),
}));
vi.mock("../../pages/work/WorkScreen", () => ({ WorkScreen: () => <div data-testid="existing-shift">Existing work</div> }));
const { WorkshopWorkEntry } = await import("./WorkshopWorkEntry");
let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(state, { profileId: "practice-person", shift: null, loading: false, restoring: false, pending: null, refused: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root?.unmount()); host.remove(); });
async function mount() { await act(async () => root!.render(<MemoryRouter><WorkshopWorkEntry /></MemoryRouter>)); }

it("keeps the new paid start unavailable until its actual driver is connected", async () => {
  await mount();
  expect(host.querySelector<HTMLButtonElement>(".wk-start-clockin")?.disabled).toBe(true);
  expect(host.textContent).toContain("Nothing is recorded from this button yet");
  expect(host.querySelector('[data-testid="existing-shift"]')).toBeNull();
});

it("does not call a clock known while restoring or before the profile arrives", async () => {
  state.restoring = true;
  await mount();
  expect(host.textContent).toContain("Checking your clock");
  state.restoring = false;
  state.profileId = null;
  await mount();
  expect(host.textContent).toContain("Checking your clock");
});

it("shows a refusal and the recovery link even when the shift is null", async () => {
  state.refused = [{ entryId: "refused-practice", kind: "clock_in", tappedAt: "2026-10-06T13:00:00Z", reason: "Practice refusal" }];
  await mount();
  expect(host.textContent).toContain("Practice refusal");
  expect(host.querySelector('.clock-queue a')?.getAttribute("href")).toBe("/stuck");
  expect(host.querySelector<HTMLButtonElement>(".wk-start-clockin")?.disabled).toBe(true);
});

it("preserves an existing shift and its queued-change status", async () => {
  state.shift = { id: "saved-practice-shift" };
  state.pending = { entryId: "pending-practice", kind: "break_start", tappedAt: "2026-10-06T13:00:00Z", sending: false };
  await mount();
  expect(host.querySelector('[data-testid="existing-shift"]')).not.toBeNull();
  expect(host.querySelector('.clock-queue-line[data-kind="break_start"]')).not.toBeNull();
  expect(host.querySelector('.wk-start-clockin')).toBeNull();
});
