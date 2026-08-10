import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listProjects } from "../lib/api";
import { getMyProfile } from "../lib/install/api";
import { isForemanPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { CostCodePicker } from "../components/CostCodePicker";
import { myTodayCompletion } from "../lib/toolbox";
import {
  approveShift,
  clockIn,
  clockOut,
  currentBreakSeconds,
  endBreak,
  getOpenShift,
  listCostCodes,
  listMyShifts,
  listShiftsToApprove,
  shiftHours,
  startBreak,
  startOfWeekIso,
  type TimeShift,
} from "../lib/timeclock";

function hhmm(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function TimeClock() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const costCodes = useQuery({ queryKey: ["costCodes"], queryFn: listCostCodes });
  const open = useQuery({
    queryKey: ["openShift", me.data?.id],
    queryFn: () => getOpenShift(me.data!.id),
    enabled: Boolean(me.data?.id),
  });
  const week = useQuery({
    queryKey: ["myShifts", me.data?.id],
    queryFn: () => listMyShifts(me.data!.id, startOfWeekIso()),
    enabled: Boolean(me.data?.id),
  });
  const toApprove = useQuery({
    queryKey: ["shiftsToApprove"],
    queryFn: listShiftsToApprove,
    enabled: lead,
  });
  const toolboxDone = useQuery({
    queryKey: ["toolboxToday", me.data?.id],
    queryFn: () => myTodayCompletion(me.data!.id),
    enabled: Boolean(me.data?.id),
  });

  const [projectId, setProjectId] = useState("");
  const [codeId, setCodeId] = useState("");
  const [now, setNow] = useState(Date.now());
  const [injured, setInjured] = useState(false);
  // Sign-off at clock-out: "Yes" (default) writes time_confirmed = true; "No"
  // still clocks out and flags the day for office review.
  const [timeCorrect, setTimeCorrect] = useState(true);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["openShift"] });
    queryClient.invalidateQueries({ queryKey: ["myShifts"] });
    queryClient.invalidateQueries({ queryKey: ["shiftsToApprove"] });
  };

  const shift = open.data;
  // Break state lives on the server (survives refresh).
  const onBreak = Boolean(shift?.break_started_at);
  const breakSec = shift ? currentBreakSeconds(shift, now) : 0;

  const doClockIn = useMutation({
    mutationFn: () => clockIn(projectId || null, codeId || null),
    onSuccess: refresh,
  });
  const toggleBreak = useMutation({
    mutationFn: (s: TimeShift) => (s.break_started_at ? endBreak(s.id) : startBreak(s.id)),
    onSuccess: refresh,
  });
  const doClockOut = useMutation({
    mutationFn: (s: TimeShift) =>
      clockOut(s.id, {
        injured,
        timeConfirmed: timeCorrect,
        breakSeconds: currentBreakSeconds(s, Date.now()),
      }),
    onSuccess: () => { setInjured(false); setTimeCorrect(true); refresh(); },
  });
  const doApprove = useMutation({
    mutationFn: approveShift,
    onSuccess: refresh,
  });

  const elapsed = shift
    ? Math.max(0, Math.floor((now - new Date(shift.clock_in_at).getTime()) / 1000) - breakSec)
    : 0;
  const weekTotal = (week.data ?? []).reduce((s, x) => s + shiftHours(x), 0);

  // Hard gate: today's toolbox talk must be signed before the first clock-in.
  const needsToolbox = toolboxDone.isSuccess && !toolboxDone.data;
  const clockInError = doClockIn.isError
    ? String((doClockIn.error as Error).message ?? "")
    : "";

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Time clock</h1>
          <p className="muted" style={{ margin: 0 }}>Week: {weekTotal.toFixed(1)} h</p>
        </div>
        <Link to="/" className="button-like">Home</Link>
      </header>

      {shift ? (
        <div className="clock-hero">
          <p className="next-label">
            <span className="clock-live-dot" aria-hidden />
            On the clock
          </p>
          <p className="next-code">{hhmm(elapsed)}</p>
          <p className="muted" style={{ margin: 0 }}>
            {shift.projects?.job_code ?? "no job"} · {shift.cost_codes?.label ?? "no code"}
          </p>
          <button
            type="button"
            className={onBreak ? "break-banner on" : "break-banner"}
            disabled={toggleBreak.isPending}
            onClick={() => toggleBreak.mutate(shift)}
          >
            {onBreak ? `End break (${hhmm(breakSec)})` : "Start break"}
          </button>
          <label className="field-label" style={{ alignSelf: "stretch", textAlign: "left" }}>
            Were you injured this shift?
          </label>
          <div className="grade-row" style={{ width: "100%" }}>
            <button className={!injured ? "grade-btn selected" : "grade-btn"} onClick={() => setInjured(false)}>No</button>
            <button className={injured ? "grade-btn selected danger" : "grade-btn"} onClick={() => setInjured(true)}>Yes</button>
          </div>
          <label className="field-label" style={{ alignSelf: "stretch", textAlign: "left" }}>
            Is your recorded time correct?
          </label>
          <div className="grade-row" style={{ width: "100%" }}>
            <button className={timeCorrect ? "grade-btn selected" : "grade-btn"} onClick={() => setTimeCorrect(true)}>Yes</button>
            <button className={!timeCorrect ? "grade-btn selected danger" : "grade-btn"} onClick={() => setTimeCorrect(false)}>No</button>
          </div>
          {!timeCorrect && (
            <p className="muted" style={{ margin: 0 }}>
              You'll still clock out — this day gets flagged for the office to review.
            </p>
          )}
          <button
            type="button"
            className="clock-out"
            disabled={doClockOut.isPending}
            onClick={() => doClockOut.mutate(shift)}
          >
            {doClockOut.isPending ? "Signing off…" : "Clock out"}
          </button>
        </div>
      ) : (
        <div className="detail-card">
          {needsToolbox ? (
            <div className="toolbox-gate">
              <p className="next-label" style={{ margin: 0 }}>Toolbox talk required</p>
              <p className="muted" style={{ margin: "6px 0 12px", lineHeight: 1.5 }}>
                Read and sign today's toolbox talk before you clock in.
              </p>
              <Link to="/safety" className="primary big" style={{ textAlign: "center" }}>
                Go to today's talk
              </Link>
            </div>
          ) : (
            <>
              <label className="field-label">Clock into which project?</label>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">— pick a job —</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.job_code} — {p.name}</option>
                ))}
              </select>
              <label className="field-label">Cost code</label>
              <CostCodePicker
                variant="select"
                codes={costCodes.data ?? []}
                value={codeId}
                onChange={setCodeId}
              />
              {clockInError && (
                <p className="error">
                  {/[Tt]oolbox/.test(clockInError)
                    ? "Complete today's toolbox talk before clocking in."
                    : clockInError}
                  {" "}
                  <Link to="/safety">Go to talk</Link>
                </p>
              )}
              <button
                className="primary big clock-in"
                disabled={doClockIn.isPending || !codeId}
                onClick={() => doClockIn.mutate()}
              >
                {doClockIn.isPending ? "Clocking in…" : "Clock in"}
              </button>
            </>
          )}
        </div>
      )}

      <h2>This week</h2>
      <ul className="unit-list">
        {(week.data ?? []).map((s) => (
          <li key={s.id} className="week-row">
            <span className="week-day">
              {new Date(s.clock_in_at).toLocaleDateString(undefined, { weekday: "short" })}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                {s.projects?.job_code ?? "—"} · {s.cost_codes?.code ?? "—"}
              </div>
              <div className={s.status === "approved" ? "ok" : "muted"} style={{ fontSize: 11.5 }}>
                {s.status}
              </div>
            </div>
            <span className="week-hours">{shiftHours(s).toFixed(1)}h</span>
          </li>
        ))}
        {week.data?.length === 0 && <p className="muted">No shifts yet this week.</p>}
      </ul>

      {lead && (
        <>
          <h2>Timecards to approve ({toApprove.data?.length ?? 0})</h2>
          <ul className="unit-list work-list">
            {(toApprove.data ?? []).map((s: TimeShift) => (
              <li key={s.id} className="find-row">
                <div>
                  <strong>{s.profiles?.display_name ?? "crew"}</strong>{" "}
                  <span className="muted">
                    {new Date(s.clock_in_at).toLocaleDateString()} · {shiftHours(s).toFixed(1)}h
                  </span>
                  {s.injured && <span className="error"> · injury reported</span>}
                </div>
                <button
                  className="button-like active-pill"
                  style={{ marginLeft: "auto" }}
                  onClick={() => doApprove.mutate(s.id)}
                >
                  Approve ✓
                </button>
              </li>
            ))}
            {toApprove.data?.length === 0 && <p className="muted">Queue clear.</p>}
          </ul>
        </>
      )}
    </div>
  );
}
