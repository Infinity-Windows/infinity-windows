import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listProjects } from "../../lib/api";
import { myTodayCompletion } from "../../lib/toolbox";
import { captureGeoSoft } from "../../lib/geo";
import { pushToast, toastError } from "../../lib/toast";
import {
  BREAK_TYPES,
  breakTypeLabel,
  clockIn,
  clockOut,
  currentBreakSeconds,
  elapsedWorkSeconds,
  endBreak,
  formatClock,
  listCostCodes,
  listRecentJobs,
  startBreak,
  type BreakType,
  type TimeShift,
} from "../../lib/timeclock";

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
  const [injured, setInjured] = useState(false);
  const [now, setNow] = useState(Date.now());
  const primedRef = useRef(false);

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const costCodes = useQuery({ queryKey: ["costCodes"], queryFn: listCostCodes });
  const recents = useQuery({
    queryKey: ["recentJobs", profileId],
    queryFn: () => listRecentJobs(profileId!),
    enabled: Boolean(profileId),
  });
  const toolbox = useQuery({
    queryKey: ["toolboxToday", profileId],
    queryFn: () => myTodayCompletion(profileId!),
    enabled: Boolean(profileId),
  });

  // Follow the shift state: entering a shift -> main; leaving -> pick.
  useEffect(() => {
    setMode(shift ? "main" : "pick");
  }, [shift?.id]);

  // 1s tick drives the live timers.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Prime the picker with the most recent job so "Resume" is one tap.
  useEffect(() => {
    if (primedRef.current || shift) return;
    const r = recents.data?.[0];
    if (r) {
      primedRef.current = true;
      setPickProjectId(r.projectId);
      if (r.costCodeId) setPickCostCodeId(r.costCodeId);
    }
  }, [recents.data, shift]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["openShift"] });
    void queryClient.invalidateQueries({ queryKey: ["myShifts"] });
    void queryClient.invalidateQueries({ queryKey: ["recentJobs"] });
    onChanged();
  };

  const onBreak = Boolean(shift?.break_started_at);
  const breakSec = shift ? currentBreakSeconds(shift, now) : 0;
  const runningBreakSec =
    shift?.break_started_at
      ? Math.max(0, Math.floor((now - new Date(shift.break_started_at).getTime()) / 1000))
      : 0;
  const workSec = shift ? elapsedWorkSeconds(shift, now) : 0;

  const needsToolbox = toolbox.isSuccess && !toolbox.data;
  const canStart = Boolean(pickProjectId && pickCostCodeId) && !needsToolbox;

  const doStart = useMutation({
    mutationFn: async () => {
      const geo = await captureGeoSoft();
      return clockIn(pickProjectId || null, pickCostCodeId || null, geo);
    },
    onSuccess: () => {
      pushToast("Clocked in", "info");
      refresh();
      onClose();
    },
    onError: (e) => toastError(e),
  });

  const doSwitch = useMutation({
    mutationFn: async () => {
      const geo = await captureGeoSoft();
      // clock_in auto-closes the prior open shift, so switching leaves no gap.
      return clockIn(pickProjectId || null, pickCostCodeId || null, geo);
    },
    onSuccess: () => {
      pushToast("Switched project", "info");
      refresh();
      onClose();
    },
    onError: (e) => toastError(e),
  });

  const doPhaseSwitch = useMutation({
    mutationFn: async (costCodeId: string) => {
      const geo = await captureGeoSoft();
      return clockIn(shift?.project_id ?? null, costCodeId, geo);
    },
    onSuccess: () => {
      pushToast("Switched phase", "info");
      refresh();
    },
    onError: (e) => toastError(e),
  });

  const doBreakStart = useMutation({
    mutationFn: (type: BreakType) => startBreak(shift!.id, type),
    onSuccess: (_data, type) => {
      pushToast(`On ${breakTypeLabel(type).toLowerCase()} break`, "info");
      setMode("main");
      refresh();
    },
    onError: (e) => toastError(e),
  });

  const doBreakEnd = useMutation({
    mutationFn: () => endBreak(shift!.id),
    onSuccess: () => {
      pushToast("Back on the clock", "info");
      refresh();
    },
    onError: (e) => toastError(e),
  });

  const doClockOut = useMutation({
    mutationFn: async () => {
      const geo = await captureGeoSoft();
      return clockOut(shift!.id, {
        injured,
        timeConfirmed: true,
        breakSeconds: currentBreakSeconds(shift!, Date.now()),
        geo,
      });
    },
    onSuccess: () => {
      pushToast("Clocked out", "info");
      setInjured(false);
      refresh();
      onClose();
    },
    onError: (e) => toastError(e),
  });

  const busy =
    doStart.isPending ||
    doSwitch.isPending ||
    doPhaseSwitch.isPending ||
    doBreakStart.isPending ||
    doBreakEnd.isPending ||
    doClockOut.isPending;

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
    Boolean(pickCostCodeId) &&
    !needsToolbox;

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
            ✕
          </button>
        </div>

        {/* ---- ON THE CLOCK ---- */}
        {mode === "main" && shift && (
          <div className="clock-sheet-body">
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
            </div>

            <button
              type="button"
              className="clock-job-chip"
              disabled={busy || onBreak}
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
              <span className="clock-job-chip-arrow" aria-hidden>⇄</span>
            </button>

            {/* Switch phase — one tap, same job */}
            {!onBreak && (costCodes.data?.length ?? 0) > 1 && (
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
                      >
                        {c.code}
                        {current ? " · now" : ""}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {onBreak ? (
              <button
                type="button"
                className="clock-btn resume"
                disabled={busy}
                onClick={() => doBreakEnd.mutate()}
              >
                ▶ Resume work
              </button>
            ) : (
              <button
                type="button"
                className="clock-btn break"
                disabled={busy}
                onClick={() => setMode("break-type")}
              >
                ☕ Go on break
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

            <button
              type="button"
              className="clock-btn out"
              disabled={busy}
              onClick={() => doClockOut.mutate()}
            >
              {doClockOut.isPending ? "Clocking out…" : "■ Clock out"}
            </button>

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
              {BREAK_TYPES.map((b) => (
                <button
                  key={b.type}
                  type="button"
                  className="clock-break-option"
                  disabled={busy}
                  onClick={() => doBreakStart.mutate(b.type)}
                >
                  <span className="clock-break-icon" aria-hidden>{b.icon}</span>
                  <span className="clock-break-name">{b.label}</span>
                </button>
              ))}
            </div>
            <button type="button" className="clock-cancel" onClick={() => setMode("main")}>
              Cancel
            </button>
          </div>
        )}

        {/* ---- PICK / SWITCH JOB ---- */}
        {(mode === "pick" || mode === "switch") && (
          <div className="clock-sheet-body">
            {needsToolbox && mode === "pick" ? (
              <div className="clock-gate">
                <p className="clock-gate-title">Toolbox talk required</p>
                <p className="muted">Read and sign today's toolbox talk before clocking in.</p>
                <Link to="/safety" className="clock-btn primary" onClick={onClose}>
                  Go to today's talk
                </Link>
              </div>
            ) : (
              <>
                {mode === "switch" && shift && (
                  <p className="muted clock-switch-note">
                    Currently on <strong>{shift.projects?.job_code ?? "a job"}</strong> — no gap, the
                    switch closes it cleanly.
                  </p>
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

                {/* Cost code */}
                <p className="clock-row-label">Cost code</p>
                <div className="clock-chip-row wrap">
                  {(costCodes.data ?? []).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={pickCostCodeId === c.id ? "clock-chip current" : "clock-chip"}
                      onClick={() => setPickCostCodeId(c.id)}
                    >
                      {c.code}
                    </button>
                  ))}
                </div>

                {pickedProject && (
                  <p className="clock-pick-summary">
                    {mode === "switch" ? "To: " : "On: "}
                    <strong>{pickedProject.job_code}</strong> · {pickedProject.name}
                    {pickCostCodeId &&
                      ` · ${(costCodes.data ?? []).find((c) => c.id === pickCostCodeId)?.code ?? ""}`}
                  </p>
                )}

                <button
                  type="button"
                  className="clock-btn primary big"
                  disabled={busy || !canStart}
                  onClick={() => (mode === "switch" ? doSwitch.mutate() : doStart.mutate())}
                >
                  {mode === "switch"
                    ? doSwitch.isPending
                      ? "Switching…"
                      : "⇄ Switch project"
                    : doStart.isPending
                      ? "Clocking in…"
                      : canResume
                        ? `▶ Resume on ${resumeJob?.jobCode || resumeJob?.name}`
                        : "▶ Start clock"}
                </button>
                {mode === "switch" && (
                  <button type="button" className="clock-cancel" onClick={() => setMode("main")}>
                    Cancel
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
