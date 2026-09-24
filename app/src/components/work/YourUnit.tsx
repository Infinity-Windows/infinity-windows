// "Your unit" on Work (crew redesign K1.2 item 3, K1.4, 2026-09-23): the
// running unit with Pause / Finish, or Next up with one-tap Start, or —
// only when nothing matches — a blank New unit with the duplicate check.
// What shows is decided by lib/work/nextUp.ts; this file only draws it.
//
// Two kinds of unit, two Start buttons: a plan OPENING starts through
// start_opening_work (its timer and gates live on the unit sheet, which the
// tap then opens); a saved custom-work UNIT starts a custom_work_sessions row
// right here. Both are locked while today's toolbox talk is owed (K1.3), and
// the lock is said in words, never by a greyed button alone.

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Play, Pause, Check, Plus } from "lucide-react";
import { startOpeningWork } from "../../lib/install/api";
import { areaKey } from "../../lib/install/nextOpening";
import type { ProjectOpening } from "../../lib/install/types";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import { matchingUnits } from "../../lib/customWork/matchUnits";
import { clockText, seconds, type WorkType, type WorkUnit } from "../../lib/customWork/model";
import type { WorkStore } from "../../lib/customWork/useWork";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import type { TimeShift } from "../../lib/timeclock";
import { isPendingShiftId } from "../../lib/work/startDay";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const clockState = timed(shift);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const openSheet = (o: ProjectOpening) => navigate(`/projects/${o.project_id}/opening/${o.id}`);

  // A plan opening: start its timer, then open its sheet. A refused start
  // (a gate the sheet knows how to clear — flashing, a before photo) still
  // opens the sheet, with the reason said out loud: one tap either way.
  const startOpening = useMutation({
    mutationFn: (o: ProjectOpening) => startOpeningWork(o.id),
    onSuccess: (_, o) => openSheet(o),
    onError: (e, o) => {
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

  const blocked = busy || work.loading || Boolean(work.queueError) || Boolean(work.queue[0]?.error);
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
          <div className="ws-clock-actions">
            <button type="button" className="ws-btn" onClick={() => openSheet(o)}>
              {t("work.unit.open")}
            </button>
            <button
              type="button"
              className="ws-btn ws-btn--primary"
              disabled={locked || clockState !== "ok" || startOpening.isPending}
              onClick={() => startOpening.mutate(o)}
              data-testid="ws-unit-start"
            >
              <Play size={20} aria-hidden /> {startOpening.isPending ? t("work.unit.starting") : t("work.unit.start")}
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
          <button
            type="button"
            className="ws-btn ws-btn--primary"
            disabled={locked || clockState !== "ok" || blocked}
            onClick={() => void startUnit(u)}
            data-testid="ws-unit-start"
          >
            <Play size={20} aria-hidden /> {t("work.unit.start")}
          </button>
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
          disabled={!jobId || locked || clockState !== "ok" || blocked}
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
      {body}
      {adding && jobId && (
        <NewUnitSheet
          jobId={jobId}
          units={work.units}
          types={work.types}
          busy={blocked}
          onClose={() => setAdding(false)}
          onUseExisting={(u) => {
            setAdding(false);
            void startUnit(u);
          }}
          onCreate={(label, type) => {
            setAdding(false);
            void run(async () => {
              const unit: WorkUnit = {
                id: crypto.randomUUID(),
                project_id: jobId,
                opening_id: null,
                created_by: work.user ?? "",
                label,
                type_label: type || "Unknown",
                facts: {},
                revision: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              };
              await work.command("unit", {
                id: unit.id,
                revision: 0,
                project_id: unit.project_id,
                opening_id: null,
                label: unit.label,
                type_label: unit.type_label,
                facts: {},
                reason: "Field capture",
              });
              await startUnit(unit);
            });
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
  onClose,
  onUseExisting,
  onCreate,
}: {
  jobId: string;
  units: readonly WorkUnit[];
  types: readonly WorkType[];
  busy: boolean;
  onClose: () => void;
  onUseExisting: (u: WorkUnit) => void;
  onCreate: (label: string, type: string) => void;
}) {
  const t = useT();
  const [label, setLabel] = useState("");
  const [type, setType] = useState("");
  const dupes = useMemo(() => matchingUnits(units, jobId, label), [units, jobId, label]);
  const exact = dupes.some((u) => u.label.trim().toLowerCase() === label.trim().toLowerCase());
  return (
    <Sheet open onClose={onClose} label={t("work.unit.new")} className="ws-sheet">
      <h2 className="ws-sheet-title">{t("work.unit.new")}</h2>
      <label className="ws-label" htmlFor="ws-new-unit-label">{t("work.unit.label")}</label>
      <input
        id="ws-new-unit-label"
        className="ws-input"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="16"
        maxLength={120}
        autoFocus
      />
      {dupes.length > 0 && (
        <div className="ws-dupes" data-testid="ws-dupes">
          <p className="ws-meta">{t("work.unit.duplicate")}</p>
          <div className="ws-chip-row ws-chip-row--wrap">
            {dupes.slice(0, 6).map((u) => (
              <button key={u.id} type="button" className="ws-chip ws-chip--on" onClick={() => onUseExisting(u)}>
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
        disabled={busy || !label.trim() || exact}
        onClick={() => onCreate(label.trim(), type.trim())}
      >
        <Play size={20} aria-hidden /> {t("work.unit.start")}
      </button>
      <button type="button" className="ws-btn ws-btn--ghost" onClick={onClose}>
        {t("work.prep.cancel")}
      </button>
    </Sheet>
  );
}
