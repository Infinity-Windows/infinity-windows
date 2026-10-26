// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DimensionControls } from "./DimensionControls";
import { allReportFilters, groupingDimensions, type ReportDimension } from "./reportControls";
import { MultiSelect } from "./MultiSelect";

it("shows explicit choices as removable tags and collapses all choices to All", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const [value, setValue] = useState<string[] | null>(null);
    return <MultiSelect label="Jobs" options={[{ key: "a", label: "Alpha" }, { key: "b", label: "Beta" }]} value={value} onChange={setValue} color="#60b9d0" />;
  }
  try {
    await act(async () => { root.render(<Harness />); });
    expect(host.querySelector('.report-selection-tags')).toBeNull();
    await act(async () => { host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    expect(host.querySelector('.report-selection-tags')?.textContent).toContain("Beta");
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Remove Jobs Beta"]')!.click(); });
    expect(host.querySelector('.report-selection-tags')).toBeNull();
    expect(host.querySelector('summary')?.textContent).toContain("All");
  } finally { await act(async () => { root.unmount(); }); host.remove(); }
});

it("reorders via touch grip, cancels outside drops, and supports keyboard", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const [order, setOrder] = useState<ReportDimension[]>([...groupingDimensions]);
    return <DimensionControls rows={[]} order={order} enabled={[]} filters={allReportFilters()} onFilters={() => {}} onEnabled={() => {}} onOrder={setOrder} />;
  }
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    const index = this.dataset.dimension ? [...this.parentElement!.children].indexOf(this) : 0;
    return { x: index * 100, left: index * 100, y: 100, top: 100, width: this.classList.contains("dimension-strip") ? 300 : 100, height: 80, right: this.classList.contains("dimension-strip") ? 300 : index * 100 + 100, bottom: 180, toJSON() {} };
  });
  const order = () => [...host.querySelectorAll<HTMLElement>('[data-dimension]')].map(card => card.dataset.dimension);
  const pointer = async (handle: HTMLElement, type: string, x: number, y: number) => {
    await act(async () => { handle.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, pointerType: "touch", clientX: x, clientY: y })); });
  };
  try {
    await act(async () => { root.render(<Harness />); });
    const floor = host.querySelector<HTMLElement>('[aria-label="Reorder Floor"]')!;
    await pointer(floor, "pointerdown", 50, 130);
    await pointer(floor, "pointermove", 290, 130);
    expect(host.querySelector<HTMLElement>('.dimension-strip')!.scrollLeft).toBe(0);
    await pointer(floor, "pointerup", 290, 130);
    expect(order()).toEqual(["activity", "person", "floor", "job", "category", "subtype", "configuration", "system", "material", "scope"]);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Floor moved to position 3");
    const activity = host.querySelector<HTMLElement>('[aria-label="Reorder Activity"]')!;
    await pointer(activity, "pointerdown", 50, 130); await pointer(activity, "pointermove", 250, 130); await pointer(activity, "pointerup", 250, 999);
    expect(order()[0]).toBe("activity");
    await act(async () => { floor.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
    expect(order()[0]).toBe("floor");
  } finally { bounds.mockRestore(); await act(async () => { root.unmount(); }); host.remove(); }
});

it("reorders across wrapped rows using both pointer coordinates", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  function Harness() {
    const [order, setOrder] = useState<ReportDimension[]>([...groupingDimensions]);
    return <DimensionControls rows={[]} order={order} enabled={[]} filters={allReportFilters()} onFilters={() => {}} onEnabled={() => {}} onOrder={setOrder} />;
  }
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    const index = this.dataset.dimension ? [...this.parentElement!.children].indexOf(this) : 0;
    const left = index % 2 * 160, top = 100 + Math.floor(index / 2) * 40;
    return { x:left, y:top, left, top, width:320, height:80, right:320, bottom:180, toJSON() {} , ...(this.dataset.dimension ? { width:160, height:40, right:left + 160, bottom:top + 40 } : {}) };
  });
  try {
    await act(async () => root.render(<Harness />));
    const grip = host.querySelector<HTMLElement>('[aria-label="Reorder Floor"]')!;
    for (const [type, x, y] of [["pointerdown",80,120],["pointermove",240,160],["pointerup",240,160]] as const) {
      await act(async () => { grip.dispatchEvent(new PointerEvent(type, { bubbles:true, button:0, pointerId:1, pointerType:"touch", clientX:x, clientY:y })); });
    }
    expect([...host.querySelectorAll<HTMLElement>('[data-dimension]')].map(card => card.dataset.dimension)).toEqual(["activity", "person", "job", "floor", "category", "subtype", "configuration", "system", "material", "scope"]);
    expect(host.querySelector('[aria-label="Activity scope"]')).toBeNull();
  } finally { bounds.mockRestore(); await act(async () => root.unmount()); host.remove(); }
});
