import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useIsRestoring, useQuery, useQueryClient } from "@tanstack/react-query";
import { SelectedJobWork } from "./SelectedJobWork";
import { ClockStrip } from "../../components/work/ClockStrip";
import { TodayCard } from "../../components/work/TodayCard";
import { LiveSummonsStrip } from "../../components/install/LiveSummonsStrip";
import { CrewGoalCard } from "../../components/projects/CrewGoalCard";
import { LeadRow } from "../../components/work/LeadRow";
import { DailyLogDialog } from "../../components/dailyLogs/DailyLogDialog";
import { ReportProblemSheet } from "../../components/work/ReportProblemSheet";
import { useClock, openClockGlobally } from "../../lib/clockContext";
import { useLanguage, useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import "../../lib/i18n/paidClockCatalog";
import { listProjects } from "../../lib/api";
import { getClockCostCodesForProject } from "../../lib/costCodes";
import { listRecentJobs } from "../../lib/timeclock";
import { listMyPublished } from "../../lib/schedule/api";
import { addDaysISO } from "../../lib/schedule/dates";
import { pickTodayEntries } from "../../lib/work/today";
import { getMyProfile } from "../../lib/install/api";
import { isForemanPlus } from "../../lib/install/types";
import { signedInUserId, signInGeneration, subscribeSignedIn } from "../../lib/signedIn";
import { useViewAsRole } from "../../lib/viewAsRoleContext";
import { createUnitReviewSelectionSource } from "../../lib/workUnitReview/useUnitReviewCoordinator";
import { useSelectedJobWorkGate } from "../../lib/workActivity/selectedJobWorkGate";
import { useSelectedJobPreference } from "../../lib/workActivity/selectedJobPreference";
import { useRouteJobUnits } from "../../lib/workActivity/useRouteJobUnits";
import { useRouteRead } from "../../lib/workActivity/useRouteRead";
import { routePaidSeconds } from "../../lib/workActivity/routePaidSeconds";
import { useTodayTalk, useToolboxToday, useLocalDay } from "../../lib/useToolboxGate";
import { getCompanySettings } from "../../lib/companySettings";
import { paidTimeRuleActive } from "../../lib/paidTimeRule";
import { localDateISO } from "../../lib/dailyLogDay";
import { canUseDailyLogs } from "../../lib/dailyLogAccess";
import { useSafeSurface } from "../../lib/pwa/useSafeSurface";
import "./work.css";

const copy = {
  en: {
    title: "Select a job",
    help: "Pick the job you're working on now. The scheduled job is listed first; nothing is chosen until you tap it.",
    scheduled: "Today's scheduled job",
    recent: "Recently worked",
    allJobs: "All jobs",
    search: "Search jobs",
    noMatch: "No job matches your search.",
    change: "Change job",
    dormantTitle: "Not turned on yet",
    dormantHelp: "This job's activity view isn't available here yet. Your clock, schedule and Ask stay working below.",
    unavailable: "Job information is unavailable. Refresh to try again.",
  },
  es: {
    title: "Selecciona un trabajo",
    help: "Elige el trabajo en el que estás ahora. El trabajo programado aparece primero; no se elige nada hasta que lo toques.",
    scheduled: "Trabajo programado de hoy",
    recent: "Trabajado recientemente",
    allJobs: "Todos los trabajos",
    search: "Buscar trabajos",
    noMatch: "Ningún trabajo coincide con tu búsqueda.",
    change: "Cambiar de trabajo",
    dormantTitle: "Aún no está activado",
    dormantHelp: "La vista de actividad de este trabajo aún no está disponible aquí. Tu reloj, horario y Preguntar siguen funcionando abajo.",
    unavailable: "La información del trabajo no está disponible. Actualiza para intentarlo de nuevo.",
  },
} as const;

export function SelectedJobWorkRoute() {
  const owner = useSyncExternalStore(subscribeSignedIn, signedInUserId, () => null);
  const generation = useSyncExternalStore(subscribeSignedIn, signInGeneration, () => 0);
  const preview = useViewAsRole();
  const disabled = Boolean(preview.previewPerson || preview.previewRole);
  // Remount on login ABA/preview so no prior person's selection survives.
  return <SelectedJobWorkRouteBody key={`${owner}:${generation}:${disabled}`} owner={owner} generation={generation} previewDisabled={disabled} />;
}

function SelectedJobWorkRouteBody({owner, generation, previewDisabled}: {owner: string | null; generation: number; previewDisabled: boolean}) {
  const t = useT(), { lang } = useLanguage(), c = copy[lang === "es" ? "es" : "en"];
  const navigate = useNavigate(), qc = useQueryClient(), clock = useClock();
  const [reviewSource] = useState(createUnitReviewSelectionSource);
  const closeReview = () => reviewSource.invalidate();
  const go = (path: string) => { closeReview(); navigate(path); };
  useLayoutEffect(() => {
    const close = () => reviewSource.invalidate();
    const link = (event: MouseEvent) => { if (event.target instanceof Element && event.target.closest("a[href]")) close(); };
    const focus = (event: FocusEvent) => { if (event.target === window) close(); };
    window.addEventListener("popstate", close);
    // Close before useRouteRead starts its focus-driven job/unit refresh.
    window.addEventListener("focus", focus, true);
    document.addEventListener("click", link, true);
    return () => { close(); window.removeEventListener("popstate", close); window.removeEventListener("focus", focus, true); document.removeEventListener("click", link, true); };
  }, [reviewSource]);
  useSafeSurface();
  const rollout = useSelectedJobWorkGate();
  const allowed = rollout && !!owner && !previewDisabled;
  const me = useRouteRead("profile", allowed, getMyProfile);
  const profileId = me.data?.id === owner ? owner : null;
  const projects = useRouteRead("projects", allowed && !!profileId, listProjects);
  const rows = projects.data ?? [];
  const pref = useSelectedJobPreference(owner ? `${owner}:${generation}` : null, projects.state === "ready" ? rows.map(p => p.id) : null);
  const project = rows.find(p => p.id === pref.jobId) ?? null;
  const today = useLocalDay(), through = addDaysISO(today, 7);
  const readSchedule = useCallback(() => listMyPublished(profileId!, today, through), [profileId, today, through]);
  const schedule = useRouteRead(`schedule:${today}`, allowed && !!profileId, readSchedule);
  const pick = useMemo(() => pickTodayEntries(schedule.data ?? [], profileId ?? "", today, through), [schedule.data, profileId, today, through]);
  const readRecent = useCallback(() => listRecentJobs(profileId!), [profileId]);
  const recents = useRouteRead("recents", allowed && !!profileId, readRecent);
  // Recommendations are intersected with freshly authorized jobs; no schedule
  // label, saved copy or recommendation can select/authorize a project.
  const scheduledId = pick.entries.find(e => e.project_id)?.project_id ?? null;
  const priority = [...new Set([scheduledId, ...(recents.data ?? []).map(r => r.projectId)])];
  const sorted = [...rows].sort((a, b) => {
    const ai = priority.indexOf(a.id), bi = priority.indexOf(b.id);
    return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || a.name.localeCompare(b.name);
  });
  const [search, setSearch] = useState("");
  const filtered = sorted.filter(p => `${p.job_code} ${p.name}`.toLowerCase().includes(search.trim().toLowerCase()));
  const unitRead = useRouteJobUnits(project?.id ?? null, allowed && !!project);
  const readCodes = useCallback(() => getClockCostCodesForProject(project!.id), [project?.id]);
  const codes = useRouteRead(`codes:${project?.id}`, allowed && !!project, readCodes);
  const [costPick, setCostPick] = useState<{job: string; id: string} | null>(null);
  const costId = costPick && costPick.job === project?.id && codes.data?.some(c => c.id === costPick.id && c.active) ? costPick.id : null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const paid = routePaidSeconds(previewDisabled ? null : clock.nativeFlow ?? null, now, {userId: owner, generation});
  const native = clock.nativeFlow;
  const freshClock = !previewDisabled && !!owner && native?.ownerId === owner && native.loginGeneration === generation && native.currentRead === "ready";
  const observedShift = native?.current?.shift;
  const currentShift = (freshClock || paid.stale) && observedShift?.profile_id === owner && observedShift.clock_out_at === null ? observedShift : null;
  const restoring = useIsRestoring();
  const talk = useTodayTalk(), toolbox = useToolboxToday(profileId);
  const settings = useQuery({queryKey: ["companySettings"], queryFn: getCompanySettings});
  const gate = {talkExists: talk.isSuccess ? talk.data !== null : null,
    signedToday: toolbox.isSuccess ? !!toolbox.data : null, ruleActive: paidTimeRuleActive(settings.data, today)};
  const refreshClock = () => { closeReview(); clock.refresh(); void qc.invalidateQueries({queryKey: ["openShift"]}); };
  // Dialog drafts belong to this login and explicit job, not a read observer.
  // A foreground refetch must not unmount and erase a worker's unsaved text.
  const [logFor, setLogFor] = useState<{id: string; name: string} | null>(null);
  const [problemFor, setProblemFor] = useState<string | null>(null);
  const sourceReady = allowed && projects.state === "ready" && !!profileId;
  return <div className="page work-screen sjwr" data-testid="selected-job-work-route" onClickCapture={event => {
      // Covers local saved-unit/Ask/Schedule links before React Router navigates.
      if (event.target instanceof Element && event.target.closest("a[href]")) closeReview();
    }}>
    <LiveSummonsStrip />
    <ClockStrip nativeFlow={previewDisabled ? null : native} profileId={profileId ?? owner ?? ""} shift={currentShift}
      clockKnown={freshClock && !clock.loading && !restoring} todayJobId={null}
      scheduleSettled={schedule.state === "ready" || schedule.state === "unavailable"}
      talk={talk.data ?? null} gate={gate} toolboxDone={toolbox} onShiftChanged={refreshClock} />
    <nav className="sjwr-navigation" aria-label={t("work.title")}>
      <button className="ws-btn" onClick={() => { closeReview(); openClockGlobally(); }}>{t("work.clock.moreOptions")}</button>
      <Link className="ws-btn" to="/my-schedule">{lang === "es" ? "Horario" : "Schedule"}</Link>
      <Link className="ws-btn" to="/ask">{lang === "es" ? "Preguntar" : "Ask"}</Link>
    </nav>
    {!project ? <section className="ws-card" aria-label={c.title} data-testid="sjwr-picker">
      <h1 className="ws-h2">{c.title}</h1><p className="ws-meta">{c.help}</p>
      <label className="ws-search"><input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={c.search} aria-label={c.search} /></label>
      {!sourceReady && <p role="status" className="ws-meta">{projects.state === "loading" && allowed ? t("crewStart.loading") : c.unavailable}</p>}
      <div className="ws-list">{filtered.map(p => <button key={p.id} className="ws-list-item" disabled={!sourceReady}
        onClick={() => { closeReview(); pref.pick(p.id); setCostPick(null); }}>
        <span className="ws-list-code">{p.job_code}</span><span className="ws-list-name">{p.name}</span>
        {p.id === scheduledId && <small>{c.scheduled}</small>}
      </button>)}</div>
      {sourceReady && filtered.length === 0 && <p className="ws-meta">{c.noMatch}</p>}
    </section> : <>
      <button className="ws-btn" data-testid="sjwr-change-job" onClick={() => { closeReview(); pref.clear(); setCostPick(null); setLogFor(null); setProblemFor(null); }}>{c.change}</button>
      <section className="ws-card">
        <label className="ws-label" htmlFor="sjwr-cost">{lang === "es" ? "Código de costo para completar configuración" : "Cost code to finish setup"}</label>
        <select id="sjwr-cost" value={costId ?? ""} disabled={codes.state !== "ready"} onChange={e => setCostPick({job: project.id, id: e.target.value})}>
          <option value="">{lang === "es" ? "Seleccionar código" : "Select cost code"}</option>
          {(codes.data ?? []).filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.code} · {c.label}</option>)}
        </select>
      </section>
      {paid.stale && <p role="status" className="ws-meta">{t("paidClock.staleHelp")}</p>}
      {unitRead.state !== "ready" && <p role="status" className="ws-meta">{c.unavailable}</p>}
      <SelectedJobWork reviewSource={reviewSource} project={{id: project.id, name: project.name, code: project.job_code}}
        units={unitRead.units} featureEnabled={sourceReady && freshClock && unitRead.state === "ready"}
        previewDisabled={previewDisabled} paidSeconds={paid.stale ? null : paid.seconds}
        setupAllocation={freshClock && native?.current?.kind === "open" && costId ? {projectId: project.id, costCodeId: costId} : null}
        onAddUnit={() => go(`/current-work?job=${project.id}&new_unit=1`)}
        onOpenClock={() => { closeReview(); openClockGlobally(); }} onBreak={() => { closeReview(); openClockGlobally(); }} onClockOut={() => { closeReview(); openClockGlobally(); }}
        onSchedule={() => go("/my-schedule")} onAsk={() => go("/ask")} />
      <CrewGoalCard projectId={project.id} />
      <section className="ws-card" aria-label={t("work.unit.savedUnits")}>
        <h2 className="ws-h2">{t("work.unit.savedUnits")}</h2>
        {unitRead.units.map(u => <Link key={u.id} className="ws-saved-unit" to={`/current-work?job=${project.id}&unit=${u.id}`}>{u.label} · {u.detail}</Link>)}
        <Link className="ws-btn" to={`/current-work?job=${project.id}`}>{t("work.unit.allUnits")}</Link>
      </section>
      <div className="ws-quick">
        <Link className="ws-btn" to="/supplies">{t("work.quick.supplies")}</Link>
        <Link className="ws-btn" to={`/photos?job=${project.id}`}>{lang === "es" ? "Fotos" : "Photos"}</Link>
        {canUseDailyLogs(me.data?.role) && <button className="ws-btn" onClick={() => setLogFor({id: project.id, name: project.name})}>{t("work.quick.log")}</button>}
        <button className="ws-btn" onClick={() => setProblemFor(project.id)}>{t("work.quick.problem")}</button>
      </div>
    </>}
    {logFor && <DailyLogDialog projectId={logFor.id} logDate={localDateISO()} jobLabel={logFor.name} onClose={() => setLogFor(null)} />}
    {problemFor && <ReportProblemSheet open onClose={() => setProblemFor(null)} projectId={problemFor} openingId={null} unitLabel={null} />}
    {profileId && <TodayCard meId={profileId} todayISO={today} pick={pick} now={now}
      query={{data: schedule.data, isError: schedule.state === "unavailable", isPending: schedule.state === "loading", fetchStatus: schedule.state === "loading" ? "fetching" : "idle", dataUpdatedAt: 0}} />}
    {isForemanPlus(me.data?.role) && <><LeadRow role={me.data?.role} /><Link className="ws-btn" to="/current-work">{lang === "es" ? "Registrar trabajo del equipo" : "Record crew work"}</Link></>}
  </div>;
}
