// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TypedField } from "../../lib/workConfiguration/model";
import type { AnswerDraft } from "../../lib/workConfiguration/answers";
import { ActivityAnswerFields } from "./ActivityAnswerFields";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fields: TypedField[] = [
  { id: "note", label_en: "Note", label_es: "Nota", type: "text", required: true },
  { id: "measure", label_en: "Measure", label_es: "Medida", type: "number", required: true, unit: "in", min: -2, max: 2 },
  { id: "ready", label_en: "Ready", label_es: "Listo", type: "boolean", required: true },
  { id: "side", label_en: "Side", label_es: "Lado", type: "single_select", required: true,
    options: [{ id: "left", label_en: "Left", label_es: "Izquierda" }] },
  { id: "tools", label_en: "Tools", label_es: "Herramientas", type: "multi_select", required: true,
    options: [{ id: "hammer", label_en: "Hammer", label_es: "Martillo" }] },
];
let host: HTMLDivElement;
let root: Root;
let latest: AnswerDraft;
function Harness({ locale = "en", disabled = false }: { locale?: "en" | "es"; disabled?: boolean }) {
  const [value, setValue] = useState<AnswerDraft>({});
  latest = value;
  return <ActivityAnswerFields fields={fields} value={value} onChange={setValue} locale={locale}
    disabled={disabled} invalid={{ measure: "out_of_range" }} />;
}
async function render(locale: "en" | "es" = "en", disabled = false) {
  await act(async () => root.render(<Harness locale={locale} disabled={disabled} />));
}
async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("activity answer fields", () => {
  it("keeps raw decimal typing and focused draft across a language change", async () => {
    await render();
    const measure = host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    measure.focus();
    await change(measure, "-.");
    expect(latest.measure).toBe("-.");
    await render("es");
    expect(host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value).toBe("-.");
    expect(document.activeElement).toBe(measure);
    expect(host.textContent).toContain("Medida");
    expect(host.textContent).toContain("in");
  });
  it("keeps false deliberate and sends option IDs rather than translated labels", async () => {
    await render("es");
    const selects = host.querySelectorAll("select");
    await change(selects[0], "false");
    await change(selects[1], "left");
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => checkbox.click());
    expect(latest).toMatchObject({ ready: false, side: "left", tools: ["hammer"] });
    expect(host.textContent).toContain("Izquierda");
  });
  it("shows validation accessibly and disables controls without adding a submit action", async () => {
    await render("en", true);
    const measure = host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    expect(measure.disabled).toBe(true);
    expect(measure.getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("allowed range");
    expect(host.querySelector('button[type="submit"]')).toBeNull();
    expect(host.querySelector('[role="group"]')?.getAttribute("aria-labelledby")).toBeTruthy();
  });
});
