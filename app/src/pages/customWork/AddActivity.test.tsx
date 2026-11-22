// @vitest-environment happy-dom
//
// Add an activity (2026-11-21): a foreman gives a person, a job, an activity
// and an in and out time; unit work also takes units, each finished or not.
// The form sends one save_crew_activity request, after making the work record
// of any unit nobody has worked yet.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../../lib/install/types";
import type { WorkSession, WorkUnit } from "../../lib/customWork/model";
import type { WorkStore } from "../../lib/customWork/useWork";

vi.mock("../../lib/modelstudio/units", () => ({ listStudioUnits: async () => [] }));
vi.mock("../../lib/install/api", () => ({
  listMarkSpecs: async () => [],
  listOpenings: async () => [
    { id: "o-1", project_id: "job-1", opening_code: "1-1" },
    { id: "o-2", project_id: "job-1", opening_code: "1-2" },
  ],
}));
vi.mock("../../components/JobSearchSelect", () => ({ JobSearchSelect: () => null }));

const { AddActivity } = await import("./AddActivity");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

type Sent = { action: string; data: Record<string, unknown> }[];
const knownUnit = { id: "unit-1", project_id: "job-1", opening_id: "o-1", label: "1-1", type_label: "Window", facts: {}, revision: 1 } as unknown as WorkUnit;

async function mount(sent: Sent[], existing?: WorkSession) {
  const work = { user: "foreman-1", units: [knownUnit], sessions: [], commandMany: async (list: Sent) => { sent.push(list); } } as unknown as WorkStore;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AddActivity work={work} jobs={[]} job="job-1" existing={existing} onClose={() => {}}
        people={[{ id: "p-1", display_name: "Alice" } as Profile]} />
    </QueryClientProvider>);
  });
}
const field = (label: string) => [...host!.querySelectorAll("label")].find(node => node.textContent?.trim().startsWith(label))!
  .querySelector<HTMLInputElement | HTMLSelectElement>("input, select")!;
async function set(label: string, value: string) {
  const input = field(label);
  await act(async () => {
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const press = async (label: string) => {
  await act(async () => { host!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(); });
};
const save = async () => {
  await act(async () => { [...host!.querySelectorAll("button")].at(-1)!.click(); });
  await act(async () => { await Promise.resolve(); });
};

describe("AddActivity", () => {
  it("adds job work with no unit as one request", async () => {
    const sent: Sent[] = [];
    await mount(sent);
    await set("Person", "p-1");
    await set("Activity", "Setup");
    await set("In", "2026-11-20T08:00");
    await set("Out", "2026-11-20T09:00");
    expect(host!.querySelector(".cw-add-units")).toBeNull();
    await save();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);
    expect(sent[0][0].action).toBe("crew_activity");
    expect(sent[0][0].data).toMatchObject({ profile_id: "p-1", project_id: "job-1", activity: "Setup", units: [],
      started_at: new Date("2026-11-20T08:00").toISOString(), ended_at: new Date("2026-11-20T09:00").toISOString() });
  });

  it("sends each unit with its finished mark, making the record of a unit nobody has worked", async () => {
    const sent: Sent[] = [];
    await mount(sent);
    await set("Person", "p-1");
    await set("Activity", "Flashing");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    await press("Add unit 1-1");
    await press("Add unit 1-2");
    await press("1-2: finished"); // 1-2 was not finished
    await save();
    expect(sent[0].map(command => command.action)).toEqual(["unit", "crew_activity"]);
    expect(sent[0][0].data).toMatchObject({ opening_id: "o-2", project_id: "job-1", label: "1-2" });
    expect(sent[0][1].data.units).toEqual([
      { unit_id: "unit-1", finished: true },
      { unit_id: sent[0][0].data.id, finished: false },
    ]);
  });

  it("refuses unit work with no unit, and sends nothing", async () => {
    const sent: Sent[] = [];
    await mount(sent);
    await set("Person", "p-1");
    await set("Activity", "Flashing");
    await save();
    expect(sent).toHaveLength(0);
    expect(host!.querySelector('[role="alert"]')?.textContent).toBe("Choose at least one unit.");
  });

  it("puts units on an existing activity without asking for a person or times", async () => {
    const sent: Sent[] = [];
    await mount(sent, { id: "s-1", revision: 4, kind: "idle", stage: "Idle time", project_id: "job-1",
      started_at: "2026-11-20T15:00:00Z", ended_at: "2026-11-20T16:00:00Z" } as WorkSession);
    expect([...host!.querySelectorAll("label")].some(node => node.textContent?.trim().startsWith("Person"))).toBe(false);
    await set("Activity", "Sealing");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    await press("Add unit 1-1");
    await save();
    expect(sent[0]).toEqual([{ action: "crew_activity",
      data: { replace_id: "s-1", revision: 4, activity: "Sealing", units: [{ unit_id: "unit-1", finished: true }] } }]);
  });
});
