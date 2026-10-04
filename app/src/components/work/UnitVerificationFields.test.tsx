// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnitVerificationFields, type UnitVerificationFieldsProps } from "./UnitVerificationFields";
import { emptyVerificationDraft, type ReviewContext } from "../../lib/workUnitReview/form";
import { LanguageContext } from "../../lib/i18n/context";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null, host: HTMLDivElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks(); });
const context = (): ReviewContext => ({ basisStatus: "current", actorId: "reviewer", observerId: "installer", original: { width: 6, height: 8, units: "ft", source: "estimated", sourceReference: "Original field estimate" },
  basis: { unitId: "unit-42", unitRevision: 9, factId: "fact-4", factRevision: 4, scopeToken: "opaque-server-token", reviewRevision: 2, submissionId: null, generation: 1 } });
function props(): UnitVerificationFieldsProps {
  const ctx = context();
  return { context: ctx, value: { ...emptyVerificationDraft(ctx), width: "72", height: "96", units: "in", source: "measured", reference: "Measured each edge with tape" }, delivery: "idle", allowed: true, observerLabel: "Installer Fixture", actorLabel: "Reviewer Fixture", onChange: vi.fn(), onIntent: vi.fn() };
}
function render(p: UnitVerificationFieldsProps, lang: "en" | "es" = "en") {
  if (!host) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
  act(() => root!.render(<LanguageContext.Provider value={{ lang, t: () => "", setLang: () => {}, needsChoice: false }}><UnitVerificationFields {...p} /></LanguageContext.Provider>));
  return host;
}
function submit() { act(() => host!.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }

describe("controlled independent dimension review", () => {
  it("preserves original estimate and sends only an exact-basis intent, without recording a verified state", () => {
    const p = props(); render(p); expect(host!.textContent).toContain("Original field estimate"); expect(host!.textContent).toContain("Estimated");
    submit(); expect(p.onIntent).toHaveBeenCalledTimes(1);
    const intent = vi.mocked(p.onIntent).mock.calls[0][0]; expect(intent).toMatchObject({ kind: "verify_dimensions", basis: context().basis, evidence: { width: 72, height: 96, units: "in", source: "measured" } });
    expect(intent).not.toHaveProperty("verified"); expect(intent).not.toHaveProperty("actorId"); expect(p.context.original!.source).toBe("estimated");
    expect(host!.textContent).toContain("Review not sent");
  });
  it("requires an independent actual observer and refuses a forced submit on one's own measurements", () => {
    const p = props(); p.context = { ...p.context, observerId: "reviewer" }; render(p); expect(host!.textContent).toContain("Another authorized person"); submit(); expect(p.onIntent).not.toHaveBeenCalled();
    p.context = { ...p.context, observerId: null }; render(p); expect(host!.textContent).toContain("original observer is unknown"); submit(); expect(p.onIntent).not.toHaveBeenCalled();
  });
  it("blocks mismatching dimensions and offers a new observation rather than replacing saved numbers", () => {
    const p = props(); p.value = { ...p.value, width: "72.00001" }; render(p); expect(host!.textContent).toContain("Record a new size observation first"); submit(); expect(p.onIntent).not.toHaveBeenCalled(); expect(p.context.original!.width).toBe(6);
  });
  it.each(["pending", "unknown", "applied"] as const)("blocks duplicate submission while delivery is %s", delivery => {
    const p = props(); p.delivery = delivery; render(p); expect(host!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true); submit(); expect(p.onIntent).not.toHaveBeenCalled();
  });
  it("removes private draft inputs and source reference when the current basis is stale or unavailable", () => {
    const p = props(); p.context = { ...p.context, basisStatus: "stale" }; render(p); expect(host!.querySelector("textarea")).toBeNull(); expect(host!.textContent).not.toContain("Original field estimate"); submit(); expect(p.onIntent).not.toHaveBeenCalled();
    p.context = { ...p.context, basisStatus: "unavailable" }; render(p); expect(host!.textContent).toContain("Current review details are unavailable");
  });
  it("hides a previous owner's draft and requires a fresh draft for the current identity", () => {
    const p = props(); p.context = { ...p.context, actorId: "next-reviewer" }; render(p); expect(host!.querySelector("textarea")).toBeNull(); expect(host!.textContent).not.toContain(p.value.reference);
    act(() => host!.querySelector<HTMLButtonElement>("button")!.click()); expect(p.onChange).toHaveBeenCalledWith(expect.objectContaining({ actorId: "next-reviewer", width: "", reference: "" })); expect(p.onIntent).not.toHaveBeenCalled();
  });
  it("keeps typing controlled without starting an action and supports Spanish labels", () => {
    const p = props(); render(p, "es"); const input = host!.querySelector<HTMLInputElement>("input")!;
    act(() => { input.value = "73"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(host!.textContent).toContain("Verificar medidas de la unidad"); expect(p.onIntent).not.toHaveBeenCalled();
    expect(host!.querySelector('option[value="estimated"]')).toBeNull();
    expect(host!.textContent).toContain("Estimado");
  });
  it("does not round away entered precision to manufacture agreement", () => {
    const p = props(); p.context = { ...p.context, original: { width: 1, height: 1, units: "in", source: "measured", sourceReference: null } };
    p.value = { ...p.value, width: "1.00000000000000001", height: "1" }; render(p); submit(); expect(p.onIntent).not.toHaveBeenCalled();
  });
  it("renders permission refusal without a callback", () => { const p = props(); p.allowed = false; render(p); submit(); expect(p.onIntent).not.toHaveBeenCalled(); expect(host!.textContent).toContain("do not have permission"); });
});
