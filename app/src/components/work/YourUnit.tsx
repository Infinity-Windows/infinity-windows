// "Your unit" on Work (crew redesign K1.2 item 3, K1.4, 2026-09-23): the
// running unit with Pause / Finish, or Next up with one-tap Start, or —
// only when nothing matches — a blank New unit with the duplicate check.
// What shows is decided by lib/work/nextUp.ts; this file only draws it.
//
// Two kinds of unit, two Start buttons: a plan OPENING starts through
// start_opening_work (its timer and gates live on the unit sheet, which the
// tap then opens); a saved custom-work UNIT starts a custom_work_sessions row
// right here. Both are locked while today's toolbox talk is owed (K1.3), and
// the lock is said in words, never by a greyed button alone. The lock is
// drawn from the phone's last read of the record; the server has the same
// gate on both starts (_unit_work_gate, 20261031000000), and when it says
// no the same words come back here, in the phone's language.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Play, Pause, Check, Plus, X } from "lucide-react";
import { listProjects } from "../../lib/api";
import { startOpeningWork } from "../../lib/install/api";
import { isToolboxGateError } from "../../lib/install/installTimer";
import { areaKey } from "../../lib/install/nextOpening";
import type { ProjectOpening } from "../../lib/install/types";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import { matchingUnits } from "../../lib/customWork/matchUnits";
import { clockText, seconds, type WorkType, type WorkUnit } from "../../lib/customWork/model";
import { dropWorkCommand, readWorkQueue } from "../../lib/customWork/queue";
import type { WorkStore } from "../../lib/customWork/useWork";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import type { TimeShift } from "../../lib/timeclock";
import { isPendingShiftId } from "../../lib/work/startDay";
import { openClockGlobally } from "../../lib/clockContext";
import type { NextUp } from "../../lib/work/nextUp";
import { Sheet } from "../ui/Sheet";

export interface YourUnitProps {
  nextUp: NextUp;
  /** Today's talk is owed: unit work stays locked (K1.3). */
  locked: boolean;
  jobId: string | null;
  shift: TimeShift | null;
  work: WorkStore;
  now: number;
}

/** Is the job clock in a state a unit session may start against? */
function timed(shift: TimeShift | null): "ok" | "off" | "break" | "pending" {
  if (!shift || shift.status !== "open") return "off";
  if (isPendingShiftId(shift.id)) return "pending";
  if (shift.break_started_at) return "break";
  return "ok";
}

export function YourUnit({ nextUp, locked, jobId, shift, work, now }: YourUnitProps) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [justAdded, setJustAdded] = useState<WorkUnit | null>(null);
  const clockState = timed(shift);

  // Forge refused because today's talk is not signed. The button was live
  // because the phone's last read said signed (or could not say — the lock
  // fails open, the server is the backstop): say why in the phone's words,
  // point at the talk, and re-read the record so the lock line appears.
  const refusedForTalk = () => {
    void queryClient.invalidateQueries({ queryKey: ["toolboxToday"] });
    return t("work.toolbox.refused");
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(isToolboxGateError(e) ? refusedForTalk() : formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const openSheet = (o: ProjectOpening) => navigate(`/projects/${o.project_id}/opening/${o.id}`);

  // A plan opening: start its timer, then open its sheet. A refused start
  // (a gate the sheet knows how to clear — flashing, a before photo) still
  // opens the sheet, with the reason said out loud: one tap either way. The
  // one refusal the sheet cannot clear is the signature — the talk is on
  // Work, so that one stays here.
  const startOpening = useMutation({
    mutationFn: (o: ProjectOpening) => startOpeningWork(o.id),
    onSuccess: (_, o) => openSheet(o),
    onError: (e, o) => {
      if (isToolboxGateError(e)) {
        pushToast(refusedForTalk(), "error");
        return;
      }
      pushToast(t("work.unit.startFailed", { code: o.opening_code }) + ` ${formatApiError(e)}`, "error");
      openSheet(o);
    },
  });

  // A saved custom unit: the same "start" command Current Work sends.
  const startUnit = (unit: WorkUnit, participation = "install") =>
    run(async () => {
      if (!shift) return;
      await work.command("start", {
        id: crypto.randomUUID(),
        shift_id: shift.id,
        unit_id: unit.id,
        project_id: unit.project_id,
        expected_session_id: work.active?.id ?? null,
        at: new Date().toISOString(),
        stage: "Installing",
        participation,
        description: "",
        delay_reason: "",
      });
      setJustAdded(null);
    });

  const stopUnit = (outcome: "partial" | "finished") =>
    run(async () => {
      if (!work.active) return;
      await work.command("stop", {
        expected_session_id: work.active.id,
        at: new Date().toISOString(),
        outcome,
        finish_note: work.active.description,
        delay_reason: "",
      });
    });

  const blocked = busy || work.actionsLoading || Boolean(work.queueError) || Boolean(work.queue[0]?.error);
  const canStartNewUnit = clockState === "ok" && !locked && !blocked;
  const clockHint =
    clockState === "off"
      ? t("work.quick.needJob")
      : clockState === "pending"
        ? t("work.prep.pendingClock")
        : clockState === "break"
          ? t("clock.title.endBreakToSwitch")
          : null;

  const lockedLine = locked ? <p className="ws-locked" role="status">{t("work.toolbox.locked")}</p> : null;

  let body: React.ReactNode;
  if (nextUp.kind === "running" && nextUp.source === "unit") {
    const { unit, session } = nextUp;
    const secs = seconds(session, shift?.break_started_at ? Math.min(now, Date.parse(shift.break_started_at)) : now);
    body = (
      <>
        <p className="ws-label">{t("work.unit.running")}</p>
        <p className="ws-unit-title">
          {unit.label} <span className="ws-unit-type">{unit.type_label}</span>
        </p>
        <p className="ws-unit-timer">{clockText(secs)}</p>
        {unit.facts.location && <p className="ws-meta">{unit.facts.location}</p>}
        <div className="ws-clock-actions">
          <button type="button" className="ws-btn" disabled={blocked} onClick={() => void stopUnit("partial")}>
            <Pause size={18} aria-hidden /> {t("work.unit.pause")}
          </button>
          <button type="button" className="ws-btn ws-btn--primary" disabled={blocked} onClick={() => void stopUnit("finished")}>
            <Check size={20} aria-hidden /> {t("work.unit.finish")}
          </button>
        </div>
      </>
    );
  } else if (nextUp.kind === "running" && nextUp.source === "opening") {
    const o = nextUp.opening;
    body = (
      <>
        <p className="ws-label">{t("work.unit.running")}</p>
        <p className="ws-unit-title">
          {o.opening_code} <span className="ws-unit-type">{o.window_types?.type_code ?? ""}</span>
        </p>
        <p className="ws-meta">
          {o.projects?.job_code ?? ""} · {areaKey(o)}
        </p>
        <button type="button" className="ws-btn ws-btn--primary" onClick={() => openSheet(o)}>
          {t("work.unit.continue")} ›
        </button>
      </>
    );
  } else if (nextUp.kind === "next") {
    const reason = t(`work.unit.reason.${nextUp.reason}` as const);
    if (nextUp.source === "opening") {
      const o = nextUp.opening;
      body = (
        <>
          <p className="ws-label">
            {t("work.unit.nextUp")} · {reason}
          </p>
          <p className="ws-unit-title">
            {o.opening_code} <span className="ws-unit-type">{o.window_types?.type_code ?? ""}</span>
          </p>
          <p className="ws-meta">
            {o.projects?.job_code ?? ""} · {areaKey(o)}
            {o.label ? ` · ${o.label}` : ""}
          </p>
          {lockedLine}
          {!locked && clockHint && <p className="ws-meta">{clockHint}</p>}
          {/* One tap: start the timer and open the sheet. A refused start (a
              gate the sheet clears) still opens the sheet, with the reason
              said — so there is no separate "Open" button to choose between. */}
          <div className="ws-unit-action-row">
            <button type="button" className="ws-btn ws-btn--primary"
              disabled={locked || clockState !== "ok" || startOpening.isPending}
              onClick={() => startOpening.mutate(o)} data-testid="ws-unit-start">
              <Play size={20} aria-hidden /> {startOpening.isPending ? t("work.unit.starting") : t("work.unit.start")}
            </button>
            <button type="button" className="ws-btn" disabled={blocked} onClick={() => setAdding(true)} data-testid="ws-unit-new">
              <Plus size={18} aria-hidden /> {t("work.unit.new")}
            </button>
          </div>
        </>
      );
    } else {
      const u = nextUp.unit;
      body = (
        <>
          <p className="ws-label">
            {t("work.unit.nextUp")} · {reason}
          </p>
          <p className="ws-unit-title">
            {u.label} <span className="ws-unit-type">{u.type_label}</span>
          </p>
          {(u.facts.location || u.facts.story) && <p className="ws-meta">{u.facts.location || u.facts.story}</p>}
          {lockedLine}
          {!locked && clockHint && <p className="ws-meta">{clockHint}</p>}
          <div className="ws-unit-action-row">
            <button type="button" className="ws-btn ws-btn--primary"
              disabled={locked || clockState !== "ok" || blocked}
              onClick={() => void startUnit(u)} data-testid="ws-unit-start">
              <Play size={20} aria-hidden /> {t("work.unit.start")}
            </button>
            <button type="button" className="ws-btn" disabled={blocked} onClick={() => setAdding(true)} data-testid="ws-unit-new">
              <Plus size={18} aria-hidden /> {t("work.unit.new")}
            </button>
          </div>
        </>
      );
    }
  } else {
    body = (
      <>
        <p className="ws-label">{t("work.unit.nextUp")}</p>
        <p className="ws-meta">{jobId ? t("work.unit.newHelp") : t("work.unit.nothingYet")}</p>
        {lockedLine}
        {!locked && jobId && clockHint && <p className="ws-meta">{clockHint}</p>}
        <button
          type="button"
          className="ws-btn ws-btn--primary"
          disabled={blocked}
          onClick={() => setAdding(true)}
          data-testid="ws-unit-new"
        >
          <Plus size={20} aria-hidden /> {t("work.unit.new")}
        </button>
      </>
    );
  }

  return (
    <section className="ws-card ws-unit" aria-label={t("work.unit.heading")} data-testid="ws-unit">
      {error && <p className="ws-error" role="alert">{error}</p>}
      {work.queue[0]?.error && (
        <div className="ws-error" role="alert" data-testid="ws-unit-sync-error">
          <p>{t("work.unit.syncRefused")}: {isToolboxGateError(work.queue[0].error) ? t("work.toolbox.refused") : work.queue[0].error}</p>
          <button type="button" className="ws-btn" onClick={() => navigate("/stuck")}>{t("work.unit.reviewSync")}</button>
        </div>
      )}
      {body}
      {justAdded && !(nextUp.kind === "running" && nextUp.source === "unit" && nextUp.unit.id === justAdded.id) && (
        <div className="ws-just-added" data-testid="ws-just-added">
          <p className="ws-label">{t("work.unit.justAdded")}</p>
          <p className="ws-unit-title">{justAdded.label} <span className="ws-unit-type">{justAdded.type_label}</span></p>
          <div className="ws-unit-action-row">
            {canStartNewUnit && justAdded.project_id === shift?.project_id ? (
              <button type="button" className="ws-btn ws-btn--primary" disabled={blocked}
                onClick={() => void startUnit(justAdded)}>
                <Play size={18} aria-hidden /> {t("work.unit.start")}
              </button>
            ) : (
              <button type="button" className="ws-btn" onClick={() => openClockGlobally({ projectId: justAdded.project_id, costCodeId: null, note: null, mode: null, switchToProject: true })}>
                {t("work.unit.openClock")}
              </button>
            )}
            <button type="button" className="ws-btn" onClick={() => navigate(`/current-work?job=${justAdded.project_id}&unit=${justAdded.id}&details=1`)}>
              {t("work.unit.details")}
            </button>
          </div>
        </div>
      )}
      {nextUp.kind === "running" && (
        <button type="button" className="ws-btn ws-unit-add" disabled={blocked} onClick={() => setAdding(true)} data-testid="ws-unit-new">
          <Plus size={18} aria-hidden /> {t("work.unit.new")}
        </button>
      )}
      {adding && (
        <NewUnitSheet
          jobId={jobId}
          units={work.units}
          types={work.types}
          busy={blocked}
          startJobId={canStartNewUnit ? shift?.project_id ?? null : null}
          startHint={locked ? t("work.toolbox.locked")
            : clockState === "pending" ? t("work.prep.pendingClock")
              : clockState === "break" ? t("clock.title.endBreakToSwitch")
                : t("work.unit.startAfterClock")}
          onClose={() => setAdding(false)}
          onUseExisting={(u) => {
            setAdding(false);
            if (canStartNewUnit && u.project_id === shift?.project_id) void startUnit(u);
            else navigate(`/current-work?job=${u.project_id}&unit=${u.id}`);
          }}
          onCreate={async (label, type, selectedJobId, start) => {
            setBusy(true);
            setError("");
            try {
              const unit: WorkUnit = {
                id: crypto.randomUUID(),
                project_id: selectedJobId,
                opening_id: null,
                created_by: work.user ?? "",
                label,
                type_label: type || "Unknown",
                facts: {},
                revision: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              };
              const saveUnit = {
                id: unit.id,
                revision: 0,
                project_id: unit.project_id,
                opening_id: null,
                label: unit.label,
                type_label: unit.type_label,
                facts: {},
                reason: "Field capture",
              };
              if (start && shift) {
                // A new unit and its timer must survive together if the app
                // closes mid-sync. This saves both commands on the device in
                // one write before either waits on the network.
                await work.commandMany([
                  { action: "unit", data: saveUnit },
                  { action: "start", data: {
                    id: crypto.randomUUID(), shift_id: shift.id, unit_id: unit.id,
                    project_id: unit.project_id, expected_session_id: work.active?.id ?? null,
                    at: new Date().toISOString(), stage: "Installing", participation: "install",
                    description: "", delay_reason: "",
                  } },
                ]);
              } else {
                await work.command("unit", saveUnit);
              }
              setAdding(false);
              // A server refusal stays in the offline queue for review. Tell
              // the worker immediately; for a missing toolbox signature the
              // refused start can never be replayed at its old timestamp.
              const failed = work.user ? readWorkQueue(work.user).find((c) =>
                c.error && (
                  (c.action === "unit" && c.data.id === unit.id) ||
                  (c.action === "start" && c.data.unit_id === unit.id)
                ),
              ) : undefined;
              if (failed?.error) {
                if (failed.action === "start" && isToolboxGateError(failed.error) && work.user) {
                  await dropWorkCommand(work.user, failed.id);
                  setError(refusedForTalk());
                  setJustAdded(unit);
                } else {
                  setError(formatApiError(failed.error));
                  if (failed.action === "start") setJustAdded(unit);
                }
              } else {
                setJustAdded(unit);
              }
            } catch (e) {
              setError(isToolboxGateError(e) ? refusedForTalk() : formatApiError(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </section>
  );
}

/**
 * The blank New unit (K1.4 / F4): a number and a type, and the duplicate
 * check under the number as it is typed — a match is one tap to USE instead
 * of a twin. The full editor (every fact) stays on Current Work.
 */
function NewUnitSheet({
  jobId,
  units,
  types,
  busy,
  startJobId,
  startHint,
  onClose,
  onUseExisting,
  onCreate,
}: {
  jobId: string | null;
  units: readonly WorkUnit[];
  types: readonly WorkType[];
  busy: boolean;
  startJobId: string | null;
  startHint: string;
  onClose: () => void;
  onUseExisting: (u: WorkUnit) => void;
  onCreate: (label: string, type: string, jobId: string, start: boolean) => Promise<void>;
}) {
  const t = useT();
  const [label, setLabel] = useState("");
  const [type, setType] = useState("");
  const [selectedJobId, setSelectedJobId] = useState(jobId ?? "");
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const dupes = useMemo(() => matchingUnits(units, selectedJobId || null, label), [units, selectedJobId, label]);
  const exact = dupes.some((u) => u.label.trim().toLowerCase() === label.trim().toLowerCase());
  const canStart = !!startJobId && selectedJobId === startJobId;
  return (
    <Sheet open onClose={onClose} label={t("work.unit.new")} className="ws-sheet">
      <div className="ws-sheet-header">
        <button type="button" className="ws-btn ws-sheet-close" onClick={onClose} aria-label={t("work.unit.close")}>
          <X size={20} aria-hidden />
        </button>
        <h2 className="ws-sheet-title">{t("work.unit.new")}</h2>
      </div>
      <label className="ws-label" htmlFor="ws-new-unit-job">{t("work.unit.job")}</label>
      <select id="ws-new-unit-job" className="ws-input" value={selectedJobId} onChange={(e) => setSelectedJobId(e.target.value)}>
        <option value="">{t("work.unit.chooseJob")}</option>
        {jobId && !projects.data?.some((p) => p.id === jobId) && <option value={jobId}>{t("work.unit.currentJob")}</option>}
        {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.job_code} · {p.name}</option>)}
      </select>
      <label className="ws-label" htmlFor="ws-new-unit-label">{t("work.unit.label")}</label>
      <input
        id="ws-new-unit-label"
        className="ws-input"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="16"
        maxLength={120}
      />
      {dupes.length > 0 && (
        <div className="ws-dupes" data-testid="ws-dupes">
          <p className="ws-meta">{t("work.unit.duplicate")}</p>
          <div className="ws-chip-row ws-chip-row--wrap">
            {dupes.slice(0, 6).map((u) => (
              <button key={u.id} type="button" className="ws-chip ws-chip--on" disabled={busy} onClick={() => onUseExisting(u)}>
                {t("work.unit.useExisting", { label: `${u.label} · ${u.type_label}` })}
              </button>
            ))}
          </div>
        </div>
      )}
      <label className="ws-label" htmlFor="ws-new-unit-type">{t("work.unit.type")}</label>
      <input
        id="ws-new-unit-type"
        className="ws-input"
        list="ws-work-types"
        value={type}
        onChange={(e) => setType(e.target.value)}
        maxLength={100}
      />
      <datalist id="ws-work-types">
        {types.filter((x) => !x.archived).map((x) => <option key={x.id} value={x.label} />)}
      </datalist>
      <button
        type="button"
        className="ws-btn ws-btn--primary"
        disabled={busy || !selectedJobId || !label.trim() || !type.trim() || exact}
        onClick={() => void onCreate(label.trim(), type.trim(), selectedJobId, false)}
      >
        <Plus size={20} aria-hidden /> {t("work.unit.save")}
      </button>
      {canStart && (
        <button type="button" className="ws-btn" disabled={busy || !selectedJobId || !label.trim() || !type.trim() || exact}
          onClick={() => void onCreate(label.trim(), type.trim(), selectedJobId, true)}>
          <Play size={20} aria-hidden /> {t("work.unit.saveStart")}
        </button>
      )}
      {!canStart && selectedJobId && <p className="ws-meta">{startHint}</p>}
      <button type="button" className="ws-btn ws-btn--ghost" onClick={onClose}>
        {t("work.prep.cancel")}
      </button>
    </Sheet>
  );
}
