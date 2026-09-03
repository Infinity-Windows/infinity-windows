// @vitest-environment happy-dom
//
// The per-job cost-code checklist, mounted for real and read from the DOM. It
// proves the two things that matter after the layout fix: every code renders as
// one clean [checkbox] [code] [label] row (checkbox present, code and label in
// their own cells), and toggling a code still adds/removes it so Save wakes up.
// The assertions are layout-agnostic about pixels — they check structure and
// behaviour, not positions — so a future style tweak won't break them.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hold the network still: reads are seeded into the cache (staleTime Infinity),
// and the only write is a spy, so a toggle never reaches for a server.
const { setSpy } = vi.hoisted(() => ({ setSpy: vi.fn(async () => {}) }));
vi.mock("../../lib/costCodes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/costCodes")>();
  return {
    ...actual,
    setProjectCostCodes: setSpy,
    listProjectCostCodes: vi.fn(async () => []),
  };
});
vi.mock("../../lib/timeclock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/timeclock")>();
  return { ...actual, listCostCodes: vi.fn(async () => []) };
});

import { JobCostCodesPanel } from "./JobCostCodesPanel";
import type { CostCode } from "../../lib/timeclock";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setSpy.mockClear();
});

function code(id: string, c: string, label: string): CostCode {
  return { id, code: c, label, active: true };
}

const PROJECT = "p1";

function mount(all: CostCode[], assigned: CostCode[]): HTMLElement {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
  qc.setQueryData(["allActiveCostCodes"], all);
  qc.setQueryData(["projectCostCodes", PROJECT], assigned);

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <JobCostCodesPanel projectId={PROJECT} />
      </QueryClientProvider>,
    );
  });
  return host;
}

describe("the per-job cost-code checklist", () => {
  const CODES = [code("a", "000", "General"), code("b", "500", "Install")];

  it("renders one clean row per code — checkbox, code cell, label cell", () => {
    const el = mount(CODES, []);
    const rows = el.querySelectorAll<HTMLLIElement>(".jobcost-row");
    expect(rows.length).toBe(2);
    for (const row of rows) {
      // Every row carries exactly one checkbox — the boxes line up in a column.
      expect(row.querySelectorAll('input[type="checkbox"]').length).toBe(1);
      // Code and label live in their own cells, not merged into one span.
      expect(row.querySelector(".jobcost-code")).toBeTruthy();
      expect(row.querySelector(".jobcost-label")).toBeTruthy();
    }
    const codes = Array.from(el.querySelectorAll(".jobcost-code")).map(
      (n) => n.textContent,
    );
    expect(codes).toEqual(["000", "500"]);
    const labels = Array.from(el.querySelectorAll(".jobcost-label")).map(
      (n) => n.textContent,
    );
    expect(labels).toEqual(["General", "Install"]);
  });

  it("checks the boxes the job already has, and none of the rest", () => {
    const el = mount(CODES, [code("b", "500", "Install")]);
    const boxes = el.querySelectorAll<HTMLInputElement>(
      '.jobcost-row input[type="checkbox"]',
    );
    expect(boxes[0].checked).toBe(false); // 000 not on the job
    expect(boxes[1].checked).toBe(true); // 500 is
  });

  it("toggling a code flips its box and wakes Save up", () => {
    const el = mount(CODES, [code("b", "500", "Install")]);
    const save = Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.includes("Save cost codes"),
    )!;
    // Seeded == current, so nothing to save yet.
    expect(save.disabled).toBe(true);

    const box000 = el.querySelectorAll<HTMLInputElement>(
      '.jobcost-row input[type="checkbox"]',
    )[0];
    act(() => box000.click());

    // The box is now on and the change is dirty, so Save is live.
    expect(
      el.querySelectorAll<HTMLInputElement>('.jobcost-row input[type="checkbox"]')[0]
        .checked,
    ).toBe(true);
    expect(
      Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
        b.textContent?.includes("Save cost codes"),
      )!.disabled,
    ).toBe(false);
  });
});
