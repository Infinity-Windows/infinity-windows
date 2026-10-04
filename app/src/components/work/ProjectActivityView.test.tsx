// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectActivityView, type ActivityChoice, type ActivityIntent, type FrozenUnitBasis,
  type ProjectActivityViewProps,
} from "./ProjectActivityView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const basis: FrozenUnitBasis = {
  id: "unit-42", operationalRevision: 7, factId: "fact-9", factRevision: 3,
  incarnationEpoch: 2, bindingEpoch: 4, projectEpoch: 3, openingEpoch: 8, originProjectEpoch: 2, originOpeningEpoch: 7,
};
const general: ActivityChoice = {
  selectionId: "selection-1", selectionRevision: 5, menuVersionId: "menu-v3",
  definitionVersionId: "unload-v2", scope: "general", label: { en: "Unload product", es: "Descargar producto" },
  kind: "activity", fields: [], personalSeconds: 3660, scopeTotalSeconds: 7200, eligible: true,
};
const machineGeneral: ActivityChoice = {
  ...general, definitionVersionId: "machine-v1", kind: "machinery",
  label: { en: "Operating Machinery", es: "Operar maquinaria" }, personalSeconds: null, scopeTotalSeconds: null,
};
const specific: ActivityChoice = {
  ...general, definitionVersionId: "frame-v4", scope: "specific",
  label: { en: "Frame", es: "Marco" }, personalSeconds: null, scopeTotalSeconds: 1800,
};
const machineSpecific: ActivityChoice = { ...machineGeneral, scope: "specific" };
let props: ProjectActivityViewProps;
let intents: ActivityIntent[];

function base(): ProjectActivityViewProps {
  intents = [];
  return {
    locale: "en", project: { id: "project-a", name: "Black Desert", code: "BD22" },
    tab: "general", onTabChange: vi.fn(),
    paidSeconds: null, scopeSeconds: { general: 5400, specific: null }, running: null,
    catalog: { status: "ready", capturable: true, general: [general, machineGeneral], specific: [specific, machineSpecific] },
    units: [{ id: "unit-42", label: "Unit 42", detail: "Window" }],
    selectedUnitId: "unit-42", selectedUnitState: "ready", selectedUnitBasis: basis,
    onSelectUnit: vi.fn(), onAddUnit: vi.fn(), activityPending: false,
    onStartActivity: vi.fn(async (intent) => { intents.push(intent); }),
    onOpenClock: vi.fn(), onBreak: vi.fn(), onClockOut: vi.fn(), onSchedule: vi.fn(), onAsk: vi.fn(),
  };
}
async function render(changes: Partial<ProjectActivityViewProps> = {}) {
  props = { ...props, ...changes };
  await act(async () => root.render(<ProjectActivityView {...props} />));
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((el) =>
    el.getAttribute("aria-label") === label || el.textContent?.trim() === label);
  expect(button, `button ${label}`).toBeTruthy();
  await act(async () => button!.click());
}
async function flush() { await act(async () => { await Promise.resolve(); }); }

beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); props = base();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("selected-job activity view", () => {
  it("keeps clock, break, clock-out, Schedule and Ask available through read errors", async () => {
    await render({ catalog: { ...props.catalog, status: "error" }, activityPending: true });
    expect(host.textContent).toContain("Unavailable");
    expect(host.textContent).not.toContain("0h 00m");
    expect(host.textContent).toContain("Published activities are unavailable");
    await click("Break"); await click("Clock out"); await click("Schedule"); await click("Ask");
    await click("Your clock");
    expect(props.onBreak).toHaveBeenCalledOnce(); expect(props.onClockOut).toHaveBeenCalledOnce();
    expect(props.onSchedule).toHaveBeenCalledOnce(); expect(props.onAsk).toHaveBeenCalledOnce();
    expect(props.onOpenClock).toHaveBeenCalledOnce();
    expect(intents).toEqual([]);
  });

  it("uses controlled tabs and freezes exact published selection and unit basis", async () => {
    await render();
    await click("Specific");
    expect(props.onTabChange).toHaveBeenCalledWith("specific");
    expect(host.textContent).not.toContain("Frame");
    await render({ tab: "specific", dimensionsSlot: <div>Dimension controls</div>, unitActionsSlot: <div>Finish unit</div> });
    expect(host.textContent).toContain("Dimension controls");
    expect(host.textContent).toContain("Finish unit");
    await click("Frame");
    await flush();
    expect(intents).toEqual([{
      projectId: "project-a", selectionId: "selection-1", selectionRevision: 5,
      menuVersionId: "menu-v3", definitionVersionId: "frame-v4", scope: "specific",
      unit: basis, machineKind: null, values: {},
    }]);
    expect(Object.isFrozen(intents[0])).toBe(true);
    expect(Object.isFrozen(intents[0].unit)).toBe(true);
    expect(intents[0].unit).not.toBe(basis);
    expect(host.textContent).toContain("Your selected-unit time: Unavailable");
  });

  it("blocks Specific start without the frozen unit basis while retaining dimension controls", async () => {
    await render({ tab: "specific", selectedUnitBasis: null, selectedUnitState: "needs_dimensions",
      selectedUnitBlockReason: "Current unit facts need review", dimensionsSlot: <button>Save dimensions</button> });
    expect(host.textContent).toContain("Current unit facts need review");
    expect(host.textContent).toContain("Save dimensions");
    expect([...host.querySelectorAll(".pav-tile")].every((node) => (node as HTMLButtonElement).disabled)).toBe(true);
    await click("Frame"); expect(intents).toEqual([]);
    await click("Break"); expect(props.onBreak).toHaveBeenCalledOnce();
  });

  it("does not switch activity when machinery is opened and cancelled; enforces scope choices", async () => {
    await render({ running: { projectId: "project-a", definitionVersionId: "cleanup-v1", unitId: null,
      label: { en: "Cleanup", es: "Limpieza" }, scope: "general", status: "confirmed" } });
    await click("Operating Machinery");
    expect(host.textContent).toContain("Your current activity keeps running");
    expect(host.textContent).not.toContain("Scissor Lift");
    await click("Cancel");
    expect(intents).toEqual([]);
    expect(host.textContent).toContain("Cleanup");
    await click("Operating Machinery");
    await click("Forklift"); await flush();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ scope: "general", unit: null, machineKind: "forklift", definitionVersionId: "machine-v1" });
    await render({ tab: "specific" });
    await click("Operating Machinery");
    expect(host.textContent).toContain("Scissor Lift");
    await click("Spider suction cup machine"); await flush();
    expect(intents[1]).toMatchObject({ scope: "specific", unit: basis, machineKind: "spider_suction" });
  });

  it("closes machinery choice if the published selection changes before commitment", async () => {
    await render();
    await click("Operating Machinery");
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
    await render({ catalog: { ...props.catalog, general: [{ ...general, selectionRevision: 6 }, { ...machineGeneral, selectionRevision: 6 }] } });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(intents).toEqual([]);
    await render({ catalog: { ...props.catalog, capturable: false, blockReason: "Selection needs review" } });
    expect(host.textContent).toContain("Selection needs review");
    expect([...host.querySelectorAll('.pav-tile')].every((node) => (node as HTMLButtonElement).disabled)).toBe(true);
  });

  it("refuses a machine choice after the selected unit facts change", async () => {
    await render({ tab: "specific" });
    await click("Operating Machinery");
    await render({ selectedUnitBasis: { ...basis, factRevision: 4 } });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(intents).toEqual([]);
  });

  it("prevents double taps while the parent command remains unresolved", async () => {
    let resolve!: () => void;
    const unresolved = new Promise<void>((done) => { resolve = done; });
    const send = vi.fn(() => unresolved);
    await render({ onStartActivity: send });
    await click("Unload product");
    await click("Unload product");
    expect(send).toHaveBeenCalledTimes(1);
    expect((host.querySelector(".pav-tile") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve());
    await render({ activityPending: true });
    await click("Unload product");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not invent empty success, zero totals, or a start when catalog is unreadable", async () => {
    await render({ catalog: { status: "unavailable", capturable: false, general: [], specific: [] } });
    expect(host.textContent).toContain("Published activities are unavailable");
    expect(host.textContent).not.toContain("No published activities are available");
    expect(host.textContent).toContain("Your General time: 1h 30m");
    expect(intents).toEqual([]);
  });

  it("shows source-supplied personal and job/unit activity totals on each compact tile", async () => {
    await render();
    const unload = host.querySelector('button[aria-label="Unload product"]')!;
    expect(unload.textContent).toContain("Your time: 1h 01m");
    expect(unload.textContent).toContain("Job total: 2h 00m");
    expect(host.querySelector('button[aria-label="Operating Machinery"]')?.textContent)
      .toContain("Job total: Unavailable");
    await render({ tab: "specific", locale: "es" });
    const frame = host.querySelector('button[aria-label="Marco"]')!;
    expect(frame.textContent).toContain("Tu tiempo: No disponible");
    expect(frame.textContent).toContain("Total de la unidad: 0h 30m");
  });

  it("highlights only a confirmed running tile matched by exact project, scope, unit and version", async () => {
    const running = { projectId: "project-a", definitionVersionId: "frame-v4", unitId: "unit-42",
      label: { en: "Old frame name", es: "Nombre anterior" }, scope: "specific" as const,
      status: "confirmed" as const };
    await render({ tab: "specific", running });
    const frame = host.querySelector('button[aria-label="Frame"]')!;
    expect(frame.getAttribute("aria-pressed")).toBe("true");
    expect(frame.textContent).toContain("Running");
    expect(frame.classList.contains("pav-tile-running")).toBe(true);
    await render({ running: { ...running, projectId: "other-job" } });
    expect(frame.getAttribute("aria-pressed")).toBe("false");
    await render({ running: { ...running, unitId: "other-unit" } });
    expect(frame.getAttribute("aria-pressed")).toBe("false");
    await render({ running: { ...running, definitionVersionId: "frame-v5" } });
    expect(frame.getAttribute("aria-pressed")).toBe("false");
    await render({ running: { ...running, status: "pending" } });
    expect(frame.getAttribute("aria-pressed")).toBe("false");
    expect(host.textContent).toContain("Pending confirmation");
  });

  it("speaks Spanish and retains unknown totals and an explicit pending state", async () => {
    await render({ locale: "es", tab: "specific", paidSeconds: null,
      running: { projectId: "project-a", definitionVersionId: "frame-v4", unitId: "unit-42",
        label: { en: "Frame", es: "Marco" }, scope: "specific", unitLabel: "Unidad 42", status: "pending" },
      activityPending: true, activityStatus: { kind: "pending", message: "Guardado en este teléfono" } });
    expect(host.querySelector('.pav-clock')?.getAttribute('aria-label')).toBe("Tu reloj");
    expect(host.textContent).toContain("Pendiente de confirmación");
    expect(host.textContent).toContain("Tu tiempo de la unidad elegida: No disponible");
    expect(host.textContent).toContain("Guardado en este teléfono");
    expect((host.querySelector(".pav-tile") as HTMLButtonElement).disabled).toBe(true);
  });
  it("collects required answers before dispatch, preserving false and zero across language changes", async () => {
    const choice: ActivityChoice = { ...general, fields: [
      { id: "count", type: "number", required: true, unit: "count", label_en: "Count", label_es: "Cantidad" },
      { id: "ready", type: "boolean", required: true, label_en: "Ready", label_es: "Listo" },
    ] };
    await render({ catalog: { ...props.catalog, general: [choice] } });
    await click("Unload product"); expect(intents).toEqual([]);
    await click("Start activity"); expect(intents).toEqual([]);
    expect(host.textContent).toContain("Choose or enter an answer");
    const input = host.querySelector(".paf input") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "0");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const select = host.querySelector(".paf select") as HTMLSelectElement;
      select.value = "false"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await render({ locale: "es" });
    expect((host.querySelector(".paf input") as HTMLInputElement).value).toBe("0");
    expect((host.querySelector(".paf select") as HTMLSelectElement).value).toBe("false");
    await click("Iniciar actividad"); await flush();
    expect(intents).toHaveLength(1); expect(intents[0].values).toEqual({ count: 0, ready: false });
    expect(Object.isFrozen(intents[0].values)).toBe(true);
  });

  it("requires machinery and answers together, and discards a stale schema without switching", async () => {
    const choice: ActivityChoice = { ...machineGeneral, fields: [
      { id: "note", type: "text", required: true, label_en: "Note", label_es: "Nota" },
    ] };
    await render({ catalog: { ...props.catalog, general: [choice] } });
    await click("Operating Machinery"); await click("Forklift");
    expect(intents).toEqual([]);
    await click("Start activity"); expect(intents).toEqual([]);
    await render({ catalog: { ...props.catalog, general: [{ ...choice, fields: [{ ...choice.fields[0], id: "different" }] }] } });
    expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(intents).toEqual([]);
  });

  it("closes a pending Specific choice for every current or origin project/opening epoch change", async () => {
    for (const key of ["projectEpoch", "openingEpoch", "originProjectEpoch", "originOpeningEpoch"] as const) {
      await render({ tab: "specific", selectedUnitBasis: basis });
      await click("Operating Machinery"); expect(host.querySelector('[role="dialog"]')).not.toBeNull();
      await render({ selectedUnitBasis: { ...basis, [key]: (basis[key] ?? 0) + 1 } });
      expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(intents).toEqual([]);
    }
  });

});
