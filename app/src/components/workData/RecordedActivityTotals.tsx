import { lazy, Suspense, useCallback, useLayoutEffect, useReducer, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLanguage, useT } from "../../lib/i18n";
import "../../lib/i18n/workDataCatalog";
import type { WorkDataKey } from "../../lib/i18n/workDataCatalog";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { roleRank } from "../../lib/nav";
import { useViewAsRole } from "../../lib/viewAsRoleContext";
import { signInMark, stillSignedInAs, subscribeSignedIn } from "../../lib/signedIn";
import type { getRealProfile } from "../../lib/install/api";
import { listWorkUnits } from "../../lib/customWork/api";
import { fetchActivityCatalog } from "../../lib/workActivity/catalogApi";
import { fetchActivityUnitBasis } from "../../lib/workActivity/api";
import { activityUuid } from "../../lib/workActivity/protocol";
import { createUnitReviewSelectionSource, REVIEW_FRESH_MS } from "../../lib/workUnitReview/selection";
import { useActivityTotals } from "../../lib/workActivityTotals/useActivityTotals";
import { durationMicros, trustedUnitRate } from "../../lib/workActivityTotals/format";
import type { TotalsView } from "../../lib/workActivityTotals/protocol";
import "./RecordedActivityTotals.css";

const Contributors = lazy(async () => ({ default: (await import("../../pages/work/SelectedUnitContributors")).SelectedUnitContributors }));

const exclusionKeys: Record<string, WorkDataKey> = {
  "coverage_incomplete": "wdata.totals.exclusion.coverage_incomplete",
  "unclassified_coverage": "wdata.totals.exclusion.unclassified_coverage",
  "payroll_not_trusted": "wdata.totals.exclusion.payroll_not_trusted",
  "dimensions_unverified": "wdata.totals.exclusion.dimensions_unverified",
  "qc_not_current_accepted": "wdata.totals.exclusion.qc_not_current_accepted",
  "active_or_rework": "wdata.totals.exclusion.active_or_rework",
  "no_attributed_labor": "wdata.totals.exclusion.no_attributed_labor",
  "area_unknown": "wdata.totals.exclusion.area_unknown"
};
const machineKeys: Record<string, WorkDataKey> = {
  "forklift": "wdata.totals.machine.forklift",
  "tele_handler": "wdata.totals.machine.tele_handler",
  "scissor_lift": "wdata.totals.machine.scissor_lift",
  "spider_suction": "wdata.totals.machine.spider_suction"
};
type Scope = "general" | "specific";
interface Proof { epoch: number; projectId: string; unitId: string | null; current: () => boolean }
interface Discovery { current: () => boolean; units: { id: string; label: string }[] }
interface Props { projectId: string; enabled: boolean; registerInvalidation?: (close: () => void) => void }

/** A manual, read-only Data surface. It never mounts a clock or the all-job
 * synchronization loop, and it never converts aggregate totals into intervals. */
export function RecordedActivityTotals({ projectId, enabled, registerInvalidation }: Props) {
  const { lang } = useLanguage(), language = lang === "es" ? "es" : "en", t = useT();
  const role = useEffectiveRole(), preview = useViewAsRole().sensitiveLifetime, qc = useQueryClient();
  const [source] = useState(createUnitReviewSelectionSource);
  const [scope, setScope] = useState<Scope>("general"), [unitId, setUnitId] = useState("");
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [status, setStatus] = useState<"held" | "loading" | "choose" | "ready" | "unavailable">("held");
  const [, paint] = useReducer(n => n + 1, 0);
  const lifetime = useRef({ epoch: 0, alive: true, proof: null as Proof | null });
  const deadline = useRef<number | null>(null);
  const humanSelection = useRef(0);
  const selection = useRef({ projectId, scope, unitId, enabled });
  // Reads test the live selection at every await boundary, including before
  // React commits a rapidly changed picker or a same-ID resource refresh.
  useLayoutEffect(() => { selection.current = { projectId, scope, unitId, enabled }; });
  const invalidate = useCallback(() => {
    if (deadline.current !== null) window.clearTimeout(deadline.current);
    lifetime.current.epoch++; lifetime.current.proof = null; source.invalidate(); setStatus("held"); setDiscovery(null); paint();
  }, [source]);
  useLayoutEffect(() => {
    const currentLifetime = lifetime.current;
    currentLifetime.alive = true;
    registerInvalidation?.(invalidate);
    const close = () => invalidate();
    const profileClose = qc.getQueryCache().subscribe(event => {
      if ((event.type === "updated" || event.type === "removed") && JSON.stringify(event.query.queryKey) === '["myRealProfile"]') close();
    });
    const authClose = subscribeSignedIn(close), previewClose = preview?.subscribe(close);
    const link = (event: MouseEvent) => { if (event.target instanceof Element && event.target.closest("a[href]")) close(); };
    for (const event of ["online", "offline", "pagehide", "pageshow", "popstate", "focus"]) window.addEventListener(event, close);
    document.addEventListener("visibilitychange", close); document.addEventListener("click", link, true);
    return () => {
      if (deadline.current !== null) window.clearTimeout(deadline.current);
      currentLifetime.alive = false; currentLifetime.epoch++; currentLifetime.proof = null; source.invalidate();
      registerInvalidation?.(() => {}); profileClose(); authClose(); previewClose?.();
      for (const event of ["online", "offline", "pagehide", "pageshow", "popstate", "focus"]) window.removeEventListener(event, close);
      document.removeEventListener("visibilitychange", close); document.removeEventListener("click", link, true);
    };
  }, [invalidate, preview, qc, registerInvalidation, source]);
  const admitted = () => {
    const proof = lifetime.current.proof;
    return !!proof && proof.epoch === lifetime.current.epoch && proof.projectId === projectId
      && proof.unitId === (scope === "specific" ? unitId || null : null) && proof.current();
  };
  const totals = useActivityTotals(projectId, scope === "specific" ? unitId || null : null, source, admitted, lifetime.current.proof?.epoch ?? -1);

  async function check(nextScope: Scope = scope, nextUnit = unitId) {
    invalidate(); setDiscovery(null); setStatus("loading");
    const epoch = lifetime.current.epoch, started = performance.now(), login = signInMark();
    deadline.current = window.setTimeout(() => { if (lifetime.current.epoch === epoch) invalidate(); }, REVIEW_FRESH_MS);
    const profile = qc.getQueryState<Awaited<ReturnType<typeof getRealProfile>>>(["myRealProfile"]);
    const profileData = profile?.data, previewRevision = preview?.getSnapshot();
    const fresh = () => {
      const p = qc.getQueryState<Awaited<ReturnType<typeof getRealProfile>>>(["myRealProfile"]), live = selection.current;
      return lifetime.current.alive && lifetime.current.epoch === epoch && live.enabled && live.projectId === projectId
        && live.scope === nextScope && live.unitId === nextUnit && !!login.userId && stillSignedInAs(login, login.userId)
        && navigator.onLine !== false && document.visibilityState !== "hidden" && performance.now() - started < REVIEW_FRESH_MS
        && !!preview && preview.getSnapshot() === previewRevision && !!profileData && profileData.id === login.userId
        && !profileData.retired_at && roleRank(profileData.role) >= roleRank("supervisor") && preview.admitted(login.userId, profileData.role)
        && p?.data === profileData && p.status === "success" && p.fetchStatus === "idle" && !p.isInvalidated;
    };
    try {
      activityUuid(projectId); if (!fresh()) throw Error("held");
      // Even General proves this exact job through a fresh, token-bound RPC.
      const catalog = await fetchActivityCatalog(projectId, nextScope === "specific" && nextUnit ? nextUnit : null, login);
      if (!fresh() || catalog.availability !== "available" || catalog.projectId !== projectId) throw Error("held");
      if (nextScope === "specific") {
        const rows = await listWorkUnits(projectId);
        if (!fresh() || rows.some(row => row.project_id !== projectId)) throw Error("held");
        const units = rows.map(row => ({ id: activityUuid(row.id), label: row.label }));
        if (new Set(units.map(row => row.id)).size !== units.length) throw Error("held");
        setDiscovery({ current: fresh, units });
        if (!nextUnit) { setStatus("choose"); return; }
        if (!units.some(row => row.id === nextUnit)) throw Error("held");
        const basis = await fetchActivityUnitBasis(nextUnit, login);
        if (!fresh() || basis.availability !== "available" || basis.unit.projectId !== projectId
          || catalog.unit?.id !== nextUnit || JSON.stringify(catalog.unit) !== JSON.stringify(basis.unit)) throw Error("held");
        lifetime.current.proof = { epoch, projectId, unitId: nextUnit, current: fresh };
        source.select({ login, realRole: profileData!.role, selectedJobId: projectId, selectedUnitId: nextUnit,
          binding: { projectId: basis.unit.projectId, unitId: basis.unit.id }, admitted: fresh });
      } else lifetime.current.proof = { epoch, projectId, unitId: null, current: fresh };
      if (!fresh()) throw Error("held");
      setStatus("ready"); paint();
    } catch {
      if (lifetime.current.alive && lifetime.current.epoch === epoch) { lifetime.current.proof = null; source.invalidate(); setDiscovery(null); setStatus("unavailable"); }
    }
  }
  const selectScope = (next: Scope) => {
    humanSelection.current++;
    selection.current = { projectId, scope: next, unitId: "", enabled }; setScope(next); setUnitId(""); void check(next, "");
  };
  const selectUnit = (next: string) => {
    humanSelection.current++;
    selection.current = { projectId, scope, unitId: next, enabled }; setUnitId(next); void check(scope, next);
  };
  const allowed = enabled && !role.isLoading && !role.isPreviewing && roleRank(role.realRole) >= roleRank("supervisor")
    && roleRank(role.effectiveRole) >= roleRank("supervisor") && !!preview && !preview.hasPreview();
  if (!allowed) return null;
  const units = discovery?.current() ? discovery.units : [];
  const view = admitted() ? totals.data : null;
  const checking = status === "loading" || (admitted() && totals.state === "loading");
  return <section className="work-data-card recorded-totals" aria-label={t("wdata.totals.title")}>
    <h2>{t("wdata.totals.title")}</h2><p className="muted">{t("wdata.totals.window")}. {t("wdata.totals.dates")}</p>
    <div role="group" aria-label={t("wdata.totals.scopePicker")} className="recorded-totals-switch">
      <button type="button" aria-pressed={scope === "general"} onClick={() => selectScope("general")}>{t("wdata.totals.general")}</button>
      <button type="button" aria-pressed={scope === "specific"} onClick={() => selectScope("specific")}>{t("wdata.totals.specific")}</button>
    </div>
    {scope === "specific" && <><p>{t("wdata.totals.unitHelp")}</p><label>{t("wdata.totals.choose")}<select value={unitId} onChange={event => selectUnit(event.target.value)}>
      <option value="">{t("wdata.totals.choose")}</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.label}</option>)}
    </select></label></>}
    <button type="button" onClick={() => void check()}>{t("wdata.totals.check")}</button>
    {checking && <p role="status">{t("wdata.totals.checking")}</p>}
    {!view && !checking && <p role="status">{scope === "specific" && !unitId && status === "choose" ? t("wdata.totals.choose") : status === "unavailable" || totals.state === "unavailable" ? t("wdata.totals.failed") : t("wdata.totals.held")}</p>}
    {view && <RecordedTotalsResult view={view} language={language} />}
    <Suspense fallback={<p role="status">{language === "es" ? "Cargando colaboradores…" : "Loading contributors…"}</p>}>
      <Contributors projectId={projectId} unitId={scope === "specific" ? unitId || null : null} locale={language}
        enabled={allowed && scope === "specific" && !!unitId} invalidationSource={source}
        selectionRevision={JSON.stringify([projectId, scope, unitId, humanSelection.current])}
        admitted={() => {
          const live = selection.current;
          return lifetime.current.alive && live.enabled && live.projectId === projectId
            && live.scope === "specific" && live.unitId === unitId && !!unitId;
        }} />
    </Suspense>
  </section>;
}

function RecordedTotalsResult({ view, language }: { view: TotalsView; language: "en" | "es" }) {
  const t = useT(), r = view.reconciliation, cohort = view.cohort, rate = trustedUnitRate(cohort);
  const partial = (complete: boolean, value: string) => `${complete ? "" : `${t("wdata.totals.partial")}: `}${durationMicros(value)}`;
  return <>
    <p className="muted"><time dateTime={view.asOf}>{new Date(view.asOf).toLocaleString(language)}</time></p>
    <h3>{view.unitId === null ? t("wdata.totals.totalGeneral") : t("wdata.totals.totalUnit")}</h3>
    <dl className="recorded-totals-metrics"><div><dt>{t("wdata.totals.authorized")}</dt><dd>{partial(view.complete, view.scopeKnownMicros)}</dd></div>
      <div><dt>{t("wdata.totals.personal")}</dt><dd>{partial(view.personalComplete, view.personalKnownMicros)}</dd></div></dl>
    {!view.activities.length && <p>{t("wdata.totals.empty")}</p>}
    {view.activities.map(row => <div className="recorded-totals-activity" key={row.definitionVersionId}>
      <h4>{language === "es" ? row.labelEs : row.labelEn} <small>{t("wdata.totals.version")} {row.definitionVersion}{row.retired && ` · ${t("wdata.totals.retired")}`}</small></h4>
      <dl className="recorded-totals-metrics"><div><dt>{t("wdata.totals.authorized")}</dt><dd>{partial(row.scopeTotal.state === "known", row.scopeTotal.knownMicros)}</dd></div>
        <div><dt>{t("wdata.totals.personal")}</dt><dd>{partial(row.personal.state === "known", row.personal.knownMicros)}</dd></div></dl>
      {row.machineSubsets.length > 0 && <><p className="muted">{t("wdata.totals.machine")}</p><ul>{row.machineSubsets.map(machine => <li key={machine.machineKind}>{t(Object.hasOwn(machineKeys, machine.machineKind) ? machineKeys[machine.machineKind] : "wdata.totals.machineUnknown")}: {durationMicros(machine.microseconds)}</li>)}</ul></>}
    </div>)}
    {view.activities.some(row => row.personal.includesLive) && <p className="muted">{t("wdata.totals.live")}</p>}
    <details className="recorded-totals-reconciliation"><summary>{t("wdata.totals.reconciliation")}</summary><p>{t("wdata.totals.related")}</p><h4>{r.scope === "personal" ? t("wdata.totals.own") : t("wdata.totals.scope")}</h4>
      <dl className="recorded-totals-metrics">{[[t("wdata.totals.gross"), r.grossMicros], [t("wdata.totals.paid"), r.payrollMicros], [t("wdata.totals.classified"), r.classifiedMicros], [t("wdata.totals.setup"), r.setupMicros], [t("wdata.totals.gap"), r.unclassifiedMicros], [t("wdata.totals.breaks"), r.breakElapsedMicros], [t("wdata.totals.deduction"), r.breakDeductionMicros], [t("wdata.totals.adjustment"), r.policyAdjustmentMicros]].map(([label, amount]) => <div key={label}><dt>{label}</dt><dd>{amount === null ? t("wdata.totals.unknown") : partial(!r.unresolvedScope, amount)}</dd></div>)}</dl>
      {(r.unresolvedScope || r.issues.some(issue => issue !== "own_live_provisional")) && <p>{t("wdata.totals.issues")}</p>}
    </details>
    {view.unitId !== null && <div className="recorded-totals-rate"><h3>{t("wdata.totals.rate")}</h3>
      {rate ? <p>{rate.hoursPer100SquareFeet} {t("wdata.totals.rateUnit")} · {rate.squareFeet} {t("wdata.totals.area")}</p> : <p>{t("wdata.totals.noRate")}</p>}
      {cohort.availability === "available" && <>
        {!cohort.eligible && <><p>{t("wdata.totals.excluded")}: {durationMicros(cohort.excludedLaborMicros)}</p><ul>{cohort.exclusions.map(reason => <li key={reason}>{t(Object.hasOwn(exclusionKeys, reason) ? exclusionKeys[reason] : "wdata.totals.notEligible")}</li>)}</ul></>}
        <p>{cohort.floor.label && `${t("wdata.totals.floor")}: ${cohort.floor.label} · `}{t("wdata.totals.unallocated")}</p>
      </>}
      <p className="muted">{t("wdata.totals.rateHelp")}</p>
    </div>}
  </>;
}
