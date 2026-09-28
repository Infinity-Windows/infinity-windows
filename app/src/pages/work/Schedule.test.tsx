// @vitest-environment happy-dom
//
// The Schedule tab (K1.6): a week on opening, more on demand, and never
// "no work" for a phone that merely has no signal.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ME = "00000000-0000-4000-8000-0000000000e2";
let online = true;
let rows: unknown[] = [];
let fail = false;
let role = "installer";
const listMyPublished = vi.fn(async (_id: string, _from: string, _to: string) => {
  if (fail) throw new Error("no signal");
  return rows;
});
const listAssignments = vi.fn(async () => rows);

vi.mock("../../lib/install/api", () => ({
  getMyProfile: async () => ({ id: ME, display_name: "E2E", role, active: true }),
}));
vi.mock("../../lib/schedule/api", () => ({
  listMyPublished: (...a: [string, string, string]) => listMyPublished(...a),
  listAssignments: () => listAssignments(),
}));
vi.mock("../../lib/vehicles/api", () => ({ listVehicleLinksForAssignments: async () => [] }));
vi.mock("../../lib/offline/useWeakSignal", () => ({ useConnection: () => ({ online, weak: false }) }));
vi.mock("../../lib/useEffectiveRole", () => ({
  useEffectiveRole: () => ({ realRole: role, effectiveRole: role, isPreviewing: false, isLoading: false, grants: {} }),
}));

const { Schedule } = await import("./Schedule");

const today = new Date();
const iso = (offset: number) => {
  const d = new Date(today);
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const row = (id: string, day: number, over: Record<string, unknown> = {}) => ({
  id,
  project_id: "job-1",
  kind: "install",
  delivery_id: null,
  start_date: iso(day),
  end_date: iso(day),
  start_time: "07:00",
  end_time: null,
  status: "published",
  color: null,
  note: null,
  created_by: null,
  published_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  members: [{ profile_id: ME, role: "installer", display_name: "E2E" }],
  project: { id: "job-1", job_code: "OAKRIDGE", name: "Oakridge Apartments", address: "1 Main St" },
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let qc: QueryClient;
beforeEach(() => {
  online = true;
  rows = [];
  fail = false;
  role = "installer";
  listMyPublished.mockClear();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Schedule />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
  return host;
}
const $ = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("Schedule tab (K1.6)", () => {
  it("opens on today + 7 days and Show more reaches further with no limit", async () => {
    rows = [row("a", 0), row("b", 3), row("c", 20)];
    const el = await mount();
    const firstCall = listMyPublished.mock.calls[0];
    expect(firstCall[1]).toBe(iso(0));
    expect(firstCall[2]).toBe(iso(7));
    // Today's entry carries Start work.
    expect($(el, "schedule-start-work")).not.toBeNull();
    await act(async () => $(el, "schedule-more")!.click());
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
    const last = listMyPublished.mock.calls.at(-1)!;
    expect(last[2]).toBe(iso(21));
    expect(el.querySelectorAll('[data-testid="schedule-entry"]').length).toBe(3);
    // And again — nothing caps it.
    await act(async () => $(el, "schedule-more")!.click());
    for (let i = 0; i < 2; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(listMyPublished.mock.calls.at(-1)![2]).toBe(iso(35));
  });

  it("offline with a saved copy: shows the copy and says when it is from — never 'no work'", async () => {
    rows = [row("a", 1)];
    const el = await mount();
    expect(el.querySelectorAll('[data-testid="schedule-entry"]').length).toBe(1);
    online = false;
    // A re-render with the connection gone: same data, honest line above it.
    await act(async () => root!.render(
      <QueryClientProvider client={qc}><MemoryRouter><Schedule /></MemoryRouter></QueryClientProvider>,
    ));
    expect($(el, "schedule-saved")!.textContent).toMatch(/Showing your schedule from .* — can't reach Forge/);
    expect(el.querySelectorAll('[data-testid="schedule-entry"]').length).toBe(1);
    expect($(el, "schedule-empty")).toBeNull();
  });

  it("a failed load with nothing saved says it cannot reach Forge — never 'nothing scheduled'", async () => {
    fail = true;
    const el = await mount();
    expect($(el, "schedule-unreachable")!.textContent).toContain("Can't reach Forge");
    expect($(el, "schedule-empty")).toBeNull();
    expect(el.textContent).not.toMatch(/Nothing published/);
  });

  it("online and genuinely empty says so, with the window it looked at", async () => {
    const el = await mount();
    expect($(el, "schedule-empty")!.textContent).toMatch(/Nothing published through/);
  });

  it("gives a foreman a view-only Crew switch that reads everyone's published rows", async () => {
    role = "foreman";
    rows = [row("a", 0, { members: [{ profile_id: "someone", role: "installer", display_name: "Sam" }] })];
    const el = await mount();
    expect($(el, "schedule-crew")).not.toBeNull();
    await act(async () => $(el, "schedule-crew")!.click());
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(listAssignments).toHaveBeenCalled();
    expect(el.textContent).toContain("With Sam");
    expect(el.textContent).toContain("edit in Scheduling");
    // View only: no Start work on someone else's day.
    expect($(el, "schedule-start-work")).toBeNull();
  });

  it("an installer gets no Crew switch", async () => {
    const el = await mount();
    expect($(el, "schedule-crew")).toBeNull();
  });
});
