// @vitest-environment happy-dom
//
// The unit form, mounted for real. On 2026-09-24 crews reported that marking a
// unit complete "doesn't work or save": the choice was folded away in the
// optional section, and the form's main button, "Save and start", saved the
// Yes and then started a new visit — which reopens completion by design. With
// Yes chosen, the only save now is a plain one.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnitEditor } from "./UnitEditor";
import type { WorkUnit } from "../../lib/customWork/model";

const unit: WorkUnit = {
  id: "u4", project_id: "job-1", opening_id: null, created_by: "me", label: "4", type_label: "Bifold door",
  revision: 3, created_at: "2026-09-22T00:00:00Z", updated_at: "2026-09-22T00:00:00Z",
  facts: { width_in: 72, height_in: 96, story: "1" },
};

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(u: WorkUnit | undefined, onSave: (v: Record<string, unknown>, start: boolean) => Promise<void>) {
  // Seeded and never stale: the form must not reach for a network in a test.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["projects"], [{ id: "job-1", name: "Pine Hollow" }]);
  qc.setQueryData(["customWorkRoster"], []);
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <UnitEditor unit={u} jobId="job-1" types={[]} busy={false} onSave={onSave} onCancel={() => undefined} />
      </QueryClientProvider>,
    ),
  );
}
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const completeSelect = () =>
  [...container.querySelectorAll("label")]
    .find((l) => l.textContent?.includes("Whole install complete"))
    ?.querySelector("select") as HTMLSelectElement | undefined;
function choose(el: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("marking the whole install complete in the unit form", () => {
  it("sits in Necessary information, not the folded optional section", () => {
    mount(unit, vi.fn());
    const select = completeSelect();
    expect(select).toBeTruthy();
    expect(select!.closest("details")).toBeNull();
  });

  it("choosing Yes turns the main button into a plain save that never starts a visit", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    mount(unit, onSave);
    expect(button("Save and start")).toBeTruthy();
    await act(async () => choose(completeSelect()!, "Yes"));
    expect(button("Save and start")).toBeUndefined();
    expect(button("Save details")).toBeUndefined();
    await act(async () => button("Save — install complete ✓")!.click());
    expect(onSave).toHaveBeenCalledTimes(1);
    const [data, start] = onSave.mock.calls[0];
    expect(start).toBe(false);
    expect((data.facts as Record<string, unknown>).installation_complete).toBe("Yes");
    expect(data.revision).toBe(3);
  });

  it("a unit that is already complete opens with the plain save", () => {
    mount({ ...unit, facts: { ...unit.facts, installation_complete: "Yes" } }, vi.fn());
    expect(button("Save — install complete ✓")).toBeTruthy();
    expect(button("Save and start")).toBeUndefined();
  });

  it("an unfinished unit still saves and starts, as before", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    mount(unit, onSave);
    await act(async () => button("Save and start")!.click());
    expect(onSave.mock.calls[0][1]).toBe(true);
  });
});
