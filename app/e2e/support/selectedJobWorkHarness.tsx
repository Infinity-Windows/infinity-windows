// Isolated browser fixture: real component, auth-bound readers, device and native journal.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SelectedJobWork } from "../../src/pages/work/SelectedJobWork";
import { LanguageContext } from "../../src/lib/i18n/context";
import { CATALOG } from "../../src/lib/i18n/catalog";
import { translate, type Lang } from "../../src/lib/i18n/translate";
import { rememberSignedIn, signInMark, stillSignedInAs } from "../../src/lib/signedIn";
import { AUTH_STORAGE_KEY } from "../../src/lib/supabase";
import { enqueueWork, readWorkQueue, syncWork, WORK_QUEUE_EVENT } from "../../src/lib/customWork/queue";
import { getWorkUnit } from "../../src/lib/customWork/api";
import type { WorkUnit } from "../../src/lib/customWork/model";

const OWNER = "00000000-0000-4000-8000-0000000000e2";
const PROJECT = "00000000-0000-4000-8000-000000000301";
const OTHER = "00000000-0000-4000-8000-000000000399";
const UNIT = "00000000-0000-4000-8000-000000000309";
if (localStorage.getItem(AUTH_STORAGE_KEY)) rememberSignedIn({ user: { id: OWNER } });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
(window as Window & { readPrivateCache?: () => unknown }).readPrivateCache = () => queryClient.getQueryCache().getAll()
  .filter((query) => query.queryKey[0] === "workActivityPrivate" || query.queryKey[0] === "workUnitFactCurrent")
  .map((query) => ({ key: query.queryKey, data: query.state.data }));

export function Harness() {
  const [locale, setLocale] = useState<Lang>("en");
  const [mount, setMount] = useState(0);
  const [projectId, setProjectId] = useState(PROJECT);
  const [preview, setPreview] = useState(false);
  const [active, setActive] = useState(true);
  const [controls, setControls] = useState<string[]>([]);
  const [units, setUnits] = useState<WorkUnit[]>([{ id: UNIT, project_id: PROJECT, opening_id: null,
    created_by: OWNER, label: "Unit 12", type_label: "Aluminum", revision: 5,
    facts: { width_in: 10, height_in: 20, note: "Keep original note" },
    created_at: "2026-10-04T00:00:00Z", updated_at: "2026-10-04T00:00:00Z" }]);
  const [pendingUnitIds, setPendingUnitIds] = useState<string[]>([]);
  useEffect(() => {
    const read = () => setPendingUnitIds(readWorkQueue(OWNER).filter((row) => row.action === "unit").map((row) => String(row.data.id)));
    read(); window.addEventListener(WORK_QUEUE_EVENT, read);
    return () => window.removeEventListener(WORK_QUEUE_EVENT, read);
  }, []);
  const refreshUnits = async () => {
    const mark = signInMark(), unit = await getWorkUnit(UNIT);
    if (stillSignedInAs(mark, OWNER)) setUnits(unit ? [unit] : []);
  };
  const control = (name: string) => () => setControls((old) => [...old, name]);
  return <LanguageContext.Provider value={{
    lang: locale, t: (key, vars) => translate(CATALOG, locale, key, vars),
    setLang: setLocale, needsChoice: false,
  }}>
    <style>{`html,body,#root{margin:0;min-width:0;width:100%;font-family:system-ui;background:#f3f6f3}
      *,*::before,*::after{box-sizing:border-box}button,input,select{font:inherit}
      /* Keep fixture-only controls below the product's fixed clock, including
         WebKit's scroll-into-view positioning. Ordinary clicks remain required. */
      .fixture-controls{display:flex;flex-wrap:wrap;gap:.35rem;padding:64px .4rem .4rem}
      .fixture-controls button{min-height:42px;scroll-margin-top:64px}.fixture-results{padding:.4rem;overflow-wrap:anywhere}`}</style>
    <div className="fixture-controls">
      <button type="button" onClick={() => setLocale(locale === "en" ? "es" : "en")}>Change language</button>
      <button type="button" onClick={() => setMount((n) => n + 1)}>Remount Work</button>
      <button type="button" onClick={() => setProjectId(projectId === PROJECT ? OTHER : PROJECT)}>Change job</button>
      <button type="button" onClick={() => setActive(!active)}>{active ? "Leave Work" : "Return to Work"}</button>
      <button type="button" onClick={() => setPreview(!preview)}>Toggle preview</button>
      <button type="button" onClick={() => { localStorage.removeItem(AUTH_STORAGE_KEY); rememberSignedIn(null); }}>Log out</button>
      <button type="button" onClick={() => void syncWork(OWNER)}>Retry saved unit requests</button>
    </div>
    <SelectedJobWork key={mount} project={{ id: projectId,
      name: "A deliberately long synthetic project name for selected-job phone layout checks", code: "E2E-FIXTURE" }}
      units={[{ id: UNIT, label: "Unit 12, long aluminum assembly", detail: "Third floor" }]}
      featureEnabled={active} previewDisabled={preview} paidSeconds={null} setupAllocation={null}
      dimensionEntry={{ units, unitSourceState: "ready", canEditDimensions: true, pendingUnitIds,
        onSave: async (data) => {
          const mark = signInMark();
          if (!stillSignedInAs(mark, OWNER)) throw new Error("Fixture account changed");
          await enqueueWork({ id: crypto.randomUUID(), userId: OWNER, action: "unit", data: { ...data } });
          await syncWork(OWNER);
        }, onRefreshUnits: refreshUnits }}
      onAddUnit={control("add")} onOpenClock={control("clock")} onBreak={control("break")}
      onClockOut={control("out")} onSchedule={control("schedule")} onAsk={control("ask")} />
    <output className="fixture-results" data-testid="controls-json">{JSON.stringify(controls)}</output>
  </LanguageContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
