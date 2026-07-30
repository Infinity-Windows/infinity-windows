import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
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
import { isNetworkError } from "../../lib/offline/outbox-core";
import {
  enqueueBreakStart,
  enqueueBreakStop,
  enqueueClockIn,
  enqueueClockOut,
  pendingRefForShift,
} from "../../lib/offline/outbox";
import { ToolboxTalkNagBanner } from "../time/ToolboxTalkNagBanner";
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
  const [mode, setMode] = useState<Mode>(shift ? "main" : "pick");
  const [pickProjectId, setPickProjectId] = useState<string>("");
  const [pickCostCodeId, setPickCostCodeId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [showFullList, setShowFullList] = useState(false);
  const [note, setNote] = useState("");
  const [injured, setInjured] = useState(false);
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
  type PunchResult = { queued: boolean };

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

  const doStart = useMutation<PunchResult>({
    mutationFn: async () => {
      const geo = await captureGeoSoft();
      const projectId = pickProjectId || null;
      const costCodeId = pickCostCodeId || null;
      const noteText = note.trim() || null;
      try {
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
      toastSuccess(r.queued ? "Clocked in — we'll sync it when you're back online" : "Clocked in");
      if (!r.queued) refresh();
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
      toastSuccess(r.queued ? "Phase saved — will sync when online" : "Switched phase");
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
          timeConfirmed: true,
          breakSeconds,
          geo,
        });
        return { queued: false };
      } catch (e) {
        if (!shouldQueue(e)) throw e;
        await enqueueClockOut({
          shiftRef: shift!.id,
          injured,
          timeConfirmed: true,
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
  const canStart = Boolean(pickProjectId && pickCostCodeId);

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

            {/* Switch phase — one tap, same job. Hidden while a finish time is
                outstanding: switching calls clock_in, and the question on the
                screen is "when did you stop", not "what are you doing now". */}
            {!onBreak && !needsRealFinish && (costCodes.data?.length ?? 0) > 1 && (
              <div className="clock-chip-row-wrap">
                <p className="clock-row-label">Switch phase</p>
                <div className="clock-chip-row">
                  {(costCodes.data ?? []).map((c) => {
                    const current = shift.cost_code_id === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className={current ? "clock-chip current" : "clock-chip"}
                        disabled={busy || current}
                        onClick={() => doPhaseSwitch.mutate(c.id)}
                        title={`${c.code} — ${c.label}`}
                      >
                        {c.code}
                        {current ? " · now" : ""}
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

            <Link to="/clock" className="clock-timecard-link" onClick={onClose}>
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
                      {canResume
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
