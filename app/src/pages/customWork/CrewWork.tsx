import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listProjectsAnyStatus } from "../../lib/api";
import { listOpenings } from "../../lib/install/api";
import { listCrewWorkRecords, listCrewRecordPeople } from "../../lib/customWork/api";
import { CREW_WORK_STAGES, localWorkDate, type WorkUnit } from "../../lib/customWork/model";
import type { WorkStore } from "../../lib/customWork/useWork";
import { formatApiError } from "../../lib/errors";
import { useT } from "../../lib/i18n";
import { UnitEditor } from "./UnitEditor";
import { VoiceTextarea } from "../../components/voice/VoiceTextarea";

export function CrewWork({ work, jobId, canRecord }: { work: WorkStore; jobId: string | null; canRecord: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState(jobId ?? "");
  const [choice, setChoice] = useState("");
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [editing, setEditing] = useState(false);
  const [people, setPeople] = useState<string[]>([]);
  const [date, setDate] = useState(localWorkDate);
  const [stage, setStage] = useState("Installing");
  const [outcome, setOutcome] = useState<"assigned" | "partial" | "finished">("finished");
  const [wholeComplete, setWholeComplete] = useState(false);
  const [description, setDescription] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjectsAnyStatus, enabled: open });
  const crew = useQuery({ queryKey: ["customWorkCrewPeople", work.user], queryFn: listCrewRecordPeople });
  const openings = useQuery({ queryKey: ["customWorkCrewOpenings", job], queryFn: () => listOpenings(job), enabled: open && !!job });
  const records = useQuery({ queryKey: ["crewWorkRecords", work.user, jobId], queryFn: () => listCrewWorkRecords(jobId!), enabled: !!jobId && !!work.user });
  const names = new Map(crew.data?.map(p => [p.id, p.display_name]));
  const units = work.units.filter(u => u.project_id === job);
  const selected = units.find(u => u.id === choice);
  const mapped = openings.data?.find(o => `map:${o.id}` === choice);
  const activeCrew = crew.data?.filter(p => p.active && !p.is_partner && ["installer", "foreman", "supervisor", "owner"].includes(p.role ?? "")) ?? [];
  const pending = work.queue.filter(c => c.action === "crew_record" && (c.data.unit as WorkUnit)?.project_id === jobId);
  const resetUnit = () => { setWholeComplete(false); setDraft(null); setChoice(""); setEditing(false); };
  async function save() {
    if (!draft || !people.length || !date || busy) return;
    setBusy(true); setError("");
    try {
      await work.command("crew_record", { unit: draft, people, work_date: date, stage, outcome, description, whole_complete: wholeComplete && stage === "Installing" && outcome === "finished" });
      // A queued acknowledgement is not a server acknowledgement; QueueNotice shows refusals.
      setOpen(false); setSaved(true); resetUnit(); setDescription("");
    } catch (e) { setError(formatApiError(e)); }
    finally { setBusy(false); }
  }
  return <section className="cw-crew-records" aria-label={t("crewRecord.title")}>
    {canRecord && !open && <button className="cw-crew-entry" onClick={() => { setOpen(true); setJob(jobId ?? ""); setSaved(false); }}>
      <strong>{t("crewRecord.title")}</strong><span>{t("crewRecord.entryHelp")}</span>
    </button>}
    {saved && <p role="status" className="cw-notice">{t("crewRecord.saved")}</p>}
    {open && canRecord && <section className="cw-card">
      <div className="cw-heading"><h2>{t("crewRecord.title")}</h2><button disabled={busy} onClick={() => setOpen(false)}>{t("crewRecord.close")}</button></div>
      <p className="muted">{t("crewRecord.help")}</p>
      {(error || crew.error || openings.error || projects.error) && <p role="alert" className="cw-error">{error || formatApiError(crew.error || openings.error || projects.error)}</p>}
      <div className="cw-grid">
        <label>{t("crewRecord.job")}<select value={job} disabled={!!jobId || busy || editing || !!draft} onChange={e => { setJob(e.target.value); resetUnit(); }}><option value="">{t("crewRecord.chooseJob")}</option>{projects.data?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>{t("crewRecord.unit")}<select value={choice} disabled={!job || busy || editing || !!draft || openings.isLoading || !!openings.error} onChange={e => { setChoice(e.target.value); setDraft(null); }}>
          <option value="">{t("crewRecord.chooseUnit")}</option><option value="new">{t("crewRecord.newUnit")}</option>
          {units.map(u => <option key={u.id} value={u.id}>{u.label} · {u.type_label}</option>)}
          {openings.data?.filter(o => !o.removed_at && !units.some(u => u.opening_id === o.id)).map(o => <option key={o.id} value={`map:${o.id}`}>{o.opening_code} · {t("crewRecord.mapUnit")}</option>)}
        </select></label>
      </div>
      {choice && !editing && !draft && <button onClick={() => {
        if (selected) setDraft({ ...selected, reason: "Foreman crew record" });
        else setEditing(true);
      }}>{selected ? t("crewRecord.useUnit") : t("crewRecord.buildUnit")}</button>}
      {editing && <UnitEditor recordOnly jobId={job} openingId={mapped?.id} label={mapped?.opening_code} types={work.types} existingUnits={work.units} busy={busy}
        defaults={mapped ? { type: mapped.window_types?.name ?? "Unknown", facts: { ...(mapped.window_types?.width_in ? { width_in: mapped.window_types.width_in } : {}), ...(mapped.window_types?.height_in ? { height_in: mapped.window_types.height_in } : {}) } } : undefined}
        onSave={async data => {
          if (!data.project_id || !String(data.label).trim()) { setError(t("crewRecord.identify")); return; }
          if (units.some(u => u.label.trim().toLowerCase() === String(data.label).trim().toLowerCase()) || (!data.opening_id && openings.data?.some(o => !o.removed_at && o.opening_code.trim().toLowerCase() === String(data.label).trim().toLowerCase()))) {
            setError(t("crewRecord.duplicate")); return;
          }
          setError(""); setDraft(data); setEditing(false);
        }} onCancel={() => setEditing(false)} />}
      {draft && <>
        <div className="cw-heading"><h3>{String(draft.label)} · {String(draft.type_label)}</h3><button disabled={busy} onClick={resetUnit}>{t("crewRecord.changeUnit")}</button></div>
        <div className="cw-grid">
          <label>{t("crewRecord.date")}<input type="date" value={date} max={outcome === "assigned" ? undefined : localWorkDate()} onChange={e => setDate(e.target.value)} /></label>
          <label>{t("crewRecord.stage")}<select value={stage} onChange={e => setStage(e.target.value)}>{CREW_WORK_STAGES.map(s => <option key={s}>{s}</option>)}</select></label>
          <label>{t("crewRecord.status")}<select value={outcome} onChange={e => setOutcome(e.target.value as typeof outcome)}><option value="finished">{t("crewRecord.finished")}</option><option value="partial">{t("crewRecord.partial")}</option><option value="assigned">{t("crewRecord.assigned")}</option></select></label>
        </div>
        {stage === "Installing" && outcome === "finished" && <label className="cw-person-choice"><input type="checkbox" checked={wholeComplete} onChange={e => setWholeComplete(e.target.checked)} /><span>{t("crewRecord.wholeComplete")}</span></label>}
        <fieldset className="cw-crew-picker"><legend>{t("crewRecord.people")}</legend>
          <label>{t("crewRecord.search")}<input value={search} onChange={e => setSearch(e.target.value)} /></label>
          <p>{t("crewRecord.selected", { count: people.length })}</p>
          <div>{activeCrew.filter(p => people.includes(p.id) || (p.display_name ?? "").toLowerCase().includes(search.toLowerCase())).map(p => <label className="cw-person-choice" key={p.id}>
            <input type="checkbox" checked={people.includes(p.id)} onChange={e => setPeople(old => e.target.checked ? [...old, p.id] : old.filter(id => id !== p.id))} /><span>{p.display_name}</span>
          </label>)}</div>
        </fieldset>
        <label>{t("crewRecord.notes")}<VoiceTextarea value={description} maxLength={4000} onChange={e => setDescription(e.target.value)} /></label>
        <p className="cw-notice">{t("crewRecord.noTime")}</p>
        <button className="primary" disabled={busy || !people.length || !date || !!crew.error || !!work.queueError || !!work.queue[0]?.error} onClick={() => void save()}>{busy ? t("crewRecord.saving") : t("crewRecord.save")}</button>
      </>}
    </section>}
    {jobId && <details className="cw-card" open={saved || !!pending.length}>
      <summary>{t("crewRecord.history")} · {(records.data?.length ?? 0) + pending.length}</summary>
      {records.error && <p role="alert" className="cw-error">{formatApiError(records.error)}</p>}
      {records.isLoading && <p>{t("crewRecord.loading")}</p>}
      {!records.isLoading && !records.error && !records.data?.length && !pending.length && <p className="muted">{t("crewRecord.empty")}</p>}
      {pending.map(c => <article className="cw-crew-history" key={c.id}><strong>{String((c.data.unit as WorkUnit).label)}</strong><p>{String(c.data.work_date)} · {String(c.data.stage)}</p><p>{t("crewRecord.pending")}{c.error ? ` — ${c.error}` : ""}</p></article>)}
      {[...(records.data ?? [])].sort((a,b) => b.work_date.localeCompare(a.work_date) || b.created_at.localeCompare(a.created_at)).map(r => <article className="cw-crew-history" key={r.id}>
        <div className="cw-heading"><strong>{work.units.find(u => u.id === r.unit_id)?.label ?? t("crewRecord.unit")}</strong><span className="cw-badge">{t(`crewRecord.${r.outcome}`)}</span></div>
        <p>{r.work_date} · {r.stage}{r.whole_complete ? ` · ${t("crewRecord.wholeComplete")}` : ""}</p><p>{r.people.map(p => names.get(p.profile_id) || t("crewRecord.formerWorker")).join(", ")}</p>
        {r.description && <p className="cw-crew-description">{r.description}</p>}
        <small>{t("crewRecord.filed", { name: (r.filed_by && names.get(r.filed_by)) || t("crewRecord.formerWorker"), date: new Date(r.created_at).toLocaleString() })}</small>
        <p className="muted">{t("crewRecord.noTime")}</p>
      </article>)}
    </details>}
  </section>;
}
