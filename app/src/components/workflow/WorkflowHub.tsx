import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useT } from "../../lib/i18n";
import { listProjects } from "../../lib/api";
import { listDraftAssignments } from "../../lib/schedule/api";
import { listTrips } from "../../lib/travel/api";
import { createPlan, listPlans, loadPlanLinks } from "../../lib/workflow/api";
import { refreshWorkflow } from "../../lib/workflow/refresh";
import { formatApiError } from "../../lib/errors";

/** Explicit selection only: sharing a job never silently connects a trip. */
export function WorkflowHub({ tripId, onOpen }: { tripId?: string; onOpen: (id: string) => void }) {
  const t = useT(); const qc = useQueryClient();
  const links = useQuery({ queryKey: ["workflowLinks"], queryFn: loadPlanLinks });
  const plans = useQuery({ queryKey: ["workflowPlans"], queryFn: listPlans, enabled: links.data?.available === true });
  const [creating, setCreating] = useState(false);
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects, enabled: creating });
  const work = useQuery({ queryKey: ["scheduleDrafts"], queryFn: listDraftAssignments, enabled: creating });
  const trips = useQuery({ queryKey: ["trips"], queryFn: listTrips, enabled: creating });
  const [job, setJob] = useState(""); const [name, setName] = useState("");
  const [workIds, setWorkIds] = useState<string[]>([]); const [tripIds, setTripIds] = useState<string[]>(tripId ? [tripId] : []);
  const [request, setRequest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  if (links.isError) return <p role="alert">{formatApiError(links.error)} <button className="button-like" onClick={() => void links.refetch()}>{t("workflow.reload")}</button></p>;
  if (!links.data?.available) return null; // Compatible with the still-live schema.
  const attached = links.data.trips.find(l => l.trip_id === tripId)?.plan_id;
  const listed = (plans.data ?? []).filter(p => !tripId || p.id === attached);
  const unlinkedWork = (work.data ?? []).filter(a => a.kind === "install" && a.project_id === job && !links.data.assignments.some(l => l.assignment_id === a.id));
  const unlinkedTrips = (trips.data ?? []).filter(a => a.status === "draft" && a.project_id === job && !links.data.trips.some(l => l.trip_id === a.id));
  function toggle(ids: string[], id: string, checked: boolean) { return checked ? [...ids, id] : ids.filter(x => x !== id); }
  async function create() {
    const id = request ?? crypto.randomUUID(); setRequest(id); setBusy(true); setError("");
    try { await createPlan(id, name.trim(), workIds, tripIds); refreshWorkflow(qc); setCreating(false); setRequest(null); onOpen(id); }
    catch (e) { setError(formatApiError(e)); }
    finally { setBusy(false); }
  }
  return <section className="detail-card workflow-hub" aria-label={t("workflow.plans")}>
    <h2>{t("workflow.plans")}</h2>
    <p>{attached ? t("workflow.connectedHelp") : t("workflow.connectHelp")}</p>
    {plans.error && <p role="alert">{formatApiError(plans.error)}</p>}
    {listed.map(p => <button key={p.id} className="button-like workflow-plan-link" onClick={() => onOpen(p.id)}>{p.name} · {p.state === "canceled" ? t("workflow.canceled") : p.revision === p.published_revision ? t("workflow.published") : t("workflow.draft")} · {t("workflow.review")}</button>)}
    {!attached && !creating && <button className="button-like" onClick={() => setCreating(true)}>{t("workflow.connect")}</button>}
    {creating && <form onSubmit={e => { e.preventDefault(); void create(); }}>
      <p>{t("workflow.detailsReadOnly")}</p>
      {error && <p role="alert">{error}</p>}
      {[projects.error, work.error, trips.error].filter(Boolean).map((e, i) => <p role="alert" key={i}>{formatApiError(e)}</p>)}
      <fieldset className="workflow-fields" disabled={busy || !!request}>
        <label>{t("workflow.name")}<input required maxLength={160} value={name} onChange={e => setName(e.target.value)} /></label>
        <label>{t("workflow.job")}<select required value={job} onChange={e => { setJob(e.target.value); setWorkIds([]); setTripIds([]); }}><option value="">{t("workflow.chooseJob")}</option>{(projects.data ?? []).map(p => <option key={p.id} value={p.id}>{p.job_code} · {p.name}</option>)}</select></label>
        <fieldset className="workflow-crew"><legend>{t("workflow.chooseWork")}</legend>{unlinkedWork.map(a => <label key={a.id}><input type="checkbox" checked={workIds.includes(a.id)} onChange={e => setWorkIds(toggle(workIds, a.id, e.target.checked))} />{a.start_date} – {a.end_date} · {a.note || t("workflow.crewCount", { n: a.members.length })}</label>)}</fieldset>
        <fieldset className="workflow-crew"><legend>{t("workflow.chooseTrips")}</legend>{unlinkedTrips.map(a => <label key={a.id}><input type="checkbox" checked={tripIds.includes(a.id)} onChange={e => setTripIds(toggle(tripIds, a.id, e.target.checked))} />{a.name} · {a.start_date} – {a.end_date}</label>)}</fieldset>
      </fieldset>
      <p className="muted">{t("workflow.selectionHelp")}</p>
      <div className="workflow-actions"><button type="submit" className="button-like active-pill" disabled={busy || !name.trim() || workIds.length === 0 || tripIds.length === 0}>{request ? t("workflow.retryAction") : t("workflow.connectReview")}</button>
      <button type="button" className="button-like" disabled={busy} onClick={() => { setCreating(false); setRequest(null); refreshWorkflow(qc); }}>{t("workflow.close")}</button></div>
    </form>}
  </section>;
}
