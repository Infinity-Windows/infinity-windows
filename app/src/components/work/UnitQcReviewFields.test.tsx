// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnitQcReviewFields, type UnitQcReviewFieldsProps } from "./UnitQcReviewFields";
import { emptyQcDraft, type ReviewContext } from "../../lib/workUnitReview/form";
import { LanguageContext } from "../../lib/i18n/context";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null, host: HTMLDivElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks(); });
const context = (): ReviewContext => ({ basisStatus: "current", actorId: "foreman", original: { observerId: "foreman", widthDecimal: "72", heightDecimal: "96", unit: "in", source: "measured", sourceReference: null },
  basis: { unitId: "unit-42", unitRevision: 9, factId: "fact-4", factRevision: 4, scopeToken: "opaque-server-token", reviewRevision: 2, submissionId: "submission-1", generation: 1 } });
function props(): UnitQcReviewFieldsProps {
  const ctx = context(); return { context: ctx, value: emptyQcDraft(ctx), delivery: "idle", state: "awaiting_review", defects: [], authority: { submit: true, pass: true, fail: true, claim_resolved: true, reopen: true }, onChange: vi.fn(), onIntent: vi.fn() };
}
function render(p: UnitQcReviewFieldsProps, lang: "en" | "es" = "en") {
  if (!host) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
  act(() => root!.render(<LanguageContext.Provider value={{ lang, t: () => "", setLang: () => {}, needsChoice: false }}><UnitQcReviewFields {...p} /></LanguageContext.Provider>)); return host;
}
function button(text: string) { return [...host!.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)!; }
function click(text: string) { act(() => button(text).click()); }

describe("controlled final QC review", () => {
  it("allows an authorized foreman's self final QC and emits no dimension or trust flag", () => {
    const p = props(); render(p); click("Record final QC pass"); expect(p.onIntent).toHaveBeenCalledWith(expect.objectContaining({ action: "pass", basis: p.context.basis }));
    const intent = vi.mocked(p.onIntent).mock.calls[0][0]; expect(intent).not.toHaveProperty("verified"); expect(intent).not.toHaveProperty("qcAccepted"); expect(host!.textContent).toContain("Awaiting review"); expect(host!.textContent).toContain("does not make the unit trusted data");
  });
  it("refuses pass with unresolved defects and does not convert a correction claim into a pass", () => {
    const p = props(); p.defects = [{ id: "defect-1", summary: "Seal gap", state: "open" }]; render(p); expect(button("Record final QC pass").disabled).toBe(true); click("Record final QC pass"); expect(p.onIntent).not.toHaveBeenCalled();
    p.state = "failed"; p.value = { ...p.value, resolvedDefectIds: ["defect-1"] }; render(p); click("Submit corrections for review"); expect(p.onIntent).toHaveBeenCalledWith(expect.objectContaining({ action: "claim_resolved", data: { note: null, defectIds: ["defect-1"] } })); expect(host!.textContent).toContain("Corrections required"); expect(button("Submit corrections for review")).toBeDefined();
  });
  it("requires a failure reason and stable described defects before sending", () => {
    const p = props(); render(p); expect(button("Record defects / fail QC").disabled).toBe(true);
    click("Add defect"); const changed = vi.mocked(p.onChange).mock.calls[0][0]; expect(changed.newDefects[0].id).toMatch(/^[0-9a-f-]{36}$/); expect(p.onIntent).not.toHaveBeenCalled();
    p.value = { ...changed, note: "Waterproofing needs repair", newDefects: [{ ...changed.newDefects[0], summary: "Unsealed lower corner" }] }; render(p); click("Record defects / fail QC");
    expect(p.onIntent).toHaveBeenCalledWith(expect.objectContaining({ action: "fail", data: { note: "Waterproofing needs repair", defects: p.value.newDefects } }));
  });
  it("requires a deliberate reopen reason without changing recorded history", () => {
    const p = props(); p.state = "passed"; render(p); expect(button("Reopen final QC").disabled).toBe(true);
    p.value = { ...p.value, note: "New work after final review" }; render(p); click("Reopen final QC"); expect(p.onIntent).toHaveBeenCalledWith(expect.objectContaining({ action: "reopen", data: { note: p.value.note } })); expect(host!.textContent).toContain("Pass decision recorded");
  });
  it.each(["pending", "unknown", "applied"] as const)("never invokes an action for %s delivery", delivery => {
    const p = props(); p.delivery = delivery; render(p); expect(button("Record final QC pass").disabled).toBe(true); click("Record final QC pass"); expect(p.onIntent).not.toHaveBeenCalled();
  });
  it("hides defect details and old draft fields after current source refusal", () => {
    const p = props(); p.defects = [{ id: "defect-private", summary: "Private fixture defect", state: "open" }]; p.context = { ...p.context, basisStatus: "unavailable" }; render(p);
    expect(host!.textContent).not.toContain("Private fixture defect"); expect(host!.querySelector("textarea")).toBeNull(); expect(p.onIntent).not.toHaveBeenCalled();
  });
  it("requires the new revision's draft and does not reuse old notes", () => {
    const p = props(); p.value = { ...p.value, note: "Old private draft" }; p.context = { ...p.context, basis: { ...p.context.basis!, reviewRevision: p.context.basis!.reviewRevision + 1 } }; render(p); expect(host!.textContent).not.toContain("Old private draft"); expect(host!.querySelector("textarea")).toBeNull(); click("Start a fresh review"); expect(p.onChange).toHaveBeenCalledWith(expect.objectContaining({ note: "", newDefects: [] }));
  });
  it("refuses a fail decision without the exact current submission", () => {
    const p = props(); p.context = { ...p.context, basis: { ...p.context.basis!, submissionId: null } }; p.value = { ...emptyQcDraft(p.context), note: "Fix corner", newDefects: [{ id: "draft-defect", summary: "Unsealed corner" }] };
    render(p); click("Record defects / fail QC"); expect(p.onIntent).not.toHaveBeenCalled();
  });
  it("displays open, claimed and verified corrections separately and only selects open defects", () => {
    const p = props(); p.state = "failed"; p.defects = [
      { id: "open", summary: "Lower corner gap", state: "open" },
      { id: "claimed", summary: "Claimed seal correction", state: "claimed_resolved" },
      { id: "verified", summary: "Reviewed hardware correction", state: "verified_resolved" },
    ]; render(p);
    expect(host!.textContent).toContain("Open — correction needed"); expect(host!.textContent).toContain("Claimed corrected — needs review"); expect(host!.textContent).toContain("Correction verified");
    expect(host!.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    p.value = { ...p.value, resolvedDefectIds: ["open"] }; render(p); click("Submit corrections for review");
    expect(p.onIntent).toHaveBeenCalledWith(expect.objectContaining({ action: "claim_resolved", data: expect.objectContaining({ defectIds: ["open"] }) }));
    expect(p.state).toBe("failed"); expect(host!.textContent).toContain("Some defects still need correction");
  });
  it("allows reviewer approval of actual claims while preserving their recorded state until confirmation", () => {
    const p = props(); p.defects = [{ id: "claimed", summary: "Seal corrected", state: "claimed_resolved" }]; render(p);
    expect(button("Record final QC pass").disabled).toBe(false); click("Record final QC pass");
    expect(p.onIntent).toHaveBeenCalledWith(expect.objectContaining({ action: "pass", data: { note: null } }));
    expect(host!.textContent).toContain("Claimed corrected — needs review"); expect(p.defects[0].state).toBe("claimed_resolved");
  });
  it("rejects existing correction claims with a reason and zero manufactured defects", () => {
    const p = props(); p.defects = [{ id: "claimed", summary: "Seal correction claimed", state: "claimed_resolved" }]; p.value = { ...p.value, note: "The seal still has a gap" }; render(p); click("Record defects / fail QC");
    expect(p.onIntent).toHaveBeenCalledWith(expect.objectContaining({ action: "fail", data: { note: "The seal still has a gap", defects: [] } })); expect(p.onChange).not.toHaveBeenCalled(); expect(host!.textContent).toContain("record a new defect or reject an existing claimed correction"); expect(host!.textContent).not.toContain("need at least one defect");
  });
  it("never labels an invalid correction state as verified", () => {
    const p = props(); p.defects = [{ id: "invalid", summary: "Corrupt state fixture", state: "legacy" as never }]; render(p);
    expect(host!.textContent).not.toContain("Correction verified"); expect(button("Record final QC pass").disabled).toBe(true); click("Record final QC pass"); expect(p.onIntent).not.toHaveBeenCalled();
  });
  it("shows Spanish refusal and disables an action when its permission is missing", () => {
    const p = props(); p.authority = { ...p.authority, pass: false }; render(p, "es"); expect(host!.textContent).toContain("Revisión final de calidad"); expect(button("Registrar aprobación final").disabled).toBe(true); click("Registrar aprobación final"); expect(p.onIntent).not.toHaveBeenCalled();
  });
});
