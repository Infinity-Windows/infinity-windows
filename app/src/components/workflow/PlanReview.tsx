import { planChanges } from "../../lib/workflow/changes";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { listProjects } from "../../lib/api";
import { listVehicles } from "../../lib/vehicles/api";
import { vehicleTitle } from "../../lib/vehicles/display";
import { FlightsSection } from "../travel/FlightsSection";
import { LodgingSection } from "../travel/LodgingSection";
import { GettingAroundSection } from "../travel/GettingAroundSection";
import { HouseRulesSection } from "../travel/HouseRulesSection";
import { ContactsSection } from "../travel/ContactsSection";
import { AttachmentsPanel } from "../travel/AttachmentsPanel";
import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useT } from "../../lib/i18n";
import { formatApiError } from "../../lib/errors";
import { listProfilesIncludingRemoved } from "../../lib/install/api";
import { reviewPlan, savePlan, publishPlan, discardPlan, deliverPlanNotices, type PlanDraft, type PlanReview as Review, type PublishRequest } from "../../lib/workflow/api";

import { refreshWorkflow } from "../../lib/workflow/refresh";
export function PlanReview({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const q = useQuery({ queryKey: ["workflowReview", id], queryFn: () => reviewPlan(id), refetchOnWindowFocus: false });
  return <div className="sched-sheet-backdrop" role="dialog" aria-modal="true" aria-label={t("workflow.review")}>
    <div className="sched-sheet workflow-review">
      {!q.data ? <><h2>{t("workflow.review")}</h2><p role={q.error ? "alert" : undefined}>{q.error ? formatApiError(q.error) : t("workflow.loading")}</p><button className="button-like" onClick={onClose}>{t("workflow.close")}</button></> :
        <ReviewBody initial={q.data} onClose={onClose} />}
    </div>
  </div>;
}
function ReviewBody({ initial, onClose }: { initial: Review; onClose: () => void }) {
  const t = useT(); const qc = useQueryClient();
  // Own this editor snapshot: refetches and device layout changes must never
  // replace unsaved input. Reload is an explicit user action below.
  const [plan, setPlan] = useState(initial);
  const [draft, setDraft] = useState<PlanDraft>(() => structuredClone(initial.draft));
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const [allowConflicts, setAllowConflicts] = useState(false); const [cancelConfirm, setCancelConfirm] = useState(false);
  const [attempt, setAttempt] = useState<PublishRequest | null>(null);
  const people = useQuery({ queryKey: ["profilesIncludingRemoved"], queryFn: listProfilesIncludingRemoved });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: listVehicles });
  const nameOf = (id: string) => people.data?.find(p => p.id === id)?.display_name ?? t("workflow.crew");
  const jobName = (id: string | null) => { const p = projects.data?.find(p => p.id === id); return p ? `${p.job_code} · ${p.name}` : t("workflow.job"); };
  const vehicleName = (id: string) => { const v = vehicles.data?.find(v => v.id === id); return v ? vehicleTitle(v) : t("workflow.vehicle"); };
  const readonly = { canEdit: false, codesVisible: true, onAdd: () => {}, onEdit: () => {}, onDelete: () => {}, onAttachmentsChanged: () => {} };
  const dirty = JSON.stringify(draft) !== JSON.stringify(plan.draft);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<() => void>(() => {});
  closeRef.current = () => { if (!busy && (!dirty || window.confirm(t("workflow.discardEdits")))) onClose(); };
  const closeLatest = useCallback(() => closeRef.current(), []);
  useFocusTrap(bodyRef, true, closeLatest);
  const change = (edit: (copy: PlanDraft) => void) => { setDraft(old => { const next = structuredClone(old); edit(next); return next; }); setAttempt(null); setMessage(""); };
  async function reload() { const fresh = await reviewPlan(plan.id); setPlan(fresh); setDraft(structuredClone(fresh.draft)); setAllowConflicts(false); setAttempt(null); refreshWorkflow(qc); }
  async function run(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (e) { setError(formatApiError(e)); } finally { setBusy(false); } }
  async function publish(cancel: boolean) {
    const request = attempt ?? { p_plan: plan.id, p_expected: plan.revision, p_request: crypto.randomUUID(), p_review_token: plan.review_token, p_allow_crew_conflicts: allowConflicts, p_cancel: cancel };
    setAttempt(request);
    await publishPlan(request); // A retry after a lost response uses identical input.
    setAttempt(null); setCancelConfirm(false); setMessage(t("workflow.publishedNotice"));
    try { await deliverPlanNotices(plan.id); } catch { setMessage(t("workflow.noticesPending")); }
    await reload();
  }
  const pending = plan.revision !== plan.published_revision;
  const active = plan.state === "active";
  function crewPicker(members: { profile_id: string; role: string }[], assign: (ids: { profile_id: string; role: string }[]) => void, schedule: boolean) {
    return <fieldset className="workflow-crew" disabled={busy || !!attempt || !active}><legend>{t("workflow.crew")}</legend>
      {(people.data ?? []).filter(p => p.active || members.some(m => m.profile_id === p.id)).map(p => <label key={p.id}>
        <input type="checkbox" checked={members.some(m => m.profile_id === p.id)} onChange={e => assign(e.target.checked ? [...members, { profile_id: p.id, role: schedule && p.role === "foreman" ? "foreman" : schedule ? "installer" : "crew" }] : members.filter(m => m.profile_id !== p.id))} />{p.display_name}
      </label>)}
    </fieldset>;
  }
  return <div ref={bodyRef} tabIndex={-1}>
    <h2>{plan.name}</h2><p>{jobName(plan.project_id)}</p><p>{t("workflow.revision", { n: plan.revision })} · {plan.state === "canceled" ? t("workflow.canceled") : pending ? t("workflow.draft") : t("workflow.published")}</p>
    <p className="muted">{t(plan.project_id ? "workflow.draftHelp" : "workflow.purgedHelp")}</p>
    {[people.error, projects.error, vehicles.error].filter(Boolean).map((e,i) => <p role="alert" key={i}>{formatApiError(e)}</p>)}
    {error && <p role="alert" className="warn-text">{error}</p>}{message && <p role="status">{message}</p>}
    {plan.published_revision != null && plan.source_snapshot && <details><summary>{t("workflow.changes")}</summary>
      {planChanges(plan.source_snapshot, draft, nameOf).map((c,i) => <p key={i}><strong>{draft.trips.find(p => p.trip.id === c.section)?.trip.name ?? t("workflow.workBlock", { n: draft.assignments.findIndex(a => a.id === c.section) + 1 })} · {t(c.field)}</strong><br />{c.before || "—"} → {c.after || "—"}</p>)}
    </details>}
    <div className="workflow-fields">
      {draft.assignments.map((a, i) => <section className="detail-card" key={a.id}>
        <h3>{t("workflow.workBlock", { n: i + 1 })}</h3>
        <fieldset disabled={busy || !!attempt || !active} className="workflow-fields">
        <label>{t("workflow.start")}<input type="date" value={a.start_date} onChange={e => change(d => { d.assignments[i].start_date = e.target.value; })} /></label>
        <label>{t("workflow.end")}<input type="date" value={a.end_date} onChange={e => change(d => { d.assignments[i].end_date = e.target.value; })} /></label>
        <label>{t("workflow.startTime")}<input type="time" value={a.start_time ?? ""} onChange={e => change(d => { d.assignments[i].start_time = e.target.value || null; })} /></label>
        <label>{t("workflow.notes")}<textarea value={a.note ?? ""} onChange={e => change(d => { d.assignments[i].note = e.target.value; })} /></label>
        {crewPicker(a.members, members => change(d => { d.assignments[i].members = members as typeof a.members; }), true)}
        </fieldset>
        <p className="muted">{t("workflow.vehicleCount", { n: draft.vehicles.filter(v => v.assignment_id === a.id).length })}</p>{draft.vehicles.filter(v => v.assignment_id === a.id).map(v => <p key={v.id}>{vehicleName(v.vehicle_id)} · {a.start_date} – {a.end_date}</p>)}
      </section>)}
      {draft.trips.map((pack, i) => <section className="detail-card" key={pack.trip.id}>
        <h3>{t("workflow.trip")}: {pack.trip.name}</h3>
        <fieldset disabled={busy || !!attempt || !active} className="workflow-fields">
        <label>{t("workflow.name")}<input value={pack.trip.name} onChange={e => change(d => { d.trips[i].trip.name = e.target.value; })} /></label>
        <label>{t("workflow.destination")}<input value={pack.trip.destination ?? ""} onChange={e => change(d => { d.trips[i].trip.destination = e.target.value; })} /></label>
        <label>{t("workflow.travelStart")}<input type="date" value={pack.trip.start_date} onChange={e => change(d => { d.trips[i].trip.start_date = e.target.value; })} /></label>
        <label>{t("workflow.travelEnd")}<input type="date" value={pack.trip.end_date} onChange={e => change(d => { d.trips[i].trip.end_date = e.target.value; })} /></label>
        <label>{t("workflow.timezone")}<input value={pack.trip.timezone ?? ""} placeholder="America/Denver" onChange={e => change(d => { d.trips[i].trip.timezone = e.target.value; })} /></label>
        <label>{t("workflow.notes")}<textarea value={pack.trip.notes ?? ""} onChange={e => change(d => { d.trips[i].trip.notes = e.target.value; })} /></label>
        {crewPicker(pack.crew, crew => change(d => { d.trips[i].crew = crew; }), false)}
        </fieldset>
        <details><summary>{t("workflow.travelDetails")}</summary>
          <p className="muted">{t("workflow.detailsReadOnly")}</p>
          <FlightsSection {...readonly} tripId={pack.trip.id} flights={pack.flights} attachments={pack.attachments} nameOf={nameOf} />
          <LodgingSection {...readonly} tripId={pack.trip.id} lodging={pack.lodging} attachments={pack.attachments} />
          <GettingAroundSection {...readonly} ground={pack.ground} />
          <HouseRulesSection {...readonly} procedures={pack.procedures} />
          <ContactsSection {...readonly} contacts={pack.contacts} />
          <AttachmentsPanel tripId={pack.trip.id} attachments={pack.attachments.filter(a => !a.flight_id && !a.lodging_id)} canEdit={false} onChanged={() => {}} />
        </details>
      </section>)}
    </div>
    {active && plan.conflicts.length > 0 && <div className="detail-card"><p role="alert">{t("workflow.conflictCount", { n: plan.conflicts.length })}</p>
      {plan.conflicts.map((c, i) => { const other = plan.draft.assignments.find(a => a.id === c.other_id) ?? plan.conflict_assignments.find(a => a.id === c.other_id); return <p key={i}>{c.kind === "vehicle" ? vehicleName(c.resource_id) : nameOf(c.resource_id)} · {jobName(other?.project_id ?? null)} · {other?.start_date} – {other?.end_date}</p>; })}
      {plan.conflicts.some(c => c.kind === "vehicle") ? <p>{t("workflow.vehicleConflict")}</p> : <label className="workflow-check"><input type="checkbox" checked={allowConflicts} disabled={busy || !!attempt} onChange={e => setAllowConflicts(e.target.checked)} />{t("workflow.allowConflicts")}</label>}
    </div>}
    <p>{t("workflow.noticeState", { pending: plan.notices.filter(n => n.state !== "sent").reduce((sum, n) => sum + n.count, 0), sent: plan.notices.filter(n => n.state === "sent").reduce((sum, n) => sum + n.count, 0) })}</p>
    <div className="sched-sheet-actions workflow-actions">
      <button className="button-like" disabled={busy || !!attempt || !dirty} onClick={() => void run(async () => { await savePlan(plan, draft); await reload(); setMessage(t("workflow.saved")); })}>{t("workflow.save")}</button>
      <button className="button-like active-pill" disabled={busy || dirty || !active || (!attempt && (!pending || plan.conflicts.some(c => c.kind === "vehicle") || (plan.conflicts.length > 0 && !allowConflicts)))} onClick={() => void run(() => publish(attempt?.p_cancel ?? false))}>{attempt ? t("workflow.retryAction") : t("workflow.publish")}</button>
      <button className="button-like" disabled={busy} onClick={() => { if (!dirty || window.confirm(t("workflow.discardEdits"))) void run(reload); }}>{t("workflow.reload")}</button>
      <button className="button-like" disabled={busy} onClick={() => { if (!dirty || window.confirm(t("workflow.discardEdits"))) onClose(); }}>{t("workflow.close")}</button>
    </div>
    {plan.project_id && plan.notices.some(n => n.state !== "sent") && <button className="button-like" disabled={busy} onClick={() => void run(async () => { await deliverPlanNotices(plan.id); await reload(); })}>{t("workflow.retryNotices")}</button>}
    {active && <details><summary>{t("workflow.planActions")}</summary>
      {plan.published_revision == null ? <button className="button-like" disabled={busy || !!attempt} onClick={() => void run(async () => { await discardPlan(plan); refreshWorkflow(qc); onClose(); })}>{t("workflow.disconnect")}</button> : <>
        <label className="workflow-check"><input type="checkbox" checked={cancelConfirm} disabled={busy} onChange={e => setCancelConfirm(e.target.checked)} />{t("workflow.cancelConfirm")}</label>
        <button className="button-like danger-outline" disabled={busy || !cancelConfirm || dirty || !!attempt} onClick={() => void run(() => publish(true))}>{t("workflow.cancel")}</button>
      </>}
    </details>}
  </div>;
}
