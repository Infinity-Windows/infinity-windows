// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LanguageContext, type LanguageContextValue } from "../../lib/i18n/context";
import { CATALOG } from "../../lib/i18n/catalog";
import { translate } from "../../lib/i18n/translate";

const m = vi.hoisted(() => ({
  fetch: vi.fn(), toggle: vi.fn(), user: "owner-a", generation: 1, online: true, preview: false,
  listeners: new Set<() => void>(),
}));
vi.mock("../../lib/values/api", () => ({ fetchValuesOwnerReport: m.fetch, setValuesSchedulerEnabled: m.toggle }));
vi.mock("../../lib/signedIn", () => ({
  signedInUserId: () => m.user, signInGeneration: () => m.generation,
  subscribeSignedIn: (cb: () => void) => { m.listeners.add(cb); return () => m.listeners.delete(cb); },
}));
vi.mock("../../lib/useEffectiveRole", () => ({ useEffectiveRole: () => ({ realRole: "owner", isPreviewing: m.preview }) }));
vi.mock("../../lib/offline/useWeakSignal", () => ({ useConnection: () => ({ online: m.online, weak: false }) }));
import { ValuesOwnerPage } from "./ValuesOwnerPage";

const report = (name: string) => ({ periodStart: "2026-10-01", schedulerEnabled: false, people: [{
  userId: "person", name, owedCount: 0, mirror: { byValue: {} },
  suspended: true, retired: false,
  asRater: { assigned: 6, accepted: 2, late: 1, pending: 2, canceled: 1, suspended: 1 },
  coverage: { expectedReceived: 2, actualReceived: 1, missingCoverage: true },
  received: [{
    raterName: "Private reviewer", raterClass: "worker", solo: false, periodStart: "2026-10-01", comment: "Private comment", scores: {},
  }],
}] });
let root: Root;
let host: HTMLDivElement;
let qc: QueryClient;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  m.fetch.mockReset(); m.toggle.mockReset(); m.listeners.clear();
  m.user = "owner-a"; m.generation = 1; m.online = true; m.preview = false;
  onlineManager.setOnline(true);
  m.fetch.mockResolvedValue(report("A person"));
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: "offlineFirst" } } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); qc.clear(); onlineManager.setOnline(true); });
async function render(lang: "en" | "es" = "en") {
  const language: LanguageContextValue = {
    lang, t: (key, vars) => translate(CATALOG, lang, key, vars),
    setLang: () => undefined, needsChoice: false,
  };
  await act(async () => root.render(<QueryClientProvider client={qc}><MemoryRouter><LanguageContext.Provider value={language}><ValuesOwnerPage /></LanguageContext.Provider></MemoryRouter></QueryClientProvider>));
}

it("shows owner lifecycle and coverage in compact English and Spanish at phone width", async () => {
  Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  await render("en");
  await vi.waitFor(() => expect(host.textContent).toContain("Coverage missing"));
  for (const word of ["Access suspended", "Not retired", "Assigned", "Accepted", "Late (of accepted)", "Pending", "Canceled", "Suspended reviews", "Received 1 of 2 expected reviews"]) expect(host.textContent).toContain(word);
  expect(host.querySelector("dl")?.textContent).toContain("Suspended reviews1");
  expect(host.querySelector("dl")?.getAttribute("style")).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
  await render("es");
  for (const word of ["Acceso suspendido", "No retirado", "Asignadas", "Aceptadas", "Tardías", "Pendientes", "Canceladas", "Revisiones suspendidas", "Recibió 1 de 2 revisiones esperadas", "Falta cobertura"]) expect(host.textContent).toContain(word);
  expect(host.querySelector("dl")?.textContent).toContain("Revisiones suspendidas1");
});

it("shows retirement without a misleading current-access status", async () => {
  const retired = report("Retired person");
  retired.people[0].retired = true;
  m.fetch.mockResolvedValue(retired);
  await render("en");
  await vi.waitFor(() => expect(host.textContent).toContain("Retired person"));
  expect(host.textContent).toContain("Retired");
  expect(host.textContent).not.toContain("Access suspended");
  expect(host.textContent).not.toContain("Access active");
});

it("hides cached named reviews when refetch pauses offline or owner previews crew", async () => {
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Private comment"));
  m.online = false; onlineManager.setOnline(false);
  await render();
  expect(host.textContent).not.toContain("Private comment");
  expect(host.textContent).toContain("unavailable");
  m.online = true; onlineManager.setOnline(true); m.preview = true;
  await render();
  expect(host.textContent).not.toContain("Private comment");
  expect(host.textContent).toContain("Owner access only");
});

it("never paints A's cached matrix during a B sign-in and ignores B's late answer", async () => {
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("A person"));
  let finishB!: (value: ReturnType<typeof report>) => void;
  m.fetch.mockImplementationOnce(() => new Promise((resolve) => { finishB = resolve; }));
  m.user = "owner-b"; m.generation = 2;
  await act(async () => { for (const cb of m.listeners) cb(); });
  expect(host.textContent).not.toContain("A person");
  m.user = "owner-a"; m.generation = 3;
  m.fetch.mockResolvedValue(report("A current"));
  await act(async () => { for (const cb of m.listeners) cb(); });
  await act(async () => finishB(report("B secret")));
  expect(host.textContent).not.toContain("B secret");
  await vi.waitFor(() => expect(host.textContent).toContain("A current"));
});
