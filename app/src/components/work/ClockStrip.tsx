// The clock strip at the top of Work (crew redesign K1.2 item 1 and K1.3
// Start day, 2026-09-23): status plus one big button.
//
// OFF the clock the button is Start day. Today's scheduled job is already
// picked (else the last job), the cost code follows it, and one tap changes
// either. What the tap does is decided by lib/work/startDay.ts: clock in;
// open the talk and clock in on its signature (today's timing); or — from the
// owner's date — clock in first and sign on the clock. The punch itself is
// startShiftOrQueue: the same clockIn RPC and outbox fallback as every other
// clock-in in the app, never a fork.
//
// ON the clock it is the status line, Break / Resume and Clock out — all of
// which open the same clock sheet as before, which owns the break types, the
// injury flag and the runaway-shift finish. When the talk is still owed the
// "Finish your toolbox talk" card sits directly under it and stays until it
// is signed; unit work below stays locked meanwhile (K1.3).

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coffee, Play, Square } from "lucide-react";
import { listProjects } from "../../lib/api";
import { openClockGlobally } from "../../lib/clockContext";
import { getClockCostCodesForProject } from "../../lib/costCodes";
import { formatApiError } from "../../lib/errors";
import { captureGeoSoft } from "../../lib/geo";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import { effectiveClockInMode, type JobMode } from "../../lib/jobModes";
import type { SafetyTalk } from "../../lib/ops";
import { shiftGuard } from "../../lib/shiftGuard";
import {
  elapsedWorkSeconds,
  formatClock,
  isOnTheClock,
  listRecentJobs,
  type TimeShift,
} from "../../lib/timeclock";
import { pushToast, toastSuccess } from "../../lib/toast";
import { isPendingShiftId, startDayPlan, type StartDayInput } from "../../lib/work/startDay";
import { startShiftOrQueue } from "../../lib/work/startShift";
import { ToolboxSignCard } from "../clock/ToolboxSignCard";
import { JobPickSheet, type JobPick } from "./JobPickSheet";

function clockInLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export interface ClockStripProps {
  profileId: string;
  shift: TimeShift | null;
  /** Today's published job, to preselect (K1.3). */
  todayJobId: string | null;
  talk: SafetyTalk | null;
  gate: StartDayInput;
  /** Refetch the shift and everything keyed off it after a punch. */
  onShiftChanged: () => void;
}

export function ClockStrip({ profileId, shift, todayJobId, talk, gate, onShiftChanged }: ClockStripProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const onClock = isOnTheClock(shift);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!onClock) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [onClock]);

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const recents = useQuery({
    queryKey: ["recentJobs", profileId],
    queryFn: () => listRecentJobs(profileId),
    enabled: !shift,
  });
  const [pick, setPick] = useState<JobPick>({ projectId: "", costCodeId: "", mode: "data", note: "" });
  const costCodes = useQuery({
    queryKey: ["clockCostCodes", pick.projectId || "all"],
    queryFn: () => getClockCostCodesForProject(pick.projectId || null),
    enabled: !shift,
  });
  const [picking, setPicking] = useState(false);
  const [showSign, setShowSign] = useState(false);
  const primedRef = useRef(false);
  const canStartRef = useRef(false);

  // Prime once: today's scheduled job, else the last job, with the cost code
  // that job was last punched on. Never while a shift is open.
  useEffect(() => {
    if (primedRef.current || shift || !recents.isSuccess) return;
    const recent = recents.data ?? [];
    const projectId = todayJobId ?? recent[0]?.projectId ?? "";
    if (!projectId) return;
    primedRef.current = true;
    const match = recent.find((r) => r.projectId === projectId);
    setPick((p) => ({ ...p, projectId, costCodeId: match?.costCodeId ?? recent[0]?.costCodeId ?? "" }));
  }, [recents.isSuccess, recents.data, todayJobId, shift]);

  // A cost code the job's list does not offer is dropped; an empty pick takes
  // the general code, so the common morning is one tap.
  useEffect(() => {
    const list = costCodes.data;
    if (!list || list.length === 0) return;
    if (pick.costCodeId && list.some((c) => c.id === pick.costCodeId)) return;
    const general = list.find((c) => c.is_general) ?? list[0];
    setPick((p) => ({ ...p, costCodeId: general.id }));
  }, [costCodes.data, pick.costCodeId]);

  const project = useMemo(() => (projects.data ?? []).find((p) => p.id === pick.projectId), [projects.data, pick.projectId]);
  const costCode = (costCodes.data ?? []).find((c) => c.id === pick.costCodeId);
  const canStart = Boolean(pick.projectId && pick.costCodeId);
  canStartRef.current = canStart;
  const plan = startDayPlan(gate);

  const doStart = useMutation({
    mutationFn: async () => {
      const geo = await captureGeoSoft();
      const mode: JobMode | null = effectiveClockInMode(project?.allowed_modes, pick.mode);
      return startShiftOrQueue({
        profileId,
        projectId: pick.projectId || null,
        costCodeId: pick.costCodeId || null,
        note: pick.note.trim() || null,
        mode,
        geo,
        projects: projects.data ?? [],
        costCodes: costCodes.data ?? [],
      });
    },
    onSuccess: (r) => {
      setShowSign(false);
      if (r.queued) {
        // The phone shows the punch as real until Forge answers (K0.1 makes
        // that honest app-wide; here it is the same optimistic shift the
        // clock sheet has always shown).
        queryClient.setQueryData(["openShift", profileId], r.shift);
        toastSuccess(t("work.clock.queued"));
      } else {
        toastSuccess(t("clock.toast.clockedIn"));
      }
      onShiftChanged();
    },
    onError: (e) => {
      // A server "no" (not a network gap): say why and hand off to the full
      // sheet with the picks carried, as the classic block does.
      pushToast(t("clockblock.handoff", { reason: formatApiError(e) }), "error");
      openClockGlobally({
        projectId: pick.projectId || null,
        costCodeId: pick.costCodeId || null,
        note: pick.note.trim() || null,
        mode: effectiveClockInMode(project?.allowed_modes, pick.mode),
      });
    },
  });

  const onStartDay = () => {
    if (!canStart) {
      setPicking(true);
      return;
    }
    if (plan === "sign-then-clock-in") {
      setShowSign(true);
      return;
    }
    doStart.mutate();
  };

  // ---- ON the clock --------------------------------------------------------
  if (shift && onClock) {
    const onBreak = Boolean(shift.break_started_at);
    const guard = shiftGuard(shift, now);
    const jobLine = shift.projects ? `${shift.projects.job_code} · ${shift.projects.name}` : t("work.clock.working");
    const pending = isPendingShiftId(shift.id);
    return (
      <>
        <section className="ws-card ws-clock ws-clock--on" aria-label={t("work.clock.a11y")} data-testid="ws-clock">
          <div className="ws-clock-status">
            <span className={`ws-live-dot${onBreak ? " ws-live-dot--break" : ""}`} aria-hidden />
            <span className="ws-clock-label">
              {onBreak ? t("work.clock.onBreak") : t("work.clock.clockedIn", { time: clockInLabel(shift.clock_in_at) })}
            </span>
            <span className="ws-clock-timer" aria-label={t("clock.a11y.timeWorked")}>
              {guard.workedSeconds == null ? t("clockBadge.finish") : formatClock(elapsedWorkSeconds(shift, now))}
            </span>
          </div>
          <p className="ws-clock-job">{jobLine}</p>
          {pending && <p className="ws-meta">{t("work.clock.queued")}</p>}
          <div className="ws-clock-actions">
            <button type="button" className="ws-btn ws-btn--primary" onClick={() => openClockGlobally()}>
              {onBreak ? <Play size={20} aria-hidden /> : <Coffee size={20} aria-hidden />}{" "}
              {onBreak ? t("work.clock.resume") : t("work.clock.break")}
            </button>
            <button type="button" className="ws-btn" onClick={() => openClockGlobally()}>
              <Square size={18} aria-hidden /> {t("work.clock.clockOut")}
            </button>
          </div>
        </section>
        {gate.talkExists === true && gate.signedToday === false && talk && (
          <section className="ws-card ws-talk" aria-label={t("work.toolbox.finish")} data-testid="ws-finish-talk">
            <h2 className="ws-h2">{t("work.toolbox.finish")}</h2>
            <p className="ws-meta">{t("work.toolbox.finishHelp")}</p>
            <ToolboxSignCard profileId={profileId} talk={talk} />
          </section>
        )}
      </>
    );
  }

  // ---- A shift the server stopped counting ---------------------------------
  if (shift && shift.status === "needs_finish") {
    return (
      <section className="ws-card ws-clock ws-clock--finish" aria-label={t("work.clock.a11y")} data-testid="ws-clock">
        <p className="ws-clock-label">{t("work.clock.needsFinish")}</p>
        <p className="ws-meta">{t("work.clock.needsFinishSub")}</p>
        <button type="button" className="ws-btn ws-btn--primary" onClick={() => openClockGlobally()}>
          {t("work.clock.saveFinish")}
        </button>
      </section>
    );
  }

  // ---- OFF the clock: Start day --------------------------------------------
  const busy = doStart.isPending;
  return (
    <section className="ws-card ws-clock ws-clock--off" aria-label={t("work.clock.a11y")} data-testid="ws-clock">
      <div className="ws-clock-pick">
        <div className="ws-clock-pick-text">
          <span className="ws-label">{t("work.clock.job")}</span>
          <span className="ws-clock-pick-job">
            {project ? `${project.job_code} · ${project.name}` : t("work.clock.pickJob")}
          </span>
          {costCode && (
            <span className="ws-meta">
              {t("work.clock.costCode")}: {costCode.code} — {costCode.label}
            </span>
          )}
        </div>
        <button type="button" className="ws-btn ws-btn--ghost" onClick={() => setPicking(true)}>
          {t("work.clock.change")}
        </button>
      </div>

      {showSign && talk && canStart ? (
        <div data-testid="ws-start-talk">
          <ToolboxSignCard
            profileId={profileId}
            talk={talk}
            onSigned={() => {
              // Signing IS the clock-in (today's timing). Picks are read at
              // the moment the signature lands, as the classic block does.
              if (!canStartRef.current) {
                pushToast(t("clockblock.signedPickCode"), "error");
                return;
              }
              doStart.mutate();
            }}
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            className="ws-btn ws-btn--primary ws-btn--start"
            disabled={busy}
            onClick={onStartDay}
            data-testid="ws-start-day"
          >
            <Play size={22} aria-hidden /> {busy ? t("work.clock.starting") : t("work.clock.startDay")}
          </button>
          {canStart && plan === "sign-then-clock-in" && <p className="ws-meta ws-center">{t("work.clock.willOpenTalk")}</p>}
          {canStart && plan === "clock-in-then-sign" && <p className="ws-meta ws-center">{t("work.clock.paidFromTap")}</p>}
        </>
      )}

      <button type="button" className="ws-link" onClick={() => openClockGlobally()}>
        {t("work.clock.moreOptions")}
      </button>

      <JobPickSheet
        open={picking}
        onClose={() => setPicking(false)}
        todayJobId={todayJobId}
        projects={projects.data ?? []}
        recents={recents.data ?? []}
        costCodes={costCodes.data ?? []}
        value={pick}
        onChange={setPick}
      />
    </section>
  );
}
