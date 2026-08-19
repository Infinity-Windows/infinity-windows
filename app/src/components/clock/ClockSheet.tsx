import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowLeftRight,
  Coffee,
  Pause,
  Play,
  Square,
  UtensilsCrossed,
  X,
  type LucideIcon,
} from "lucide-react";
import { listProjects } from "../../lib/api";
import { listMyPublished } from "../../lib/schedule/api";
import { captureGeoSoft } from "../../lib/geo";
import { pushToast, toastError, toastSuccess } from "../../lib/toast";
import { supabase } from "../../lib/supabase";
import { getMyOpenSession } from "../../lib/install/sessions";
import { isNetworkError } from "../../lib/offline/outbox-core";
import {
  enqueueBreakStart,
  enqueueBreakStop,
  enqueueClockIn,
  enqueueClockOut,
  pendingRefForShift,
} from "../../lib/offline/outbox";
import { ToolboxTalkNagBanner } from "../time/ToolboxTalkNagBanner";
import { ToolboxSignCard } from "./ToolboxSignCard";
import { myTodayCompletion } from "../../lib/toolbox";
import { getTodayTalk } from "../../lib/ops";
import { listMyOpeningsAllJobs, startOpeningWork } from "../../lib/install/api";
import {
  formatPhaseClock,
  listMyActivePhases,
  pauseOpeningPhase,
  phaseElapsedSeconds,
  resumeOpeningPhase,
} from "../../lib/install/phases";
import {
  BREAK_TYPES,
  breakTypeLabel,
  clockIn,
  clockOut,
  currentBreakSeconds,
  elapsedWorkSeconds,
  endBreak,
  finishShiftAt,
  formatClock,
  isOnTheClock,
  listCostCodes,
  listRecentJobs,
  startBreak,
  type BreakType,
  type TimeShift,
} from "../../lib/timeclock";
import {
  checkFinishTime,
  describeDuration,
  finishTimeBounds,
  shiftGuard,
  SHIFT_CAP_HOURS,
  type FinishTimeCheck,
} from "../../lib/shiftGuard";

const BREAK_ICONS: Record<BreakType, LucideIcon> = {
  lunch: UtensilsCrossed,
  rest: Coffee,
  other: Pause,
};

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A `<input type="datetime-local">` value → ISO, or null if it is unusable. */
function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

type Mode = "pick" | "main" | "break-type" | "switch";

export function ClockSheet({
  profileId,
  shift,
  onClose,
  onChanged,
}: {
  profileId: string | null;
  shift: TimeShift | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>(shift ? "main" : "pick");
  const [pickProjectId, setPickProjectId] = useState<string>("");
  const [pickCostCodeId, setPickCostCodeId] = useState<string>("");
  /** Optional first window to start on, in the same tap as clocking in. */
  const [pickOpeningId, setPickOpeningId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [showFullList, setShowFullList] = useState(false);
  const [note, setNote] = useState("");
  const [injured, setInjured] = useState(false);
  // "What happened?" — appears the moment the injured box is ticked (owner
  // ask, 2026-08-19). The app is the record, never the emergency channel —
  // the label says so in plain words.
  const [injuryNote, setInjuryNote] = useState("");
  // The BusyBusy-style sign-off, inverted to keep clock-out one tap: leaving
  // this unchecked IS "yes, my time is correct" (time_confirmed = true), and
  // checking it flags the day for office review without ever blocking the
  // clock-out. The column has existed since the time clock shipped; this is
  // the first UI that actually asks.
  const [timeWrong, setTimeWrong] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [finishAt, setFinishAt] = useState("");
  const primedRef = useRef(false);

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const costCodes = useQuery({ queryKey: ["costCodes"], queryFn: listCostCodes });
  const recents = useQuery({
    queryKey: ["recentJobs", profileId],
    queryFn: () => listRecentJobs(profileId!),
    enabled: Boolean(profileId),
  });
  const todayISO = todayLocalISO();
  const scheduledToday = useQuery({
    queryKey: ["mySchedule", profileId, todayISO, todayISO],
    queryFn: () => listMyPublished(profileId!, todayISO, todayISO),
    enabled: Boolean(profileId) && !shift,
  });
  const scheduled = scheduledToday.data?.[0] ?? null;

  // The whole morning ritual lives in this sheet: today's talk (sign it here,
  // not on a separate page) and the assigned windows on the picked job (start
  // the first one in the same tap as the clock-in).
  const todayTalk = useQuery({
    queryKey: ["todayTalk"],
    queryFn: getTodayTalk,
    enabled: !shift,
  });
  const toolboxDone = useQuery({
    queryKey: ["toolboxToday", profileId],
    queryFn: () => myTodayCompletion(profileId!),
    enabled: Boolean(profileId) && !shift,
  });
  const myPhases = useQuery({
    queryKey: ["myActivePhases", profileId],
    queryFn: () => listMyActivePhases(profileId!),
    enabled: Boolean(profileId) && Boolean(shift),
    refetchInterval: 30_000,
  });
  const myOpenings = useQuery({
    queryKey: ["myOpenings", profileId],
    queryFn: () => listMyOpeningsAllJobs(profileId!),
    enabled: Boolean(profileId) && !shift,
  });
  // Signed, or no talk exists today: nothing to sign either way.
  const toolboxOk = Boolean(toolboxDone.data) || todayTalk.data === null;
  const projectOpenings = useMemo(
    () =>
      (myOpenings.data ?? []).filter(
        (o) => o.project_id === pickProjectId && o.status !== "installed",
      ),
    [myOpenings.data, pickProjectId],
  );
  const pickedOpening = projectOpenings.find((o) => o.id === pickOpeningId) ?? null;

  // Follow the shift state: entering a shift -> main; leaving -> pick.
  useEffect(() => {
    setMode(shift ? "main" : "pick");
  }, [shift?.id]);

  // 1s tick drives the live timers.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Prime the picker with today's scheduled job when there is one (fewer wrong
  // clock-ins), otherwise fall back to the most recent job so "Resume" is one tap.
  useEffect(() => {
    if (primedRef.current || shift) return;
    const r = recents.data?.[0];
    if (scheduled) {
      primedRef.current = true;
      setPickProjectId(scheduled.project_id);
      const match = recents.data?.find((j) => j.projectId === scheduled.project_id);
      const costCodeId = match?.costCodeId ?? r?.costCodeId;
      if (costCodeId) setPickCostCodeId(costCodeId);
      return;
    }
    if (r) {
      primedRef.current = true;
      setPickProjectId(r.projectId);
      if (r.costCodeId) setPickCostCodeId(r.costCodeId);
    }
  }, [scheduled, recents.data, shift]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["openShift"] });
    void queryClient.invalidateQueries({ queryKey: ["myShifts"] });
    void queryClient.invalidateQueries({ queryKey: ["recentJobs"] });
    onChanged();
  };

  // A punch either goes straight through (online + healthy) or gets saved to
  // the offline outbox and synced later. Callers show the right copy off this.
  type PunchResult = {
    queued: boolean;
    /** Opening whose install clock started in the same tap, when one did. */
    startedOpening?: string | null;
    startFailed?: boolean;
  };

  const shouldQueue = (err: unknown) =>
    typeof navigator !== "undefined" && navigator.onLine === false
      ? true
      : isNetworkError(err);

  const openShiftKey = ["openShift", profileId] as const;

  /** Optimistically drop a synthetic open shift into the cache while queued. */
  const setOptimisticShift = (next: TimeShift | null) => {
    queryClient.setQueryData(openShiftKey, next);
    onChanged();
  };

  const synthOpenShift = (
    entryId: string,
    projectId: string | null,
    costCodeId: string | null,
    noteText: string | null = null,
  ): TimeShift => {
    const proj = (projects.data ?? []).find((p) => p.id === projectId);
    const cc = (costCodes.data ?? []).find((c) => c.id === costCodeId);
    const nowIso = new Date().toISOString();
    return {
      id: pendingRefForShift(entryId),
      profile_id: profileId ?? "",
      project_id: projectId,
      cost_code_id: costCodeId,
      clock_in_at: nowIso,
      clock_out_at: null,
      break_seconds: 0,
      break_started_at: null,
      break_type: null,
      injured: null,
      time_confirmed: null,
      status: "open",
      created_at: nowIso,
      note: noteText,
      projects: proj ? { job_code: proj.job_code, name: proj.name } : null,
      cost_codes: cc ? { code: cc.code, label: cc.label } : null,
    };
  };

  const pausePhase = useMutation({
    mutationFn: (ph: { opening_id: string; kind: "flashing" }) =>
      pauseOpeningPhase(ph.opening_id, ph.kind),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["myActivePhases"] }),
    onError: (e) => toastError(e),
  });
  const resumePhase = useMutation({
    mutationFn: (ph: { opening_id: string; kind: "flashing" }) =>
      resumeOpeningPhase(ph.opening_id, ph.kind),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["myActivePhases"] }),
    onError: (e) => toastError(e),
  });
  const phaseBusy = pausePhase.isPending || resumePhase.isPending;

  const doStart = useMutation<PunchResult>({
    mutationFn: async () => {
      const geo = await captureGeoSoft();
      const projectId = pickProjectId || null;
      const costCodeId = pickCostCodeId || null;
      const noteText = note.trim() || null;
      try {
        await clockIn(projectId, costCodeId, geo, noteText);
        // Same tap starts the first window when one was picked. The clock-in
        // stands even if this part fails — a refused start must never un-ring
        // that bell, so the failure becomes a toast, not an error.
        let startedOpening: string | null = null;
        let startFailed = false;
        if (pickedOpening && toolboxOk) {
          try {
            await startOpeningWork(pickedOpening.id);
            startedOpening = pickedOpening.id;
          } catch {
            startFailed = true;
          }
        }
        return { queued: false, startedOpening, startFailed };
      } catch (e) {
        if (!shouldQueue(e)) throw e;
        const entryId = await enqueueClockIn({
          projectId,
          costCodeId,
          lat: geo?.lat ?? null,
          lng: geo?.lng ?? null,
          note: noteText,
        });
        setOptimisticShift(synthOpenShift(entryId, projectId, costCodeId, noteText));
        // Offline: the punch is queued, but a unit start can't be confirmed
        // against the server gate — they start it from My Work once in signal.
        return { queued: true };
      }
    },
    onSuccess: (r) => {
      if (r.startedOpening && pickedOpening) {
        toastSuccess(`Clocked in — clock running on ${pickedOpening.opening_code}`);
      } else {
        toastSuccess(
          r.queued ? "Clocked in — we'll sync it when you're back online" : "Clocked in",
        );
      }
      if (r.startFailed && pickedOpening) {
        pushToast(
          `Couldn't start ${pickedOpening.opening_code} — open it from My Work to start the clock on it.`,
          "error",
        );
      }
      if (!r.queued) refresh();
      if (r.startedOpening && pickedOpening) {
        navigate(`/projects/${pickedOpening.project_id}/opening/${r.startedOpening}`);
      }
      onClose();
    },
    onError: (e) => toastError(e),
  });

  const doSwitch = useMutation<PunchResult>({
    mutationFn: async () => {
      const geo = await captureGeoSoft();
      const projectId = pickProjectId || null;
      const costCodeId = pickCostCodeId || null;
      const noteText = note.trim() || null;
      try {
        // clock_in auto-closes the prior open shift, so switching leaves no gap.
        await clockIn(projectId, costCodeId, geo, noteText);
        return { queued: false };
      } catch (e) {
        if (!shouldQueue(e)) throw e;
        const entryId = await enqueueClockIn({
          projectId,
          costCodeId,
          lat: geo?.lat ?? null,
          lng: geo?.lng ?? null,
          note: noteText,
        });
        setOptimisticShift(synthOpenShift(entryId, projectId, costCodeId, noteText));
        return { queued: true };
      }
    },
    onSuccess: (r) => {
      toastSuccess(r.queued ? "Switch saved — we'll sync it when you're back online" : "Switched project");
      if (!r.queued) refresh();
      onClose();
    },
    onError: (e) => toastError(e),
  });

  const doPhaseSwitch = useMutation<PunchResult, Error, string>({
    mutationFn: async (costCodeId: string) => {
      const geo = await captureGeoSoft();
      const projectId = shift?.project_id ?? null;
      try {
        await clockIn(projectId, costCodeId, geo);
        return { queued: false };
      } catch (e) {
        if (!shouldQueue(e)) throw e;
        const entryId = await enqueueClockIn({
          projectId,
          costCodeId,
          lat: geo?.lat ?? null,
          lng: geo?.lng ?? null,
        });
        setOptimisticShift(synthOpenShift(entryId, projectId, costCodeId));
        return { queued: true };
      }
    },
    onSuccess: (r) => {
      toastSuccess(r.queued ? "Cost code saved — will sync when online" : "Switched cost code");
      if (!r.queued) refresh();
    },
    onError: (e) => toastError(e),
  });

  const doBreakStart = useMutation<PunchResult, Error, BreakType>({
    mutationFn: async (type: BreakType) => {
      try {
        await startBreak(shift!.id, type);
        return { queued: false };
      } catch (e) {
        if (!shouldQueue(e)) throw e;
        await enqueueBreakStart(shift!.id, type);
        if (shift) {
          setOptimisticShift({
            ...shift,
            break_started_at: new Date().toISOString(),
            break_type: type,
          });
        }
        return { queued: true };
      }
    },
    onSuccess: (r, type) => {
      pushToast(
        r.queued
          ? `On ${breakTypeLabel(type).toLowerCase()} break — will sync when online`
          : `On ${breakTypeLabel(type).toLowerCase()} break`,
        "info",
      );
      setMode("main");
      // The server paused this person's phase clocks with the break — re-read
      // them so the "You're on" card shows paused immediately.
      void queryClient.invalidateQueries({ queryKey: ["myActivePhases"] });
      if (!r.queued) refresh();
    },
    onError: (e) => toastError(e),
  });

  const doBreakEnd = useMutation<PunchResult>({
    mutationFn: async () => {
      try {
        await endBreak(shift!.id);
        return { queued: false };
      } catch (e) {
        if (!shouldQueue(e)) throw e;
        await enqueueBreakStop(shift!.id);
        if (shift) {
          setOptimisticShift({
            ...shift,
            break_seconds: currentBreakSeconds(shift, Date.now()),
            break_started_at: null,
            break_type: null,
          });
        }
        return { queued: true };
      }
    },
    onSuccess: (r) => {
      toastSuccess(r.queued ? "Back on the clock — will sync when online" : "Back on the clock");
      if (!r.queued) refresh();
      // The held unit auto-resumed server-side (sessions trigger, owner
      // call): tell them which window they're back on.
      if (!r.queued) {
        void (async () => {
          try {
            const uid = (await supabase.auth.getUser()).data.user?.id;
            if (!uid) return;
            const open = await getMyOpenSession(uid);
            if (!open) return;
            const { data } = await supabase
              .from("project_openings")
              .select("opening_code")
              .eq("id", open.opening_id)
              .maybeSingle();
            const code = (data as { opening_code?: string } | null)?.opening_code;
            if (code) toastSuccess(`Back on unit ${code} — clock's running.`);
          } catch {
            /* cosmetic only */
          }
        })();
      }
    },
    onError: (e) => toastError(e),
  });

  const doClockOut = useMutation<PunchResult>({
    mutationFn: async () => {
      const geo = await captureGeoSoft();
      const breakSeconds = currentBreakSeconds(shift!, Date.now());
      try {
        await clockOut(shift!.id, {
          injured,
          injuryNote,
          timeConfirmed: !timeWrong,
          breakSeconds,
          geo,
        });
        return { queued: false };
      } catch (e) {
        if (!shouldQueue(e)) throw e;
        await enqueueClockOut({
          shiftRef: shift!.id,
          injured,
          injuryNote: injured ? injuryNote.trim() || null : null,
          timeConfirmed: !timeWrong,
          breakSeconds,
          lat: geo?.lat ?? null,
          lng: geo?.lng ?? null,
        });
        // Optimistically clear the open shift — the crew is off the clock now.
        setOptimisticShift(null);
        return { queued: true };
      }
    },
    onSuccess: (r) => {
      toastSuccess(r.queued ? "Clocked out — we'll sync it when you're back online" : "Clocked out");
      setInjured(false);
      setInjuryNote("");
      setTimeWrong(false);
      if (!r.queued) refresh();
      onClose();
    },
    onError: (e) => toastError(e),
  });

  /**
   * The shift ran so long that the running total is no longer evidence of a
   * working day. We hand the question back to the person instead of stamping
   * `now()` on it — see lib/shiftGuard.ts for why that mattered.
   */
  const doFinish = useMutation({
    mutationFn: async () => {
      const check = checkFinishTime(shift!, localInputToIso(finishAt), Date.now());
      if (!check.ok) throw new Error(check.error ?? "That finish time won't work.");
      return finishShiftAt(shift!.id, localInputToIso(finishAt)!, {
        injured,
        breakSeconds: shift!.break_seconds ?? 0,
      });
    },
    onSuccess: () => {
      toastSuccess("Thanks — your hours are with the office to check");
      setInjured(false);
      setFinishAt("");
      refresh();
      onClose();
    },
    onError: (e) => toastError(e),
  });

  const onBreak = Boolean(shift?.break_started_at);
  const breakSec = shift ? currentBreakSeconds(shift, now) : 0;
  const runningBreakSec =
    shift?.break_started_at
      ? Math.max(0, Math.floor((now - new Date(shift.break_started_at).getTime()) / 1000))
      : 0;
  const workSec = shift ? elapsedWorkSeconds(shift, now) : 0;

  // Clock-in is no longer gated on today's toolbox talk — installers can always
  // start their shift. A non-blocking nag banner (below) nudges them to sign it.
  // The one exception: starting a WINDOW in the same tap does require the talk
  // (the server refuses without it), so a picked window + unsigned talk holds
  // the button with a hint instead of failing after the fact.
  const canStart =
    Boolean(pickProjectId && pickCostCodeId) && !(pickedOpening && !toolboxOk);

  const busy =
    doStart.isPending ||
    doSwitch.isPending ||
    doPhaseSwitch.isPending ||
    doBreakStart.isPending ||
    doBreakEnd.isPending ||
    doClockOut.isPending ||
    doFinish.isPending;

  const guard = shift ? shiftGuard(shift, now) : null;
  /** Past the believable maximum: stop counting and ask for the real finish. */
  const needsRealFinish =
    guard?.state === "over-cap" || guard?.state === "needs-finish";
  const finishCheck: FinishTimeCheck = shift
    ? checkFinishTime(shift, localInputToIso(finishAt), now)
    : { ok: false };
  const finishBounds = shift ? finishTimeBounds(shift, now) : null;

  const filteredProjects = useMemo(() => {
    const list = projects.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) =>
      `${p.job_code} ${p.name} ${p.address ?? ""}`.toLowerCase().includes(q),
    );
  }, [projects.data, search]);

  const pickedProject = (projects.data ?? []).find((p) => p.id === pickProjectId);
  const resumeJob = recents.data?.[0];
  const canResume =
    !shift &&
    resumeJob &&
    pickProjectId === resumeJob.projectId &&
    Boolean(pickCostCodeId);

  const title =
    mode === "switch"
      ? "Switch project"
      : mode === "break-type"
        ? "Go on break"
        : shift
          ? onBreak
            ? "On break"
            : "On the clock"
          : "Where are you working?";

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div className="clock-sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="clock-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Time clock"
        onClick={stop}
      >
        <div className="clock-sheet-grip" aria-hidden />
        <div className="clock-sheet-head">
          <h2 className="clock-sheet-title">{title}</h2>
          <button type="button" className="clock-sheet-x" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* ---- ON THE CLOCK ---- */}
        {mode === "main" && shift && (
          <div className="clock-sheet-body">
            <ToolboxTalkNagBanner
              profileId={profileId}
              clockedIn={isOnTheClock(shift)}
              onNavigate={onClose}
            />
            {needsRealFinish ? (
              /* We stopped counting on purpose. Ask, never guess. */
              <div className="clock-hero-card needs-finish">
                <span className="clock-status-pill needs-finish">
                  Clock stopped counting
                </span>
                <p className="clock-hero-stopped">
                  You've been clocked in for{" "}
                  <strong>{describeDuration(guard!.sinceClockInSeconds)}</strong>.
                </p>
                <p className="clock-hero-sub">
                  That's longer than a shift can really run, so we stopped adding
                  hours rather than put a made-up number on your timecard. When
                  did you actually finish?
                </p>
              </div>
            ) : (
              <div className={onBreak ? "clock-hero-card break" : "clock-hero-card work"}>
                <span className={onBreak ? "clock-status-pill break" : "clock-status-pill work"}>
                  <span className="clock-live-dot" aria-hidden />
                  {onBreak ? `On ${breakTypeLabel(shift.break_type).toLowerCase()} break` : "Working"}
                </span>
                <div className="clock-hero-time">
                  {formatClock(onBreak ? runningBreakSec : workSec)}
                </div>
                {onBreak ? (
                  <p className="clock-hero-sub">
                    Worked so far <strong>{formatClock(workSec)}</strong>
                  </p>
                ) : (
                  breakSec > 0 && (
                    <p className="clock-hero-sub">Breaks today {formatClock(breakSec)}</p>
                  )
                )}
                {guard?.state === "long" && (
                  <p className="clock-hero-warn">
                    That's a long day — clock out when you're done, or the app
                    will stop counting at {SHIFT_CAP_HOURS} hours and ask you for
                    the real finish time.
                  </p>
                )}
              </div>
            )}

            <button
              type="button"
              className="clock-job-chip"
              disabled={busy || onBreak || needsRealFinish}
              onClick={() => {
                setPickProjectId(shift.project_id ?? "");
                setPickCostCodeId(shift.cost_code_id ?? "");
                setMode("switch");
              }}
              title={onBreak ? "End break to switch project" : "Tap to switch project"}
            >
              <span className="clock-job-chip-main">
                <span className="clock-job-chip-label">Job</span>
                <span className="clock-job-chip-name">
                  {shift.projects?.job_code ?? "—"} · {shift.projects?.name ?? "No job"}
                </span>
                {shift.cost_codes && (
                  <span className="clock-job-chip-code">
                    {shift.cost_codes.code} — {shift.cost_codes.label}
                  </span>
                )}
              </span>
              <span className="clock-job-chip-arrow" aria-hidden>
                <ArrowLeftRight size={16} />
              </span>
            </button>

            {/* What your time is going to RIGHT NOW — the task under the
                shift. A flashing clock shows live (net of pauses) with its
                own Pause/Resume; tapping the row opens that window's sheet.
                Between tasks says so, which quietly surfaces off-task time. */}
            {!needsRealFinish && (myPhases.data ?? []).length > 0 && (
              <div className="clock-chip-row-wrap">
                <p className="clock-row-label">You're on</p>
                {(myPhases.data ?? []).map((ph) => (
                  <div
                    key={ph.id}
                    className="detail-card"
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}
                  >
                    <span aria-hidden style={{ width: 10, height: 10, borderRadius: "50%", background: "#3fd4c0", flex: "none" }} />
                    <button
                      className="link"
                      style={{ textAlign: "left", minWidth: 0 }}
                      onClick={() => {
                        onClose();
                        navigate(`/projects/${ph.opening?.project_id}/opening/${ph.opening_id}`);
                      }}
                    >
                      <strong>Flashing · {ph.opening?.opening_code ?? "?"}</strong>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {" "}· {ph.opening?.projects?.job_code ?? ""}
                      </span>
                    </button>
                    <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
                      {ph.paused_at ? "paused · " : ""}
                      {formatPhaseClock(phaseElapsedSeconds(ph, now))}
                    </span>
                    {ph.paused_at ? (
                      <button
                        className="button-like active-pill"
                        disabled={phaseBusy}
                        onClick={() => resumePhase.mutate(ph)}
                      >
                        Resume
                      </button>
                    ) : (
                      <button
                        className="button-like"
                        disabled={phaseBusy}
                        onClick={() => pausePhase.mutate(ph)}
                      >
                        Pause
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Switch cost code — one tap, same job. Hidden while a finish time is
                outstanding: switching calls clock_in, and the question on the
                screen is "when did you stop", not "what are you doing now". */}
            {!onBreak && !needsRealFinish && (costCodes.data?.length ?? 0) > 1 && (
              <div className="clock-chip-row-wrap">
                <p className="clock-row-label">Switch cost code</p>
                <div className="clock-chip-row wrap">
                  {(costCodes.data ?? []).map((c) => {
                    const current = shift.cost_code_id === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className={current ? "clock-chip cost current" : "clock-chip cost"}
                        disabled={busy || current}
                        onClick={() => doPhaseSwitch.mutate(c.id)}
                      >
                        {/* Code AND name — a bare number means nothing on a
                            phone, where the hover tooltip never existed. */}
                        <span className="clock-chip-num">{c.code}</span>
                        <span className="clock-chip-desc">
                          {c.label}
                          {current ? " · now" : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {needsRealFinish ? null : onBreak ? (
              <button
                type="button"
                className="clock-btn resume"
                disabled={busy}
                onClick={() => doBreakEnd.mutate()}
              >
                <Play size={18} aria-hidden /> Resume work
              </button>
            ) : (
              <button
                type="button"
                className="clock-btn break"
                disabled={busy}
                onClick={() => setMode("break-type")}
              >
                <Coffee size={18} aria-hidden /> Go on break
              </button>
            )}

            <label className="clock-injury">
              <input
                type="checkbox"
                checked={injured}
                onChange={(e) => setInjured(e.target.checked)}
              />
              I was injured this shift
            </label>
            {injured && (
              <div style={{ margin: "6px 0 2px" }}>
                <label className="field-label" htmlFor="injury-what-happened">
                  What happened?{" "}
                  <strong style={{ color: "var(--danger)" }}>
                    (If this is an emergency immediately call 911)
                  </strong>
                </label>
                <textarea
                  id="injury-what-happened"
                  rows={3}
                  value={injuryNote}
                  onChange={(e) => setInjuryNote(e.target.value)}
                  placeholder="A sentence or two — what happened, and what part of you it got."
                  style={{ width: "100%" }}
                />
              </div>
            )}

            <label className="clock-injury">
              <input
                type="checkbox"
                checked={timeWrong}
                onChange={(e) => setTimeWrong(e.target.checked)}
              />
              My recorded time looks wrong — flag it for office review
            </label>

            {needsRealFinish ? (
              <>
                <label className="clock-row-label" htmlFor="clock-finish-at">
                  When did you finish?
                </label>
                <input
                  id="clock-finish-at"
                  className="clock-finish-input"
                  type="datetime-local"
                  value={finishAt}
                  min={finishBounds?.min}
                  max={finishBounds?.max}
                  onChange={(e) => setFinishAt(e.target.value)}
                />
                {finishAt && !finishCheck.ok && (
                  <p className="error">{finishCheck.error}</p>
                )}
                {finishAt && finishCheck.ok && (
                  <p className="clock-pick-summary">
                    That's <strong>{finishCheck.hours!.toFixed(1)} hours</strong> on
                    this shift.
                  </p>
                )}
                <button
                  type="button"
                  className="clock-btn out"
                  disabled={busy || !finishCheck.ok}
                  onClick={() => doFinish.mutate()}
                >
                  {doFinish.isPending ? (
                    "Saving…"
                  ) : (
                    <>
                      <Square size={16} aria-hidden /> Save my finish time
                    </>
                  )}
                </button>
                <p className="muted clock-switch-note">
                  Not sure? Leave it and tell your foreman — they can set it for
                  you. Nothing is counted until somebody puts a real time in.
                </p>
              </>
            ) : (
              <button
                type="button"
                className="clock-btn out"
                disabled={busy}
                onClick={() => doClockOut.mutate()}
              >
                {doClockOut.isPending ? (
                  "Clocking out…"
                ) : (
                  <>
                    <Square size={16} aria-hidden /> Clock out
                  </>
                )}
              </button>
            )}

            {/* /clock is another clock-in screen; the hours summary is
                /timecard, which is exactly what this link says. */}
            <Link to="/timecard" className="clock-timecard-link" onClick={onClose}>
              View my timecard
            </Link>
          </div>
        )}

        {/* ---- PICK BREAK TYPE ---- */}
        {mode === "break-type" && shift && (
          <div className="clock-sheet-body">
            <p className="clock-row-label">
              Your timecard pauses until you tap Resume.
            </p>
            <div className="clock-break-grid">
              {BREAK_TYPES.map((b) => {
                const BreakIcon = BREAK_ICONS[b.type];
                return (
                  <button
                    key={b.type}
                    type="button"
                    className="clock-break-option"
                    disabled={busy}
                    onClick={() => doBreakStart.mutate(b.type)}
                  >
                    <span className="clock-break-icon" aria-hidden>
                      <BreakIcon size={22} />
                    </span>
                    <span className="clock-break-name">{b.label}</span>
                  </button>
                );
              })}
            </div>
            <button type="button" className="clock-cancel" onClick={() => setMode("main")}>
              Cancel
            </button>
          </div>
        )}

        {/* ---- PICK / SWITCH JOB ---- */}
        {(mode === "pick" || mode === "switch") && (
          <div className="clock-sheet-body">
            {
              <>
                {mode === "switch" && shift && (
                  <p className="muted clock-switch-note">
                    Currently on <strong>{shift.projects?.job_code ?? "a job"}</strong> — no gap, the
                    switch closes it cleanly.
                  </p>
                )}

                {/* Scheduled today — pre-selects the right job for clock-in */}
                {!shift && scheduled && (
                  <div className="clock-chip-row-wrap">
                    <p className="clock-row-label">Scheduled today</p>
                    <div className="clock-chip-row">
                      <button
                        type="button"
                        className={
                          pickProjectId === scheduled.project_id
                            ? "clock-chip current"
                            : "clock-chip"
                        }
                        onClick={() => setPickProjectId(scheduled.project_id)}
                      >
                        {scheduled.project?.job_code ??
                          scheduled.project?.name ??
                          "Today's job"}
                      </button>
                    </div>
                  </div>
                )}

                {/* Recent jobs chips */}
                {(recents.data?.length ?? 0) > 0 && (
                  <div className="clock-chip-row-wrap">
                    <p className="clock-row-label">Recent jobs</p>
                    <div className="clock-chip-row">
                      {(recents.data ?? []).map((r) => {
                        const selected = pickProjectId === r.projectId;
                        return (
                          <button
                            key={r.projectId}
                            type="button"
                            className={selected ? "clock-chip current" : "clock-chip"}
                            onClick={() => {
                              setPickProjectId(r.projectId);
                              if (r.costCodeId) setPickCostCodeId(r.costCodeId);
                            }}
                          >
                            {r.jobCode || r.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Searchable full project list */}
                <button
                  type="button"
                  className="clock-list-toggle"
                  onClick={() => setShowFullList((v) => !v)}
                >
                  {showFullList ? "Hide job list" : "Choose a different job"}
                </button>
                {showFullList && (
                  <div className="clock-picker">
                    <input
                      className="clock-search"
                      placeholder="Search jobs…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <div className="clock-project-list">
                      {filteredProjects.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className={
                            pickProjectId === p.id
                              ? "clock-project-item selected"
                              : "clock-project-item"
                          }
                          onClick={() => setPickProjectId(p.id)}
                        >
                          <span className="clock-project-code">{p.job_code}</span>
                          <span className="clock-project-name">{p.name}</span>
                        </button>
                      ))}
                      {filteredProjects.length === 0 && (
                        <p className="muted">No jobs match “{search}”.</p>
                      )}
                    </div>
                  </div>
                )}

                {/* Cost code — full label so the worker sees exactly what
                    they're charging to, not just the bare code. */}
                <p className="clock-row-label">Cost code</p>
                <div className="clock-costcode-list">
                  {(costCodes.data ?? []).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={
                        pickCostCodeId === c.id
                          ? "clock-costcode-item selected"
                          : "clock-costcode-item"
                      }
                      onClick={() => setPickCostCodeId(c.id)}
                    >
                      <span className="clock-costcode-code">
                        {c.code} — {c.label}
                      </span>
                      {c.description && (
                        <span className="clock-costcode-desc">{c.description}</span>
                      )}
                    </button>
                  ))}
                </div>

                {/* Your assigned windows on this job — pick one and the same
                    tap that clocks you in starts its install clock too. */}
                {!shift && projectOpenings.length > 0 && (
                  <div className="clock-chip-row-wrap">
                    <p className="clock-row-label">
                      Start on your assigned window (optional)
                    </p>
                    <div className="clock-chip-row" style={{ flexWrap: "wrap" }}>
                      {projectOpenings.slice(0, 12).map((o) => (
                        <button
                          key={o.id}
                          type="button"
                          className={
                            pickOpeningId === o.id ? "clock-chip current" : "clock-chip"
                          }
                          onClick={() =>
                            setPickOpeningId((v) => (v === o.id ? "" : o.id))
                          }
                        >
                          {o.opening_code}
                          {o.label ? ` · ${o.label}` : ""}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Sign today's toolbox talk right here — the whole morning
                    checklist in one sheet. Hidden once signed (or when no talk
                    exists today). */}
                {!shift && profileId && todayTalk.data && toolboxDone.isSuccess &&
                  !toolboxDone.data && (
                    <ToolboxSignCard profileId={profileId} talk={todayTalk.data} />
                  )}
                {!shift && Boolean(toolboxDone.data) && (
                  <p className="clock-pick-summary">✓ Today's toolbox talk is signed.</p>
                )}

                {/* Optional note the worker can add for the office. */}
                <label className="clock-row-label" htmlFor="clock-note">
                  Notes for the office (optional)
                </label>
                <textarea
                  id="clock-note"
                  className="clock-note-input"
                  rows={3}
                  maxLength={1000}
                  placeholder="Anything the cost code doesn't cover, or an explanation for the office…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />

                {pickedProject && (
                  <p className="clock-pick-summary">
                    {mode === "switch" ? "To: " : "On: "}
                    <strong>{pickedProject.job_code}</strong> · {pickedProject.name}
                    {pickCostCodeId &&
                      (() => {
                        const cc = (costCodes.data ?? []).find(
                          (c) => c.id === pickCostCodeId,
                        );
                        return cc ? ` · ${cc.code} — ${cc.label}` : "";
                      })()}
                  </p>
                )}

                {pickedOpening && !toolboxOk && (
                  <p className="error" style={{ margin: "4px 0 0" }}>
                    Sign today's toolbox talk above to start on{" "}
                    {pickedOpening.opening_code} — or unselect it to just clock in.
                  </p>
                )}
                <button
                  type="button"
                  className="clock-btn primary big"
                  disabled={busy || !canStart}
                  onClick={() => (mode === "switch" ? doSwitch.mutate() : doStart.mutate())}
                >
                  {mode === "switch" ? (
                    doSwitch.isPending ? (
                      "Switching…"
                    ) : (
                      <>
                        <ArrowLeftRight size={18} aria-hidden /> Switch project
                      </>
                    )
                  ) : doStart.isPending ? (
                    "Clocking in…"
                  ) : (
                    <>
                      <Play size={18} aria-hidden />{" "}
                      {pickedOpening && toolboxOk
                        ? `Start clock on ${pickedOpening.opening_code}`
                        : canResume
                          ? `Resume on ${resumeJob?.jobCode || resumeJob?.name}`
                          : "Start clock"}
                    </>
                  )}
                </button>
                {mode === "switch" && (
                  <button type="button" className="clock-cancel" onClick={() => setMode("main")}>
                    Cancel
                  </button>
                )}
              </>
            }
          </div>
        )}
      </div>
    </div>
  );
}
