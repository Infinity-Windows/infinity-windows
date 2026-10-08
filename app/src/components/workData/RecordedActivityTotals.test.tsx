// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewAsRoleContext, createSensitivePreviewLifetime } from "../../lib/viewAsRoleContext";
import { rememberSignedIn } from "../../lib/signedIn";
import { parseTotalsReply } from "../../lib/workActivityTotals/protocol";
import corpus from "../../lib/workActivityTotals/__fixtures__/sourceMatchedWire.json";
import { RecordedActivityTotals } from "./RecordedActivityTotals";
import { LanguageContext } from "../../lib/i18n/context";
import { CATALOG } from "../../lib/i18n/catalog";
import { translate } from "../../lib/i18n/translate";
import contributorsCorpus from "../../lib/workUnitContributions/__fixtures__/sourceMatchedWire.json";
import { parseUnitContributorsReply } from "../../lib/workUnitContributions/protocol";
const api = vi.hoisted(() => ({ contributors: vi.fn(), profile: vi.fn(), catalog: vi.fn(), basis: vi.fn(), units: vi.fn(), totals: vi.fn() }));
vi.mock("../../lib/workUnitContributions/api", () => ({ fetchUnitContributors: api.contributors }));
vi.mock("../../lib/install/api", async importOriginal => ({ ...await importOriginal<typeof import("../../lib/install/api")>(), getRealProfile: api.profile }));
vi.mock("../../lib/workActivity/catalogApi", () => ({ fetchActivityCatalog: api.catalog }));
vi.mock("../../lib/workActivity/api", () => ({ fetchActivityUnitBasis: api.basis }));
vi.mock("../../lib/customWork/api", () => ({ listWorkUnits: api.units }));
vi.mock("../../lib/workActivityTotals/api", () => ({ fetchActivityTotals: api.totals }));
let language: "en" | "es" = "en";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const OWNER = corpus.calls[0].result.totals!.actorId, PROJECT = corpus.calls[0].result.totals!.projectId;
const UNIT = corpus.calls[1].result.totals!.unitId!;
const qcMissing = corpus.calls.findIndex(call => {
  const totals = call.result.totals, cohort = totals?.cohort;
  const reasons = cohort?.availability === "available" ? cohort.exclusions : undefined;
  return totals?.projectId === PROJECT && totals.unitId === UNIT
    && Array.isArray(reasons) && reasons.length === 1 && reasons[0] === "qc_not_current_accepted";
});
const basis = { id: UNIT, projectId: PROJECT, openingId: null, operationalRevision: 1, incarnationEpoch: 1, bindingEpoch: 1,
  projectEpoch: 1, openingEpoch: null, fact: null, eligibleForCapture: false, ineligibleReason: "missing_observation" };
let root: Root, host: HTMLDivElement, qc: QueryClient, preview: ReturnType<typeof createSensitivePreviewLifetime>, enabled: boolean, project: string, close: () => void;
function reply(index: number) {
  // The mocked transport binds the SQL quantities to this fixture login;
  // actual source/role enforcement belongs to the source-matched RPC tests.
  const raw = structuredClone(corpus.calls[index].result), t = raw.totals!;
  t.actorId = OWNER;
  return parseTotalsReply(raw, t.projectId, t.unitId, OWNER);
}
const register = (fn: () => void) => { close = fn; };
async function render() {
  await act(async () => root.render(<QueryClientProvider client={qc}><ViewAsRoleContext.Provider value={{ previewRole: null, previewPerson: null, canPreview: false, canPreviewPerson: false, setPreviewRole: () => {}, setPreviewPerson: () => {}, sensitiveLifetime: preview }}><LanguageContext.Provider value={{ lang: language, t: (key, vars) => translate(CATALOG, language, key, vars), setLang: () => {}, needsChoice: false }}><RecordedActivityTotals projectId={project} enabled={enabled} registerInvalidation={register} /></LanguageContext.Provider></ViewAsRoleContext.Provider></QueryClientProvider>));
}
async function tap(label: string) { await act(async () => { const button = [...host.querySelectorAll("button")].find(b => b.textContent === label); if (!button) throw Error(`Missing ${label}`); button.click(); }); }
async function unit(id = UNIT) { await act(async () => { const select = host.querySelector("select")!; select.value = id; select.dispatchEvent(new Event("change", { bubbles: true })); }); }
function held<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
beforeEach(() => {
  language = "en"; enabled = true; project = PROJECT; close = () => {};
  rememberSignedIn({ user: { id: OWNER } });
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["myRealProfile"], { id: OWNER, role: "supervisor", retired_at: null });
  preview = createSensitivePreviewLifetime(() => { const p = qc.getQueryState<{ id: string; role: string }>(["myRealProfile"]); return { stamp: JSON.stringify([p?.dataUpdateCount, p?.status, p?.isInvalidated]), ownerId: p?.data?.id ?? null, role: p?.data?.role ?? null, ready: p?.status === "success" && p.fetchStatus === "idle" && !p.isInvalidated }; }, false);
  const wire = structuredClone(contributorsCorpus.calls.find(row => row.label === "three_people_3_2_1_hours")!.reply);
  wire.contributors!.actorId = OWNER; wire.contributors!.projectId = PROJECT;
  wire.contributors!.unitId = UNIT; wire.contributors!.unitIncarnation = "1";
  api.contributors.mockReset().mockResolvedValue(parseUnitContributorsReply(wire,
    { actorId: OWNER, projectId: PROJECT, unitId: UNIT, unitIncarnation: "1" }));
  api.profile.mockReset().mockResolvedValue({ id: OWNER, role: "supervisor", retired_at: null });
  api.catalog.mockReset().mockImplementation(async (_job: string, selected: string | null) => ({ availability: "available", projectId: PROJECT, unit: selected ? basis : null }));
  api.basis.mockReset().mockResolvedValue({ availability: "available", unit: basis });
  api.units.mockReset().mockResolvedValue([{ id: UNIT, project_id: PROJECT, label: "Unit 42" }]);
  api.totals.mockReset().mockImplementation(async (_job: string, selected: string | null) => reply(selected ? 8 : 0));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); qc.clear(); host.remove(); rememberSignedIn(null); vi.useRealTimers(); });
describe("Data's read-only recorded totals", () => {
  it("keeps release OFF inert and never reads totals before a manual check", async () => { enabled = false; await render(); expect(host.textContent).toBe(""); expect(api.catalog).not.toHaveBeenCalled(); enabled = true; await render(); expect(host.textContent).toContain("No saved totals"); expect(api.totals).not.toHaveBeenCalled(); });
  it("reads only General at one check, with a separate all-retained window and no unit rate", async () => { await render(); await tap("Check totals"); expect(api.totals).toHaveBeenCalledOnce(); expect(api.totals.mock.calls[0].slice(0, 2)).toEqual([PROJECT, null]); expect(host.textContent).toContain("General activity labor"); expect(host.textContent).toContain("All retained work"); expect(host.textContent).toContain("Separate from the date-range"); expect(host.textContent).not.toContain("Verified rate"); expect(host.querySelector("details")?.open).toBe(false); expect(host.textContent).toContain("not additional unit or General labor"); });
  it("Specific without a unit never silently reads General totals", async () => { await render(); await tap("Specific"); expect(api.units).toHaveBeenCalledOnce(); expect(api.totals).not.toHaveBeenCalled(); expect(host.querySelector("select option[value='" + UNIT + "']")?.textContent).toBe("Unit 42"); });
  it("reads one canonical unit without requiring a clock and uses the server's eligible cohort", async () => { await render(); await tap("Specific"); await unit(); expect(api.totals).toHaveBeenCalledOnce(); expect(api.totals.mock.calls[0].slice(0, 2)).toEqual([PROJECT, UNIT]); expect(host.textContent).toContain("Selected unit activity labor"); expect(host.textContent).toContain("Verified rate — this unit only"); expect(host.textContent).toContain("labor hours per 100 sq ft"); expect(host.textContent).toContain("Floor area is unallocated"); expect(host.textContent).toContain("not a bid guarantee"); });
  it("does not turn missing/noncurrent QC evidence into a trusted rate", async () => { expect(qcMissing).toBeGreaterThanOrEqual(0); api.totals.mockResolvedValue(reply(qcMissing)); await render(); await tap("Specific"); await unit(); expect(host.textContent).toContain("verified rate is unavailable"); expect(host.textContent).toContain("Current final quality check is not accepted"); expect(host.textContent).not.toContain("labor hours per 100 sq ft"); });
  it("keeps partial zero-known coverage explicitly partial", async () => { api.totals.mockResolvedValue(reply(2)); await render(); await tap("Specific"); await unit(); expect(host.textContent).toContain("Partial — recorded subtotal"); expect(host.textContent).not.toContain("labor hours per 100 sq ft"); });
  it("unavailable contains no false zero and erases an earlier successful check", async () => { await render(); await tap("Check totals"); expect(host.querySelector("time")).not.toBeNull(); api.totals.mockResolvedValue({ protocolVersion: 1, availability: "unavailable", totals: null }); await tap("Check totals"); expect(host.querySelector("time")).toBeNull(); expect(host.textContent).toContain("Totals are unavailable"); expect(host.textContent).not.toContain("0:00:00"); });
  it("keeps machine time inside activity labor and historical labels/version", async () => { const data = reply(0); if (data.availability === "available") data.totals.activities[0].retired = true; api.totals.mockResolvedValue(data); await render(); await tap("Check totals"); expect(host.textContent).toContain("already included in its activity"); expect(host.textContent).toContain("Retired activity"); expect(host.textContent).toContain("Version 1"); });
  it("uses personal reconciliation headings when the server restricts payroll detail", async () => { api.totals.mockResolvedValue(reply(14)); await render(); await tap("Check totals"); expect(host.textContent).toContain("Your related shifts only"); expect(host.textContent).not.toContain("Authorized related shifts"); });
  it("rejects a unit that disappeared from the fresh same-job list", async () => { await render(); await tap("Specific"); api.units.mockResolvedValue([]); await unit(); expect(api.totals).not.toHaveBeenCalled(); expect(host.textContent).toContain("Totals are unavailable"); });
  it("rejects mismatched fresh unit bases rather than trusting the picker", async () => { api.basis.mockResolvedValue({ availability: "available", unit: { ...basis, bindingEpoch: 2 } }); await render(); await tap("Specific"); await unit(); expect(api.totals).not.toHaveBeenCalled(); });
  it("rejects foreign-job enumeration rather than trusting labels", async () => { api.units.mockResolvedValue([{ id: UNIT, project_id: "00000000-0000-4000-8000-000000999001", label: "Other job" }]); await render(); await tap("Specific"); expect(host.querySelectorAll("select option")).toHaveLength(1); expect(api.totals).not.toHaveBeenCalled(); });
  it("does not publish a slow read after General→Specific→General ABA", async () => { const old = held<ReturnType<typeof reply>>(); api.totals.mockReturnValueOnce(old.promise); await render(); await tap("Check totals"); await tap("Specific"); api.totals.mockResolvedValue({ protocolVersion: 1, availability: "unavailable", totals: null }); await tap("General"); await act(async () => old.resolve(reply(0))); expect(host.querySelector("time")).toBeNull(); expect(host.textContent).not.toContain("General activity labor"); });
  it("closes a delayed source read across raw preview ABA", async () => { const old = held<unknown>(); api.catalog.mockReturnValueOnce(old.promise); await render(); await tap("Check totals"); act(() => { preview.previewChanged(true); preview.previewChanged(false); }); await act(async () => old.resolve({ availability: "available", projectId: PROJECT, unit: null })); expect(api.totals).not.toHaveBeenCalled(); expect(host.textContent).not.toContain("Checking current records"); });
  it("closes same-user sign-out/in and does not publish a late totals response", async () => { const old = held<ReturnType<typeof reply>>(); api.totals.mockReturnValueOnce(old.promise); await render(); await tap("Check totals"); act(() => { rememberSignedIn(null); rememberSignedIn({ user: { id: OWNER } }); }); await act(async () => old.resolve(reply(0))); expect(host.querySelector("time")).toBeNull(); });
  it("clears totals and unit discovery for hidden/visible and offline/online ABA", async () => { await render(); await tap("Check totals"); act(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow")); }); expect(host.querySelector("time")).toBeNull(); await tap("Check totals"); act(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); }); expect(host.querySelector("time")).toBeNull(); });
  it("invalidates before a parent job change, and never exposes the old job's response", async () => { const old = held<ReturnType<typeof reply>>(); api.totals.mockReturnValueOnce(old.promise); await render(); await tap("Check totals"); act(() => { close(); project = "00000000-0000-4000-8000-000000999001"; }); await render(); await act(async () => old.resolve(reply(0))); expect(host.querySelector("time")).toBeNull(); });
  it("profile refresh invalidation erases data and does not restore it from stale profile data", async () => { await render(); await tap("Check totals"); act(() => { void qc.invalidateQueries({ queryKey: ["myRealProfile"], refetchType: "none" }); }); expect(host.querySelector("time")).toBeNull(); expect(api.totals).toHaveBeenCalledOnce(); });
  it("online profile refresh does not incorrectly tell the reader to reconnect", async () => { await render(); act(() => { void qc.invalidateQueries({ queryKey: ["myRealProfile"], refetchType: "none" }); }); await tap("Check totals"); expect(host.textContent).toContain("Try checking the current records again"); expect(host.textContent).not.toContain("Reconnect"); expect(api.totals).not.toHaveBeenCalled(); });
  it.each([["en", "new_server_exclusion"], ["es", "new_server_exclusion"], ["en", "constructor"], ["es", "constructor"], ["en", "toString"], ["es", "toString"]] as const)("uses catalog copy and a neutral unknown rate exclusion in %s / %s", async (lang, reason) => {
    language = lang;
    expect(qcMissing).toBeGreaterThanOrEqual(0);
    const data = reply(qcMissing);
    if (data.availability === "available" && data.totals.cohort.availability === "available") data.totals.cohort.exclusions = [reason];
    api.totals.mockResolvedValue(data); await render(); await tap(lang === "en" ? "Specific" : "Específico"); await unit();
    expect(host.textContent).toContain(lang === "en" ? "Not eligible for a verified rate" : "No elegible para un ritmo verificado");
    expect(host.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe(lang === "en" ? "Totals scope" : "Alcance de los totales");
    expect(host.textContent).not.toContain(reason); expect(host.textContent).not.toContain("wdata.totals.");
  });
  it("erases results and unit choices at the shared freshness deadline without polling", async () => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); await render(); await tap("Specific"); await unit(); expect(host.querySelector("time")).not.toBeNull(); act(() => vi.advanceTimersByTime(30001)); expect(host.querySelector("time")).toBeNull(); expect(host.querySelectorAll("select option")).toHaveLength(1); expect(api.totals).toHaveBeenCalledOnce(); });
  it("renders Spanish task/reconciliation labels and stays role-restricted", async () => { language = "es"; await render(); await tap("Revisar totales"); expect(host.textContent).toContain("Todo el trabajo conservado"); expect(host.textContent).toContain("Conciliación de turnos relacionados"); act(() => qc.setQueryData(["myRealProfile"], { id: OWNER, role: "foreman", retired_at: null })); expect(host.textContent).toBe(""); });
  it("checks contributor labor manually without an active clock, dimensions or accepted QC, even when totals are unavailable", async () => {
    api.totals.mockResolvedValue({ protocolVersion: 1, availability: "unavailable", totals: null });
    await render(); await tap("Specific"); await unit();
    expect(api.contributors).not.toHaveBeenCalled();
    await tap("Check current records");
    expect(api.contributors).toHaveBeenCalledOnce(); expect(host.textContent).toContain("6:00:00");
    expect(host.textContent).toContain("50.00%"); expect(host.textContent).toContain("Totals are unavailable");
    act(() => close()); expect(host.textContent).not.toContain("6:00:00");
    expect(api.contributors).toHaveBeenCalledOnce();
  });
  it("recovers a stale profile inside Data on one contributor Check without reviving old totals", async () => {
    await render(); await tap("Specific"); await unit();
    act(() => qc.setQueryData(["myRealProfile"], { id: OWNER, role: "supervisor", retired_at: null }, { updatedAt: Date.now() - 31000 }));
    await tap("Check current records");
    expect(api.profile).toHaveBeenCalledOnce(); expect(api.contributors).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("6:00:00"); expect(api.totals).toHaveBeenCalledOnce();
  });

});
