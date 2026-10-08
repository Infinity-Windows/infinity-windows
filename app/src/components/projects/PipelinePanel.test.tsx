// @vitest-environment happy-dom
//
// The Pipeline card's Mark ready, mounted for real. The owner's answer of
// 2026-10-08 is that site readiness stands on its own: the green-light
// checklist is a set of reminders beside the button, never a lock on it. So
// what is worth proving is that NOTHING about the checklist — a long list of
// open items, a read that is still loading, a read that failed — keeps the
// button from reaching set_project_readiness, and that an installer is not
// even asked for the list.
//
// Every network edge is mocked; no business RPC runs.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GreenLightItem } from "../../lib/install/buildFacts";
import type { Project } from "../../lib/types";

const setProjectReadiness = vi.fn(async (..._args: unknown[]) => {});
const listGreenLightItems = vi.fn(
  async (..._args: unknown[]): Promise<GreenLightItem[]> => [],
);

vi.mock("../../lib/api", () => ({
  setProjectReadiness: (...a: unknown[]) => setProjectReadiness(...a),
  setProjectMaterials: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
}));

vi.mock("../../lib/gc", () => ({
  gcCheckinsKey: (id: string) => ["gcCheckins", id],
  listGcCheckins: vi.fn(async () => ({ rows: [], known: false })),
}));

// The real key shape and helpers, with only the read swapped out — keeps
// supabase and the outbox out of the test.
vi.mock("../../lib/install/buildFacts", () => ({
  greenLightItemsKey: (id: string) => ["greenLightItems", id] as const,
  listGreenLightItems: (...a: unknown[]) => listGreenLightItems(...a),
  openGreenLightItems: (items: GreenLightItem[]) => items.filter((i) => !i.answered),
  WHO_KEYS: { foreman: "buildFacts.who.foreman", supervisor: "buildFacts.who.supervisor" },
}));

// The language provider's own dependencies.
vi.mock("../../lib/install/api", () => ({
  getRealProfile: vi.fn(async () => null),
  setMyLanguage: vi.fn(async () => {}),
}));
vi.mock("../../lib/toast", () => ({ toastError: vi.fn(), pushToast: vi.fn() }));

const { LanguageProvider } = await import("../../lib/i18n");
const { PipelinePanel } = await import("./PipelinePanel");

const ALL_OPEN: GreenLightItem[] = [
  { item_key: "plan_set", label_en: "x", answered: false, who: "supervisor" },
  { item_key: "build_facts", label_en: "x", answered: false, who: "foreman" },
  { item_key: "materials_eta", label_en: "x", answered: false, who: "supervisor" },
  { item_key: "gc_site", label_en: "x", answered: false, who: "foreman" },
  { item_key: "day_one_crew", label_en: "x", answered: false, who: "supervisor" },
  { item_key: "toolbox", label_en: "x", answered: false, who: "supervisor" },
];

function project(readyState: "ready" | "not_ready"): Project {
  return {
    id: "p1",
    name: "Test job",
    ready_state: readyState,
    start_date: null,
    materials_eta: null,
    materials_arrived_at: null,
  } as unknown as Project;
}

let container: HTMLElement;
let root: Root;
let qc: QueryClient;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  setProjectReadiness.mockReset().mockResolvedValue(undefined);
  listGreenLightItems.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(readyState: "ready" | "not_ready", isLead: boolean) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <LanguageProvider>
          <PipelinePanel project={project(readyState)} isLead={isLead} />
        </LanguageProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
}

function button(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

async function tap(b: HTMLButtonElement) {
  act(() => {
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

describe("PipelinePanel — Mark ready stands on its own", () => {
  it("shows every open item as a reminder and still marks the job ready", async () => {
    listGreenLightItems.mockResolvedValue([
      ...ALL_OPEN,
      { item_key: "something_new", label_en: "Raw server text", answered: false, who: "foreman" },
    ]);
    await mount("not_ready", true);

    const text = container.textContent ?? "";
    expect(text).toContain("Setup reminders");
    expect(text).toContain("Reminders only — they never stop you marking the job ready.");
    expect(text).toContain("A planset is uploaded and its extraction has finished");
    expect(text).toContain("An exterior finish and its set depth are recorded");
    expect(text).toContain("The materials ETA is set and lands on or before the first day on site");
    expect(text).toContain("The GC contact and site rules are recorded");
    expect(text).toContain("A crew and a truck are assigned for the first day on site");
    expect(text).toContain("A toolbox talk is pinned to the first day");
    expect(text).toContain("Who answers: foreman");
    expect(text).toContain("Who answers: supervisor");
    // An unknown key is a generic line, never the server's raw text.
    expect(text).toContain("Another setup item is still open");
    expect(text).not.toContain("Raw server text");

    const markReady = button("Mark ready");
    expect(markReady).toBeDefined();
    expect(markReady!.disabled).toBe(false);
    await tap(markReady!);
    expect(setProjectReadiness).toHaveBeenCalledWith("p1", "ready");
    expect(container.querySelector(".error")).toBeNull();
  });

  it("refetches the reminders and the job after a successful change", async () => {
    listGreenLightItems.mockResolvedValue(ALL_OPEN);
    await mount("not_ready", true);
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const readsBefore = listGreenLightItems.mock.calls.length;

    await tap(button("Mark ready")!);

    expect(setProjectReadiness).toHaveBeenCalledWith("p1", "ready");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["projects"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["greenLightItems", "p1"] });
    expect(listGreenLightItems.mock.calls.length).toBeGreaterThan(readsBefore);
  });

  it("marks a ready job not ready", async () => {
    listGreenLightItems.mockResolvedValue(ALL_OPEN);
    await mount("ready", true);
    await tap(button("Mark not ready")!);
    expect(setProjectReadiness).toHaveBeenCalledWith("p1", "not_ready");
    expect(container.querySelector(".error")).toBeNull();
  });

  it("still marks ready when the checklist read fails, and says so plainly", async () => {
    listGreenLightItems.mockRejectedValue(new Error("network down"));
    await mount("not_ready", true);

    const text = container.textContent ?? "";
    expect(text).toContain("Setup reminders didn't load. You can still mark the job ready.");
    expect(text).not.toContain("network down");

    const markReady = button("Mark ready")!;
    expect(markReady.disabled).toBe(false);
    await tap(markReady);
    expect(setProjectReadiness).toHaveBeenCalledWith("p1", "ready");
  });

  it("does not wait for a checklist that is still loading", async () => {
    listGreenLightItems.mockImplementation(() => new Promise(() => {}));
    await mount("not_ready", true);

    const markReady = button("Mark ready")!;
    expect(markReady.disabled).toBe(false);
    await tap(markReady);
    expect(setProjectReadiness).toHaveBeenCalledWith("p1", "ready");
  });

  it("never claims the checklist is complete when it comes back empty", async () => {
    listGreenLightItems.mockResolvedValue([]);
    await mount("not_ready", true);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Setup reminders");
    expect(text).not.toMatch(/all set|complete/i);
    expect(button("Mark ready")!.disabled).toBe(false);
  });

  it("an installer gets no checklist read, no control and no reminders", async () => {
    listGreenLightItems.mockResolvedValue(ALL_OPEN);
    await mount("not_ready", false);

    expect(listGreenLightItems).not.toHaveBeenCalled();
    expect(button("Mark ready")).toBeUndefined();
    expect(container.textContent).not.toContain("Setup reminders");
    // The state itself is still read by everyone.
    expect(container.textContent).toContain("Not ready");
  });

  it("speaks Spanish: item labels, who answers, and the button", async () => {
    localStorage.setItem("infinity.language", "es");
    listGreenLightItems.mockResolvedValue(ALL_OPEN);
    await mount("not_ready", true);

    const text = container.textContent ?? "";
    expect(text).toContain("Pendientes de preparación");
    expect(text).toContain("Solo son recordatorios — nunca impiden marcar el trabajo como listo.");
    expect(text).toContain("Los planos están subidos y ya se terminaron de leer");
    expect(text).toContain("El contacto del GC y las reglas del sitio están registrados");
    expect(text).toContain("Quién responde: capataz");
    expect(text).not.toContain("A planset is uploaded");

    await tap(button("Marcar listo")!);
    expect(setProjectReadiness).toHaveBeenCalledWith("p1", "ready");
  });
});
