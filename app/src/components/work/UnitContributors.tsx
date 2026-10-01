// Foreman unit contributors (2026-09-30): a compact action below the lead
// row on Work. A foreman selects a saved unit or a mapped opening — on any
// job, even off the clock — and records several people's earlier work (an
// RO check, flashing, any canonical stage) for a past date. This starts no
// timer, clocks nobody in, approves no QC and never marks a whole
// installation complete: it is the narrow record_stage_contributors/
// correct_stage_contributors route (20261049000000), not CrewWork.tsx's
// full unit builder. Installers can open the same panel to read the
// effective contributor summary; canRecord hides every write control.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listProjectsAnyStatus } from "../../lib/api";
import { listOpenings } from "../../lib/install/api";
import { getStageContributorSummary, listCrewRecordPeople, listUnitCrewWorkRecords, listWorkHistory } from "../../lib/customWork/api";
import { CREW_WORK_STAGES, crewRecordEligible, localWorkDate } from "../../lib/customWork/model";
import { retryWork } from "../../lib/customWork/queue";
import { isMissingFunction } from "../../lib/schemaErrors";
import type { WorkStore } from "../../lib/customWork/useWork";
import { formatApiError } from "../../lib/errors";
import { useT, type TKey } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import { Sheet } from "../ui/Sheet";
import { VoiceTextarea } from "../voice/VoiceTextarea";

export function UnitContributors({ work, jobId, canRecord }: { work: WorkStore; jobId: string | null; canRecord: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState(jobId ?? "");
  const [choice, setChoice] = useState(""); // a unit id, or `map:<openingId>`
  const [stage, setStage] = useState(CREW_WORK_STAGES[0]);
  const [date, setDate] = useState(localWorkDate);
  const [outcome, setOutcome] = useState<"partial" | "finished">("finished");
  const [people, setPeople] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [submitted, setSubmitted] = useState<{ add: string[]; remove: string[] } | null>(null);
  const [correctionDigest, setCorrectionDigest] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [addIds, setAddIds] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [correctBusy, setCorrectBusy] = useState(false);
  const [correctError, setCorrectError] = useState("");

  const projects = useQuery({ queryKey: ["projects", work.user, "contributors"], queryFn: listProjectsAnyStatus, enabled: open && !!work.user });
  const crew = useQuery({ queryKey: ["customWorkCrewPeople", work.user], queryFn: listCrewRecordPeople, enabled: open });
  const openings = useQuery({ queryKey: ["customWorkCrewOpenings", work.user, job], queryFn: () => listOpenings(job), enabled: open && !!job && !!work.user });
  const names = new Map(crew.data?.map((p) => [p.id, p.display_name]));
  const units = work.units.filter((u) => u.project_id === job);
  const selectedUnit = units.find((u) => u.id === choice);
  const mappedOpening = openings.data?.find((o) => `map:${o.id}` === choice);
  // An opening that already has a saved unit resolves to that unit, same as
  // the server would — a foreman never names an opening the server would
  // otherwise have to re-resolve to the unit they already see on Work.
  const resolvedUnitId = selectedUnit?.id ?? units.find((u) => u.opening_id === mappedOpening?.id)?.id;
  const target = resolvedUnitId ? { unit_id: resolvedUnitId } : mappedOpening ? { opening_id: mappedOpening.id } : null;
  const activeCrew = crew.data?.filter(crewRecordEligible) ?? [];

  const summary = useQuery({
    queryKey: ["stageContributorSummary", work.user, resolvedUnitId ?? "00000000-0000-0000-0000-000000000000"],
    queryFn: () => getStageContributorSummary(resolvedUnitId ?? "00000000-0000-0000-0000-000000000000"),
    enabled: open && !!work.user,
  });
  const tupleRows = (summary.data ?? []).filter((r) => r.stage === stage && r.work_date === date);
  const tupleDigest = tupleRows[0]?.digest;
  const tupleProfileIds = tupleRows.map((r) => r.profile_id);

  const pending = work.queue.filter((c) => c.userId === work.user && (c.action === "stage_contributors" || c.action === "correct_stage_contributors") &&
    ((!!resolvedUnitId && c.data.unit_id === resolvedUnitId) || (!!mappedOpening && c.data.opening_id === mappedOpening.id)) && c.data.stage === stage && c.data.work_date === date);
  const confirmed = saved && !pending.length && summary.isSuccess && submitted &&
    submitted.add.every((id) => tupleProfileIds.includes(id)) && submitted.remove.every((id) => !tupleProfileIds.includes(id));
  const unavailable = isMissingFunction(summary.error);

  // Original filings and corrections for THIS exact tuple, oldest evidence
  // last — a correction's reason sits beside what it changed, and the
  // original record stays visible rather than being replaced by it.
  const history = useQuery({ queryKey: ["customWorkHistory", work.user, job], queryFn: () => listWorkHistory(job), enabled: open && !!job });
  const records = useQuery({ queryKey: ["crewWorkRecords", work.user, "unit", resolvedUnitId], queryFn: () => listUnitCrewWorkRecords(resolvedUnitId!), enabled: open && !!resolvedUnitId });
  const tupleRecords = (records.data ?? []).filter((r) => r.stage === stage && r.work_date === date && r.outcome !== "assigned");
  const unitHistory = (history.data ?? [])
    .filter((h) => h.entity_id === resolvedUnitId && (h.action === "stage_contributors" || h.action === "stage_contributor_correction"))
    .filter((h) => {
      const av = h.after_value as { stage?: string; work_date?: string } | null;
      const bv = h.before_value as { stage?: string; work_date?: string } | null;
      return (av?.stage === stage && av.work_date === date) || (bv?.stage === stage && bv.work_date === date);
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const resetChoice = () => {
    setChoice("");
    setCorrecting(false);
    setRemoveIds([]);
    setAddIds([]);
    setReason("");
    setCorrectionDigest(null);
    setSaved(false);
    setSubmitted(null);
    setPeople([]);
    setError("");
    setCorrectError("");
  };

  async function save() {
    if (!target || !people.length || !date || busy || !summary.isSuccess) return;
    setBusy(true);
    setError("");
    try {
      await work.command("stage_contributors", { ...target, stage, work_date: date, outcome, people, description });
      setSubmitted({ add: [...people], remove: [] });
      setSaved(true);
      setPeople([]);
      setDescription("");
      await work.refresh();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveCorrection() {
    if (!resolvedUnitId || correctBusy || !correctionDigest || (!removeIds.length && !addIds.length)) return;
    if (!reason.trim()) {
      setCorrectError(t("work.contrib.reasonRequired"));
      return;
    }
    setCorrectBusy(true);
    setCorrectError("");
    try {
      await work.command("correct_stage_contributors", {
        unit_id: resolvedUnitId,
        stage,
        work_date: date,
        expected_digest: correctionDigest,
        reason: reason.trim(),
        remove: removeIds,
        add: addIds,
        ...(addIds.length ? { outcome } : {}),
      });
      setSubmitted({ add: [...addIds], remove: [...removeIds] });
      setSaved(true);
      setCorrecting(false);
      setRemoveIds([]);
      setAddIds([]);
      setReason("");
      await work.refresh();
    } catch (e) {
      setCorrectError(formatApiError(e));
    } finally {
      setCorrectBusy(false);
    }
  }

  return (
    <section className="ws-contrib" aria-label={t("work.contrib.title")}>
      {!open && (
        <button type="button" className="ws-btn ws-unit-add" data-testid="ws-contrib-open" onClick={() => { setOpen(true); setJob(jobId ?? ""); setSaved(false); }}>
          {canRecord ? t("work.contrib.openWrite") : t("work.contrib.openRead")}
        </button>
      )}
      {confirmed && !open && <p role="status" className="ws-meta">{t("work.contrib.confirmed")}</p>}
      {open && (
        <Sheet open={open} onClose={() => setOpen(false)} label={t("work.contrib.title")} className="ws-sheet">
          <h2 className="ws-sheet-title">{t("work.contrib.title")}</h2>
          <p className="ws-meta">{t("work.contrib.help")}</p>
          {(error || crew.error || openings.error || projects.error || summary.error || history.error || records.error) && (
            <p role="alert" className="ws-error">{unavailable ? t("work.contrib.unavailable") : error || formatApiError(crew.error || openings.error || projects.error || summary.error || history.error || records.error)}</p>
          )}
          <label className="ws-label" htmlFor="ws-contrib-job">{t("work.contrib.job")}</label>
          <select
            id="ws-contrib-job"
            className="ws-input"
            value={job}
            disabled={busy || correctBusy || correcting}
            onChange={(e) => { setJob(e.target.value); resetChoice(); }}
          >
            <option value="">{t("work.contrib.chooseJob")}</option>
            {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.job_code} · {p.name}</option>)}
          </select>

          <label className="ws-label" htmlFor="ws-contrib-unit">{t("work.contrib.unit")}</label>
          <select
            id="ws-contrib-unit"
            className="ws-input"
            value={choice}
            disabled={!job || busy || correctBusy || correcting || openings.isLoading}
            onChange={(e) => { resetChoice(); setChoice(e.target.value); }}
          >
            <option value="">{t("work.contrib.chooseUnit")}</option>
            {units.map((u) => <option key={u.id} value={u.id}>{u.label} · {u.type_label}</option>)}
            {openings.data?.filter((o) => !o.removed_at && (!units.some((u) => u.opening_id === o.id) || choice === `map:${o.id}`)).map((o) => (
              <option key={o.id} value={`map:${o.id}`}>{o.opening_code} · {t("work.contrib.mapUnit")}</option>
            ))}
          </select>

          {target && (
            <>
              <div className="ws-chip-row ws-chip-row--wrap" role="group" aria-label={t("work.contrib.stage")}>
                {CREW_WORK_STAGES.map((s) => (
                  <button key={s} type="button" className={`ws-chip${stage === s ? " ws-chip--on" : ""}`} aria-pressed={stage === s} disabled={busy || correctBusy || correcting} onClick={() => { setStage(s); setSaved(false); setSubmitted(null); }}>
                    {t(`work.contrib.stage.${s}` as TKey)}
                  </button>
                ))}
              </div>
              <label className="ws-label" htmlFor="ws-contrib-date">{t("work.contrib.date")}</label>
              <input id="ws-contrib-date" className="ws-input" type="date" value={date} max={localWorkDate()} disabled={busy || correctBusy || correcting} onChange={(e) => { setDate(e.target.value); setSaved(false); setSubmitted(null); }} />

              <p className="ws-label">{t("work.contrib.summary")}</p>
              {summary.isLoading && <p className="ws-meta">{t("work.contrib.loading")}</p>}
              {summary.isSuccess && tupleProfileIds.length === 0 && <p className="ws-meta">{t("work.contrib.none")}</p>}
              {tupleProfileIds.length > 0 && (
                <ul className="ws-list">
                  {tupleProfileIds.map((pid) => (
                    <li key={pid} className="ws-list-item">
                      <span className="ws-list-name">{names.get(pid) || t("work.contrib.formerWorker")}</span>
                    </li>
                  ))}
                </ul>
              )}
              {confirmed && <p role="status" className="ws-meta">{t("work.contrib.confirmed")}</p>}
              {pending.length > 0 && <aside className="ws-meta" aria-label={t("work.contrib.pendingTitle")}>
                <p role="status">{t("work.contrib.pending", { count: pending.length })}</p>
                {pending.map((c) => c.error && <p key={c.id} role="alert">{c.error}</p>)}
                <button type="button" className="ws-btn ws-btn--ghost" onClick={() => void (async () => { try { if (work.user) await retryWork(work.user); await work.refresh(); } catch (e) { setError(formatApiError(e)); } })()}>{t("work.contrib.retry")}</button>
                <a href="/current-work">{t("work.contrib.reviewPending")}</a>
              </aside>}

              {(unitHistory.length > 0 || tupleRecords.length > 0) && (
                <details className="ws-sheet">
                  <summary className="ws-label">{t("work.contrib.history")}</summary>
                  {tupleRecords.map((r) => <article key={`record:${r.id}`} className="ws-list-item">
                    <span className="ws-list-name">{r.people.map((p) => names.get(p.profile_id) || t("work.contrib.formerWorker")).join(", ")}</span>
                    <p className="ws-meta">{t("work.contrib.historyFiled", { name: names.get(r.filed_by ?? "") || t("work.contrib.formerWorker") })} · {new Date(r.created_at).toLocaleString()}</p>
                    {r.description && <p>{r.description}</p>}
                    {r.people.filter((p) => p.voided_at).map((p) => <p key={p.profile_id} className="ws-meta">{t("work.contrib.removedPerson", { name: names.get(p.profile_id) || t("work.contrib.formerWorker") })} · {p.void_reason}</p>)}
                  </article>)}
                  {unitHistory.map((h) => (
                    <article key={h.id} className="ws-list-item">
                      <span className="ws-list-name">
                        {h.action === "stage_contributor_correction"
                          ? t("work.contrib.historyCorrected", { name: names.get(h.actor_id) || t("work.contrib.formerWorker") })
                          : t("work.contrib.historyFiled", { name: names.get(h.actor_id) || t("work.contrib.formerWorker") })}
                        {" · "}
                        {new Date(h.created_at).toLocaleString()}
                      </span>
                      {h.action === "stage_contributor_correction" && h.reason && <p className="ws-meta">{h.reason}</p>}
                    </article>
                  ))}
                </details>
              )}

              {canRecord && !correcting && tupleProfileIds.length > 0 && tupleDigest && !summary.isError && !pending.length && (
                <button type="button" className="ws-btn ws-btn--ghost" onClick={() => { setCorrectionDigest(tupleDigest); setCorrecting(true); setCorrectError(""); }}>
                  {t("work.contrib.correct")}
                </button>
              )}
              {canRecord && correcting && (
                <div className="ws-sheet">
                  <p className="ws-label">{t("work.contrib.removePeople")}</p>
                  <div className="ws-chip-row ws-chip-row--wrap">
                    {tupleProfileIds.map((pid) => (
                      <button
                        key={pid}
                        type="button"
                        className={`ws-chip${removeIds.includes(pid) ? " ws-chip--on" : ""}`}
                        aria-pressed={removeIds.includes(pid)}
                        disabled={correctBusy}
                        onClick={() => setRemoveIds((old) => (old.includes(pid) ? old.filter((x) => x !== pid) : [...old, pid]))}
                      >
                        {names.get(pid) || t("work.contrib.formerWorker")}
                      </button>
                    ))}
                  </div>
                  <p className="ws-label">{t("work.contrib.addPeople")}</p>
                  <div className="ws-chip-row ws-chip-row--wrap">
                    {activeCrew.filter((p) => !tupleProfileIds.includes(p.id)).map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`ws-chip${addIds.includes(p.id) ? " ws-chip--on" : ""}`}
                        aria-pressed={addIds.includes(p.id)}
                        disabled={correctBusy}
                        onClick={() => setAddIds((old) => (old.includes(p.id) ? old.filter((x) => x !== p.id) : [...old, p.id]))}
                      >
                        {p.display_name}
                      </button>
                    ))}
                  </div>
                  <label className="ws-label" htmlFor="ws-contrib-reason">{t("work.contrib.reason")}</label>
                  <VoiceTextarea id="ws-contrib-reason" className="ws-textarea" rows={2} maxLength={500} value={reason} disabled={correctBusy} onChange={(e) => setReason(e.target.value)} />
                  {correctError && <p role="alert" className="ws-error">{correctError}</p>}
                  <button
                    type="button"
                    className="ws-btn ws-btn--primary"
                    disabled={correctBusy || (!removeIds.length && !addIds.length) || !reason.trim() || !!work.queueError || !!work.queue[0]?.error}
                    onClick={() => void saveCorrection()}
                  >
                    {correctBusy ? t("work.contrib.correcting") : t("work.contrib.saveCorrection")}
                  </button>
                  <button type="button" className="ws-btn ws-btn--ghost" disabled={correctBusy} onClick={() => { setCorrecting(false); setRemoveIds([]); setAddIds([]); setReason(""); }}>
                    {t("work.contrib.cancelCorrection")}
                  </button>
                </div>
              )}

              {canRecord && !correcting && (
                <>
                  <label className="ws-label" htmlFor="ws-contrib-outcome">{t("work.contrib.outcome")}</label>
                  <select id="ws-contrib-outcome" className="ws-input" value={outcome} disabled={busy} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
                    <option value="finished">{t("work.contrib.finished")}</option>
                    <option value="partial">{t("work.contrib.partial")}</option>
                  </select>
                  <fieldset className="ws-contrib-people">
                    <legend className="ws-label">{t("work.contrib.people")}</legend>
                    <label className="ws-search">
                      <input value={search} disabled={busy} onChange={(e) => setSearch(e.target.value)} placeholder={t("work.contrib.search")} aria-label={t("work.contrib.search")} />
                    </label>
                    <p className="ws-meta">{t("work.contrib.selected", { count: people.length })}</p>
                    <div className="ws-chip-row ws-chip-row--wrap">
                      {activeCrew
                        .filter((p) => people.includes(p.id) || (p.display_name ?? "").toLowerCase().includes(search.toLowerCase()))
                        .map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            className={`ws-chip${people.includes(p.id) ? " ws-chip--on" : ""}`}
                            aria-pressed={people.includes(p.id)}
                            disabled={busy}
                            onClick={() => setPeople((old) => (old.includes(p.id) ? old.filter((x) => x !== p.id) : [...old, p.id]))}
                          >
                            {p.display_name}
                          </button>
                        ))}
                    </div>
                  </fieldset>
                  <label className="ws-label" htmlFor="ws-contrib-notes">{t("work.contrib.notes")}</label>
                  <VoiceTextarea id="ws-contrib-notes" className="ws-textarea" rows={2} maxLength={4000} value={description} disabled={busy} onChange={(e) => setDescription(e.target.value)} />
                  <p className="ws-meta">{t("work.contrib.noTime")}</p>
                  <button
                    type="button"
                    className="ws-btn ws-btn--primary"
                    disabled={busy || !summary.isSuccess || !people.length || !date || !!work.queueError || !!work.queue[0]?.error}
                    onClick={() => void save()}
                  >
                    {busy ? t("work.contrib.saving") : t("work.contrib.save")}
                  </button>
                </>
              )}
            </>
          )}
          <button type="button" className="ws-btn ws-btn--ghost" onClick={() => setOpen(false)}>
            {t("work.contrib.close")}
          </button>
        </Sheet>
      )}
    </section>
  );
}
