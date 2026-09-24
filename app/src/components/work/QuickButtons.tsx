// The four quick buttons on Work (crew redesign K1.2 item 4, 2026-09-23):
// Prep time · Take supplies · Daily log · Report a problem. Each is a door
// to something that already saves a record today — never a dead end. Take
// supplies goes to the supplies screen until Release 4 builds the one-screen
// take; Daily log opens the same dialog the Capture sheet opens.
//
// A running prep-time session shows above the buttons with its own Stop,
// because "what is my clock on right now" is the question this row answers.
//
// Prep time waits for today's toolbox talk exactly like unit work (K1.3,
// the owner's answer of 2026-09-24): on the clock with the talk owed, the
// button carries a lock and a tap says so in words; the server has the same
// gate (_prep_time_gate, 20261031000000), and when it says no the same words
// come back here, in the phone's language, and the record is re-read.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Lock, NotebookPen, Package, Timer } from "lucide-react";
import { localDateISO } from "../../lib/dailyLogDay";
import { canUseDailyLogs } from "../../lib/dailyLogAccess";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import { clockText, seconds, type PrepReason } from "../../lib/customWork/model";
import type { WorkStore } from "../../lib/customWork/useWork";
import { formatApiError } from "../../lib/errors";
import { isToolboxGateError } from "../../lib/install/installTimer";
import { pushToast } from "../../lib/toast";
import type { TimeShift } from "../../lib/timeclock";
import { isPendingShiftId } from "../../lib/work/startDay";
import { DailyLogDialog } from "../dailyLogs/DailyLogDialog";
import { PrepTimeSheet } from "./PrepTimeSheet";
import { ReportProblemSheet } from "./ReportProblemSheet";

export interface QuickButtonsProps {
  role: string | null | undefined;
  jobId: string | null;
  jobLabel: string | null;
  shift: TimeShift | null;
  work: WorkStore;
  /** The unit on screen, so a problem can name it. */
  unit?: { openingId?: string | null; label: string } | null;
  /** Today's talk is owed: Prep time stays locked, like unit work (K1.3). */
  locked: boolean;
  now: number;
}

export function QuickButtons({ role, jobId, jobLabel, shift, work, unit, locked, now }: QuickButtonsProps) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [prepOpen, setPrepOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [problemOpen, setProblemOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const canLog = canUseDailyLogs(role);
  const prepSession = work.active && !work.active.unit_id ? work.active : null;
  const clockOk = Boolean(shift && shift.status === "open" && !shift.break_started_at);
  // Off the clock, Start day is the answer (it handles the talk); the lock is
  // the reason only once the clock is running.
  const prepLocked = clockOk && locked;

  const needJob = () => pushToast(t("work.quick.needJob"), "info");
  const tapPrep = () => {
    if (!clockOk) return pushToast(t("work.prep.needClock"), "info");
    if (prepLocked) return pushToast(t("work.prep.locked"), "info");
    setPrepOpen(true);
  };

  const startPrep = async (reason: PrepReason, note: string) => {
    if (!shift) return needJob();
    if (isPendingShiftId(shift.id)) return pushToast(t("work.prep.pendingClock"), "info");
    setBusy(true);
    try {
      await work.command("start", {
        id: crypto.randomUUID(),
        shift_id: shift.id,
        unit_id: null,
        project_id: shift.project_id,
        expected_session_id: work.active?.id ?? null,
        at: new Date().toISOString(),
        // The stored identifier for a non-unit session is unchanged (K1.5:
        // "stored identifiers unchanged"); only the words on screen moved.
        stage: "Idle time",
        participation: "install",
        description: note ? `${reason} — ${note}` : reason,
        delay_reason: "",
      });
      setPrepOpen(false);
    } catch (e) {
      if (isToolboxGateError(e)) {
        // Forge refused because today's talk is not signed. The sheet was
        // open because the phone's last read said signed (or could not say
        // — the lock fails open, the server is the backstop): say why in
        // the phone's words, point at the talk, and re-read the record so
        // the lock appears. Nothing was recorded.
        setPrepOpen(false);
        void queryClient.invalidateQueries({ queryKey: ["toolboxToday"] });
        pushToast(t("work.prep.refused"), "error");
      } else {
        pushToast(formatApiError(e), "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const stopPrep = async () => {
    if (!work.active) return;
    setBusy(true);
    try {
      await work.command("stop", {
        expected_session_id: work.active.id,
        at: new Date().toISOString(),
        outcome: "finished",
        finish_note: work.active.description,
        delay_reason: "",
      });
    } catch (e) {
      pushToast(formatApiError(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-quick-wrap" aria-label={t("work.quick.prep")} data-testid="ws-quick">
      {prepSession && (
        <div className="ws-card ws-prep-running" data-testid="ws-prep-running">
          <p className="ws-unit-title">
            {t("work.prep.running", { reason: prepSession.description || t("work.prep.reason.Other") })}
          </p>
          <p className="ws-unit-timer">
            {clockText(seconds(prepSession, shift?.break_started_at ? Math.min(now, Date.parse(shift.break_started_at)) : now))}
          </p>
          <button type="button" className="ws-btn" disabled={busy} onClick={() => void stopPrep()}>
            {t("work.prep.stop")}
          </button>
        </div>
      )}
      <div className="ws-quick">
        <button
          type="button"
          className="ws-btn ws-quick-btn"
          onClick={tapPrep}
          data-testid="ws-quick-prep"
          data-locked={prepLocked ? "true" : undefined}
        >
          {prepLocked ? <Lock size={20} aria-hidden /> : <Timer size={20} aria-hidden />} {t("work.quick.prep")}
        </button>
        <button type="button" className="ws-btn ws-quick-btn" onClick={() => navigate("/supplies")}>
          <Package size={20} aria-hidden /> {t("work.quick.supplies")}
        </button>
        {canLog && (
          <button
            type="button"
            className="ws-btn ws-quick-btn"
            onClick={() => (jobId ? setLogOpen(true) : needJob())}
            data-testid="ws-quick-log"
          >
            <NotebookPen size={20} aria-hidden /> {t("work.quick.log")}
          </button>
        )}
        <button
          type="button"
          className="ws-btn ws-quick-btn"
          onClick={() => (jobId ? setProblemOpen(true) : needJob())}
          data-testid="ws-quick-problem"
        >
          <AlertTriangle size={20} aria-hidden /> {t("work.quick.problem")}
        </button>
      </div>

      <PrepTimeSheet open={prepOpen} onClose={() => setPrepOpen(false)} onStart={(r, n) => void startPrep(r, n)} busy={busy} />
      {logOpen && jobId && (
        <DailyLogDialog projectId={jobId} logDate={localDateISO()} jobLabel={jobLabel ?? ""} onClose={() => setLogOpen(false)} />
      )}
      {jobId && (
        <ReportProblemSheet
          open={problemOpen}
          onClose={() => setProblemOpen(false)}
          projectId={jobId}
          openingId={unit?.openingId ?? null}
          unitLabel={unit?.label ?? null}
        />
      )}
    </section>
  );
}
