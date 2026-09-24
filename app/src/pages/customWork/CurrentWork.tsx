import { VoiceInput } from "../../components/voice/VoiceInput";
import { VoiceTextarea } from "../../components/voice/VoiceTextarea";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { roleRank } from "../../lib/nav";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getOpening } from "../../lib/install/api";
import { isToolboxGateError } from "../../lib/install/installTimer";
import { listProjectsAnyStatus } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import { isMissingTable, isMissingFunction } from "../../lib/schemaErrors";
import { useWork } from "../../lib/customWork/useWork";
import {
  clockText,
  IDLE_REASONS,
  seconds,
  WORK_STAGES,
  type WorkSession,
  type WorkUnit,
} from "../../lib/customWork/model";
import {
  canEditUnit,
  finishedStop,
  isUnitComplete,
  markCompleteUnit,
} from "../../lib/customWork/complete";
import { CrewWork } from "./CrewWork";
import { UnitEditor } from "./UnitEditor";
import { QueueNotice } from "./QueueNotice";
import "./customWork.css";

export function CurrentWork() {
  const t = useT();
  const work = useWork();
  const { effectiveRole } = useEffectiveRole();
  const lead = roleRank(effectiveRole) >= 1;
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<WorkUnit | "new" | null>(null);
  const [idle, setIdle] = useState(false),
    [idleNote, setIdleNote] = useState("");
  const [stage, setStage] = useState("Installing");
  const [finishNote, setFinishNote] = useState(""),
    [delay, setDelay] = useState("");
  const [outcome, setOutcome] = useState<WorkSession["outcome"]>("partial");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (idle)
      document
        .getElementById("cw-idle")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [idle]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: listProjectsAnyStatus,
  });
  const openingId = params.get("opening");
  const opening = useQuery({
    queryKey: ["customWorkOpening", openingId],
    queryFn: () => getOpening(openingId!),
    enabled: !!openingId,
  });
  const active = work.active;
  const activeUnit = work.units.find((u) => u.id === active?.unit_id);
  const shift = work.clock.shift;
  const jobId = params.get("job") ?? shift?.project_id ?? null;
  const selectedUnit =
    work.units.find((u) => u.id === params.get("unit")) ??
    work.units.find((u) => openingId && u.opening_id === openingId);
  const job = projects.data?.find((p) => p.id === jobId);
  const mapType = opening.data?.window_types;
  const mapDefaults = opening.data
    ? {
        type: mapType?.name || "Unknown",
        facts: {
          ...(mapType?.width_in && mapType?.height_in
            ? {
                width_in: mapType.width_in,
                height_in: mapType.height_in,
                area_source: "From plans",
              }
            : {}),
          ...(opening.data.label ? { location: opening.data.label } : {}),
        },
      }
    : undefined;
  const available = work.units.filter(
    (u) =>
      u.project_id === jobId ||
      (!u.project_id && (u.created_by === work.user || lead)),
  );
  const timed = shift?.status === "open" && !shift.break_started_at;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      // Forge refused a unit or prep-time start because today's talk is not
      // signed (20261031000000; on the clock, under the paid-time rule): say
      // it in the phone's words rather than the server's English sentence.
      setError(isToolboxGateError(e) ? t("currentWork.signTalkFirst") : formatApiError(e));
    } finally {
      setBusy(false);
    }
  };
  const start = async (unit: WorkUnit | null, participation = "install") => {
    if (!timed || !shift) {
      work.clock.openClock();
      return;
    }
    if (shift.id.startsWith("pending:"))
      throw new Error(
        "Your job clock is waiting to sync. Unit details can be saved now; start unit timing after the job clock syncs.",
      );
    await work.command("start", {
      id: crypto.randomUUID(),
      shift_id: shift.id,
      unit_id: unit?.id ?? null,
      project_id: unit ? unit.project_id : shift.project_id,
      expected_session_id: active?.id ?? null,
      at: new Date().toISOString(),
      stage: unit ? stage : "Idle time",
      participation,
      description: unit ? "" : idleNote,
      finish_note: finishNote || undefined,
      outcome: active ? outcome : undefined,
      delay_reason: delay,
    });
    setEditing(null);
    setIdle(false);
    setFinishNote("");
    setDelay("");
    setOutcome("partial");
    setParams({});
  };
  const stop = async () => {
    if (!active) return;
    await work.command("stop", {
      expected_session_id: active.id,
      at: new Date().toISOString(),
      outcome,
      finish_note: finishNote || active.description,
      delay_reason: delay,
    });
    setFinishNote("");
    setDelay("");
  };
  // One tap to finish a unit: stop as finished, then mark the whole install
  // complete — never a start, which reopens it (lib/customWork/complete.ts).
  const completeUnit = async () => {
    if (!active || !activeUnit) return;
    // Both steps land on this phone in one write BEFORE anything waits on the
    // network: queued one after the other, closing the app on weak signal
    // between them kept the stop and lost the complete mark.
    await work.commandMany([
      { action: "stop", data: finishedStop(active, new Date().toISOString(), finishNote, delay) },
      { action: "unit", data: markCompleteUnit(activeUnit), intent: "complete-unit" },
    ]);
    setFinishNote("");
    setDelay("");
    setOutcome("partial");
  };
  // A helper on someone else's unit finishes their own part; the unit's author
  // or a foreman records the whole install (the server's rule for unit edits).
  const finishMyPart = async () => {
    if (!active) return;
    await work.command("stop", finishedStop(active, new Date().toISOString(), finishNote, delay));
    setFinishNote("");
    setDelay("");
    setOutcome("partial");
  };
  const canComplete = !!activeUnit && canEditUnit(activeUnit, work.user, lead);
  const saveUnit = async (data: Record<string, unknown>, begin: boolean) =>
    run(async () => {
      await work.command("unit", data);
      if (begin) await start(data as unknown as WorkUnit);
      else setEditing(null);
    });
  const blocked =
    busy || work.loading || !!work.queueError || !!work.queue[0]?.error;
  const unavailable =
    work.error && (isMissingTable(work.error) || isMissingFunction(work.error));
  return (
    <div className="page custom-work">
      <div className="cw-heading">
        <div>
          <p className="cw-eyebrow">YOUR WORK, RIGHT NOW</p>
          <h1>{t("currentWork.title")}</h1>
          <p>{job?.name ?? (jobId ? "Loading job…" : "No job selected")}</p>
        </div>
        <button onClick={work.clock.openClock}>
          {timed ? t("currentWork.manageClock") : t("currentWork.clock")}
        </button>
      </div>
      <QueueNotice work={work} />
      <CrewWork work={work} jobId={jobId} canRecord={lead} />
      {error && (
        <p role="alert" className="cw-error">
          {error}
        </p>
      )}
      {work.error && (
        <p role="alert" className="cw-error">
          {unavailable
            ? "Custom Data is waiting for its database update. Your existing job clock is still available."
            : formatApiError(work.error)}
        </p>
      )}
      {work.loading && <p>Loading saved work…</p>}
      {!unavailable && (
        <>
          {active && (
            <section
              className="cw-card cw-running"
              aria-label="Current activity"
            >
              <span className="cw-eyebrow">
                {timed
                  ? "● CURRENT ACTIVITY"
                  : "LAST ACTIVITY — CHECK JOB CLOCK"}
              </span>
              <h2>{activeUnit ? `Unit ${activeUnit.label}` : t("currentWork.idle")}</h2>
              <div className="cw-timer">
                {clockText(
                  seconds(
                    active,
                    shift?.break_started_at
                      ? Math.min(now, Date.parse(shift.break_started_at))
                      : now,
                  ),
                )}
              </div>
              <p>
                {activeUnit
                  ? `${activeUnit.type_label} · ${active.stage} · ${active.participation}`
                  : active.description}
              </p>
              {activeUnit && (
                <div className="cw-actions cw-complete-actions">
                  <button
                    className="primary"
                    disabled={blocked}
                    onClick={() => void run(canComplete ? completeUnit : finishMyPart)}
                  >
                    {canComplete
                      ? t("currentWork.unitComplete")
                      : t("currentWork.finishedMyPart")}
                  </button>
                </div>
              )}
              {activeUnit && !canComplete && (
                <p className="cw-field-hint">{t("currentWork.foremanCompletes")}</p>
              )}
              <div className="cw-actions">
                <button disabled={blocked} onClick={() => setIdle(true)}>
                  {t("currentWork.finishIdle")}
                </button>
                <button disabled={blocked} onClick={() => void run(stop)}>
                  {t("currentWork.stop")}
                </button>
              </div>
              {activeUnit && (activeUnit.created_by === work.user || lead) && (
                <button disabled={blocked} onClick={() => setEditing(activeUnit)}>
                  {t("currentWork.editUnit")}
                </button>
              )}
              <details>
                <summary>Outcome and work note</summary>
                <div className="cw-grid">
                  <label>
                    Outcome
                    <select
                      aria-label="Outcome"
                      value={outcome ?? "partial"}
                      onChange={(e) =>
                        setOutcome(e.target.value as WorkSession["outcome"])
                      }
                    >
                      <option value="partial">Partly done / coming back</option>
                      <option value="finished">Finished this work</option>
                      <option value="blocked">Blocked</option>
                      <option value="rework">Rework</option>
                    </select>
                  </label>
                  <label>
                    What did you accomplish?
                    <VoiceTextarea
                      value={finishNote}
                      onChange={(e) => setFinishNote(e.target.value)}
                      placeholder="Short note — phone dictation works here"
                      maxLength={4000}
                    />
                  </label>
                  <label>
                    What slowed you down? (optional)
                    <VoiceInput
                      value={delay}
                      onChange={(e) => setDelay(e.target.value)}
                      maxLength={1000}
                    />
                  </label>
                </div>
              </details>
            </section>
          )}
          <div className="cw-actions cw-primary-actions">
            <button
              className="primary"
              disabled={blocked}
              onClick={() => setEditing("new")}
            >
              {t("currentWork.startUnit")}
            </button>
            <button disabled={blocked} onClick={() => setIdle(true)}>
              {t("currentWork.idle")}
            </button>
            {jobId && (
              <Link
                className="cw-link"
                to={`/projects/${jobId}?tab=maps-interactive`}
              >
                {t("currentWork.map")}
              </Link>
            )}
          </div>
          <label className="cw-stage">
            Work stage
            <select value={stage} onChange={(e) => setStage(e.target.value)}>
              {WORK_STAGES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          {!timed && (
            <p className="muted">
              Save unit details any time. Clock in or resume to begin timed
              work.
            </p>
          )}
          {openingId && opening.isLoading && (
            <p>Loading the selected map unit…</p>
          )}
          {openingId && opening.error && (
            <p role="alert">{formatApiError(opening.error)}</p>
          )}
          {openingId && !opening.isLoading && !opening.data && (
            <p role="alert">
              That map unit is unavailable. You can still create a custom unit.
            </p>
          )}
          {selectedUnit && (
            <section className="cw-card">
              <h2>Selected: {selectedUnit.label}</h2>
              <p>{selectedUnit.type_label}</p>
              <div className="cw-actions">
                <button
                  className="primary"
                  disabled={blocked}
                  onClick={() => void run(() => start(selectedUnit))}
                >
                  Work on this unit
                </button>
                <button
                  disabled={blocked}
                  onClick={() => void run(() => start(selectedUnit, "helper"))}
                >
                  Join as helper
                </button>
              </div>
            </section>
          )}
          {opening.data && !selectedUnit && editing === null && (
            <section className="cw-card">
              <h2>Map unit {opening.data.opening_code}</h2>
              <button disabled={blocked} onClick={() => setEditing("new")}>
                Use this map unit
              </button>
              {activeUnit && !activeUnit.opening_id && (
                <button
                  disabled={blocked}
                  onClick={() =>
                    void run(async () => {
                      await work.command("link", {
                        ...activeUnit,
                        project_id: opening.data!.project_id,
                        opening_id: openingId,
                        reason: "Linked field capture to selected map unit",
                      });
                      setParams({});
                    })
                  }
                >
                  Attach to my current custom record
                </button>
              )}
            </section>
          )}
          {editing && (
            <UnitEditor
              // F1 (crew redesign K1.8, 2026-09-23): keyed on the OPENING only.
              // `jobId` used to be in this key, and it comes from
              // `shift?.project_id`, which resolves asynchronously — so the
              // clock settling mid-entry remounted the editor and threw away
              // everything typed. The editor now takes the late job as a prop
              // (UnitEditor fills a blank Job field itself). The form resets
              // only on Cancel or Save, never on a clock refresh.
              key={editing === "new" ? `new-${openingId ?? "blank"}` : editing.id}
              unit={editing === "new" ? undefined : editing}
              jobId={opening.data?.project_id ?? jobId}
              openingId={editing === "new" ? opening.data?.id : undefined}
              label={editing === "new" ? opening.data?.opening_code : undefined}
              types={work.types}
              existingUnits={work.units}
              defaults={editing === "new" ? mapDefaults : undefined}
              busy={blocked}
              onSave={saveUnit}
              onCancel={() => setEditing(null)}
            />
          )}
          {idle && (
            <section
              id="cw-idle"
              className="cw-card"
              aria-label={t("currentWork.prep.start")}
            >
              <h2>{t("currentWork.idle")}</h2>
              <p className="muted">{t("currentWork.prep.help")}</p>
              <div className="cw-chips">
                {IDLE_REASONS.map((r) => (
                  <button
                    className={idleNote === r ? "selected" : ""}
                    key={r}
                    onClick={() => setIdleNote(r)}
                  >
                    {/* The stored reason stays the English word; the chip
                        speaks the phone's language (K1.5). */}
                    {t(`work.prep.reason.${r}` as never) || r}
                  </button>
                ))}
              </div>
              <label>
                {t("currentWork.prep.what")}
                <VoiceInput
                  value={idleNote}
                  onChange={(e) => setIdleNote(e.target.value)}
                  placeholder={t("currentWork.prep.placeholder")}
                  maxLength={4000}
                />
              </label>
              <div className="cw-actions">
                <button
                  className="primary"
                  disabled={blocked || !idleNote.trim()}
                  onClick={() => void run(() => start(null))}
                >
                  {t("currentWork.prep.start")}
                </button>
                <button onClick={() => setIdle(false)}>{t("currentWork.prep.cancel")}</button>
              </div>
            </section>
          )}
          <section>
            <h2>Units on this job / awaiting assignment</h2>
            <p className="muted">
              No matching unit? Add one above. Helpers record their own join and
              leave times.
            </p>
            <div className="cw-unit-list">
              {available.map((u) => (
                <div className="cw-card" key={u.id}>
                  <strong>{u.label}</strong>
                  {isUnitComplete(u) && (
                    <span className="cw-complete-badge">
                      {t("currentWork.installComplete")}
                    </span>
                  )}
                  <span>
                    {u.type_label} ·{" "}
                    {u.facts.location ||
                      u.facts.story ||
                      "Location not entered"}
                    {!u.project_id ? " · Assign job later" : ""}
                  </span>
                  <div className="cw-actions">
                    <button
                      disabled={blocked}
                      onClick={() => void run(() => start(u))}
                    >
                      {isUnitComplete(u)
                        ? t("currentWork.startAgain")
                        : "Start / resume"}
                    </button>
                    <button
                      disabled={blocked}
                      onClick={() => void run(() => start(u, "helper"))}
                    >
                      Join
                    </button>
                    {(u.created_by === work.user || lead) && (
                      <button disabled={blocked} onClick={() => setEditing(u)}>
                        Details / assign
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
          {jobId && (
            <Link to={`/projects/${jobId}?tab=custom-data`}>
              View this job’s Custom Data →
            </Link>
          )}
        </>
      )}
      <p className="muted">{t("currentWork.prep.footnote")}</p>
    </div>
  );
}
