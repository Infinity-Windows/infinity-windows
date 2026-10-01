// @vitest-environment happy-dom
//
// Foreman unit contributors (2026-09-30): the compact action below the lead
// row. A foreman picks an existing unit, people and a stage/date and saves
// through the narrow record_stage_contributors queue action; an installer
// opening the same panel sees the read-only summary and no write controls.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkUnit } from "../../lib/customWork/model";
import type { WorkStore } from "../../lib/customWork/useWork";

vi.mock("../../lib/api", () => ({
  listProjectsAnyStatus: async () => [{ id: "job-1", job_code: "A", name: "Job A", address: null, status: "active" }],
}));
vi.mock("../../lib/install/api", () => ({ listOpenings: async () => [] }));
const summaryMock = vi.fn(async (_unitId: string) => [] as { stage: string; work_date: string; profile_id: string; digest: string }[]);
vi.mock("../../lib/customWork/api", () => ({
  listCrewRecordPeople: async () => [
    { id: "p-1", display_name: "Alice Installer", active: true, role: "installer", is_partner: false },
    { id: "p-2", display_name: "Bob Installer", active: true, role: "installer", is_partner: false },
  ],
  getStageContributorSummary: (unitId: string) => summaryMock(unitId),
  listUnitCrewWorkRecords: async () => [],
  listWorkHistory: async () => [],
}));

const { UnitContributors } = await import("./UnitContributors");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let client: QueryClient;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  summaryMock.mockReset();
  summaryMock.mockResolvedValue([]);
  client?.clear();
});

const unit: WorkUnit = {
  id: "unit-1",
  project_id: "job-1",
  opening_id: null,
  created_by: "foreman-1",
  label: "16",
  type_label: "Bifold door",
  facts: {},
  revision: 1,
  created_at: "2026-09-20T00:00:00Z",
  updated_at: "2026-09-20T00:00:00Z",
};

function fakeWork(command: (action: string, data: Record<string, unknown>) => Promise<void>): WorkStore {
  return {
    clock: {} as WorkStore["clock"],
    user: "foreman-1",
    units: [unit],
    sessions: [],
    types: [],
    queue: [],
    queueError: "",
    command: command as unknown as WorkStore["command"],
    commandMany: vi.fn(),
    refresh: vi.fn(),
    sync: vi.fn(),
    actionsLoading: false,
    loading: false,
    error: null,
    active: null,
  };
}

function render(work: WorkStore, canRecord: boolean) {
  const qc = client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={qc}>
      <UnitContributors work={work} jobId="job-1" canRecord={canRecord} />
    </QueryClientProvider>
  );
  if (!root) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => root!.render(tree));
  return host!;
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function click(el: Element | null) {
  (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function setValue(el: HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

describe("UnitContributors — the compact Work action", () => {
  it("the current job is only a default, so retrospective work can be filed for another job", async () => {
    const el = render(fakeWork(vi.fn(async () => {})), true);
    await act(async () => click(el.querySelector('[data-testid="ws-contrib-open"]')));
    await settle();
    const jobs = el.querySelector<HTMLSelectElement>("#ws-contrib-job")!;
    expect(jobs.disabled).toBe(false);
    expect(jobs.value).toBe("job-1");
    expect([...jobs.options].map((option) => option.text)).toContain("A · Job A");
  });

  it("an unavailable server summary is shown as unavailable and cannot accept writes", async () => {
    summaryMock.mockRejectedValue({ code: "PGRST202", message: "function does not exist" });
    const command = vi.fn(async () => {});
    const el = render(fakeWork(command), true);
    await act(async () => click(el.querySelector('[data-testid="ws-contrib-open"]')));
    await settle();
    await act(async () => setValue(el.querySelector<HTMLSelectElement>("#ws-contrib-unit")!, "unit-1"));
    await settle();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("not available yet");
    expect(el.textContent).not.toContain("Nobody is credited");
    const save = [...el.querySelectorAll("button")].find((b) => b.textContent === "Save contributors")!;
    expect(save.disabled).toBe(true);
    expect(command).not.toHaveBeenCalled();
  });

  it("pending requests are scoped to this account, unit, stage and date, including corrections", async () => {
    const work = fakeWork(vi.fn(async () => {}));
    const data = { unit_id: "unit-1", stage: "RO checked", work_date: "2026-09-29" };
    work.queue = [
      { id: "own", userId: work.user!, action: "correct_stage_contributors", data },
      { id: "other-unit", userId: work.user!, action: "stage_contributors", data: { ...data, unit_id: "unit-2" } },
      { id: "other-account", userId: "another-account", action: "stage_contributors", data },
    ];
    const el = render(work, true);
    await act(async () => click(el.querySelector('[data-testid="ws-contrib-open"]')));
    await settle();
    await act(async () => setValue(el.querySelector<HTMLSelectElement>("#ws-contrib-unit")!, "unit-1"));
    await act(async () => setValue(el.querySelector<HTMLInputElement>("#ws-contrib-date")!, "2026-09-29"));
    await settle();
    expect(el.querySelector('aside[aria-label="Pending contributor records"]')?.textContent).toContain("1 saved on this device");
  });

  it("a foreman records two people against an existing unit, no timer/completion inputs anywhere in the form", async () => {
    const command = vi.fn(async () => {});
    const el = render(fakeWork(command), true);
    await act(async () => click(el.querySelector('[data-testid="ws-contrib-open"]')));
    await settle();

    const unitSelect = el.querySelector<HTMLSelectElement>("#ws-contrib-unit")!;
    await act(async () => setValue(unitSelect, "unit-1"));
    await settle();

    // Stage is a chip, not a free timer/select of running state.
    const stageChip = [...el.querySelectorAll("button")].find((b) => b.textContent === "Flashing")!;
    await act(async () => click(stageChip));

    const dateInput = el.querySelector<HTMLInputElement>("#ws-contrib-date")!;
    await act(async () => setValue(dateInput, "2026-09-29"));

    for (const name of ["Alice Installer", "Bob Installer"]) {
      const chip = [...el.querySelectorAll("button")].find((b) => b.textContent === name)!;
      await act(async () => click(chip));
    }

    const save = [...el.querySelectorAll("button")].find((b) => b.textContent === "Save contributors")!;
    expect(save.hasAttribute("disabled")).toBe(false);
    await act(async () => click(save));

    expect(command).toHaveBeenCalledWith("stage_contributors", {
      unit_id: "unit-1",
      stage: "Flashing",
      work_date: "2026-09-29",
      outcome: "finished",
      people: ["p-1", "p-2"],
      description: "",
    });
    // No field anywhere in this component sets a timer or whole-unit completion.
    expect(el.querySelector('input[type="checkbox"]')).toBeNull();
    expect(el.textContent).not.toMatch(/whole|entire installation/i);
  });

  it("an installer sees the summary with no write controls", async () => {
    summaryMock.mockResolvedValue([{ stage: "RO checked", work_date: "2026-09-29", profile_id: "p-1", digest: "abc" }]);
    const command = vi.fn(async () => {});
    const el = render(fakeWork(command), false);
    await act(async () => click(el.querySelector('[data-testid="ws-contrib-open"]')));
    await settle();

    const unitSelect = el.querySelector<HTMLSelectElement>("#ws-contrib-unit")!;
    await act(async () => setValue(unitSelect, "unit-1"));
    await settle();
    // Default stage ("RO checked") already matches the seeded row; the date
    // does not default to a fixed past day, so align it with the fixture.
    const dateInput = el.querySelector<HTMLInputElement>("#ws-contrib-date")!;
    await act(async () => setValue(dateInput, "2026-09-29"));
    await settle();

    expect(el.textContent).toContain("Alice Installer");
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === "Save contributors")).toBe(false);
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === "Correct this")).toBe(false);
    expect(command).not.toHaveBeenCalled();
  });

  it("a correction sends the reason, the server digest (never one computed in the UI), and removing one of two leaves the other", async () => {
    summaryMock.mockResolvedValue([
      { stage: "RO checked", work_date: "2026-09-29", profile_id: "p-1", digest: "server-digest-xyz" },
      { stage: "RO checked", work_date: "2026-09-29", profile_id: "p-2", digest: "server-digest-xyz" },
    ]);
    const command = vi.fn(async () => {});
    const el = render(fakeWork(command), true);
    await act(async () => click(el.querySelector('[data-testid="ws-contrib-open"]')));
    await settle();
    await act(async () => setValue(el.querySelector<HTMLSelectElement>("#ws-contrib-unit")!, "unit-1"));
    await settle();
    await act(async () => setValue(el.querySelector<HTMLInputElement>("#ws-contrib-date")!, "2026-09-29"));
    await settle();

    await act(async () => click([...el.querySelectorAll("button")].find((b) => b.textContent === "Correct this")!));
    await act(async () => click([...el.querySelectorAll("button")].find((b) => b.textContent === "Alice Installer")!));
    const reasonBox = el.querySelector<HTMLTextAreaElement>("#ws-contrib-reason")!;
    await act(async () => setValue(reasonBox, "Alice was pulled to another job that morning"));

    summaryMock.mockResolvedValue([{ stage: "RO checked", work_date: "2026-09-29", profile_id: "p-1", digest: "new-unreviewed-evidence" }]);
    await act(async () => { await client.invalidateQueries({ queryKey: ["stageContributorSummary"] }); });
    await settle();
    expect(el.querySelector<HTMLInputElement>("#ws-contrib-date")!.disabled).toBe(true);
    expect(el.querySelector<HTMLSelectElement>("#ws-contrib-job")!.disabled).toBe(true);

    const saveCorrection = [...el.querySelectorAll("button")].find((b) => b.textContent === "Save correction")!;
    await act(async () => click(saveCorrection));

    expect(command).toHaveBeenCalledWith("correct_stage_contributors", {
      unit_id: "unit-1",
      stage: "RO checked",
      work_date: "2026-09-29",
      expected_digest: "server-digest-xyz",
      reason: "Alice was pulled to another job that morning",
      remove: ["p-1"],
      add: [],
    });
  });
});
