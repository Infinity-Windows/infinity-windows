import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listProjects } from "../lib/api";
import { getMyProfile } from "../lib/install/api";
import { isLeadLike } from "../lib/install/types";
import {
  approveShift,
  clockIn,
  clockOut,
  getOpenShift,
  listCostCodes,
  listMyShifts,
  listShiftsToApprove,
  shiftHours,
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
  const lead = isLeadLike(me.data?.role);
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

  const [projectId, setProjectId] = useState("");
  const [codeId, setCodeId] = useState("");
  const [onBreak, setOnBreak] = useState(false);
  const [breakSec, setBreakSec] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [injured, setInjured] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!onBreak) return;
    const t = setInterval(() => setBreakSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [onBreak]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["openShift"] });
    queryClient.invalidateQueries({ queryKey: ["myShifts"] });
    queryClient.invalidateQueries({ queryKey: ["shiftsToApprove"] });
  };

  const doClockIn = useMutation({
    mutationFn: () => clockIn(projectId || null, codeId || null),
    onSuccess: () => { setBreakSec(0); setOnBreak(false); refresh(); },
  });
  const doClockOut = useMutation({
    mutationFn: (shiftId: string) =>
      clockOut(shiftId, { injured, timeConfirmed: true, breakSeconds: breakSec }),
    onSuccess: () => { setBreakSec(0); setOnBreak(false); setInjured(false); refresh(); },
  });
  const doApprove = useMutation({
    mutationFn: approveShift,
    onSuccess: refresh,
  });

  const shift = open.data;
  const elapsed = shift
    ? Math.max(0, Math.floor((now - new Date(shift.clock_in_at).getTime()) / 1000) - breakSec)
    : 0;
  const weekTotal = (week.data ?? []).reduce((s, x) => s + shiftHours(x), 0);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Time clock</h1>
        <Link to="/" className="button-like">Home</Link>
      </header>
      <p className="muted">Week: {weekTotal.toFixed(1)} h</p>

      {shift ? (
        <div className="detail-card">
          <p className="next-label">ON THE CLOCK</p>
          <p className="next-code">{hhmm(elapsed)}</p>
          <p className="muted">
            {shift.projects?.job_code ?? "no job"} · {shift.cost_codes?.label ?? "no code"}
            {onBreak ? " · on break" : ""}
          </p>
          <div className="row-gap">
            <button className="button-like" onClick={() => setOnBreak((b) => !b)}>
              {onBreak ? "End break" : "Start break"}
            </button>
          </div>
          <label className="field-label">Were you injured this shift?</label>
          <div className="grade-row">
            <button className={!injured ? "grade-btn selected" : "grade-btn"} onClick={() => setInjured(false)}>No</button>
            <button className={injured ? "grade-btn selected danger" : "grade-btn"} onClick={() => setInjured(true)}>Yes</button>
          </div>
          <button
            className="primary big"
            disabled={doClockOut.isPending}
            onClick={() => doClockOut.mutate(shift.id)}
          >
            {doClockOut.isPending ? "Signing off…" : "Clock out & sign shift"}
          </button>
        </div>
      ) : (
        <div className="detail-card">
          <label className="field-label">Clock into which project?</label>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">— pick a job —</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.job_code} — {p.name}</option>
            ))}
          </select>
          <label className="field-label">Cost code</label>
          <select value={codeId} onChange={(e) => setCodeId(e.target.value)}>
            <option value="">— pick a code —</option>
            {(costCodes.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.code} · {c.label}</option>
            ))}
          </select>
          <button
            className="primary big"
            disabled={doClockIn.isPending || !codeId}
            onClick={() => doClockIn.mutate()}
          >
            {doClockIn.isPending ? "Clocking in…" : "Clock in"}
          </button>
        </div>
      )}

      <h2>This week</h2>
      <ul className="unit-list">
        {(week.data ?? []).map((s) => (
          <li key={s.id} className="find-row">
            <div>
              <strong>{new Date(s.clock_in_at).toLocaleDateString(undefined, { weekday: "short" })}</strong>{" "}
              <span className="muted">{s.projects?.job_code ?? "—"} · {s.cost_codes?.code ?? "—"}</span>
            </div>
            <span style={{ marginLeft: "auto" }}>
              {shiftHours(s).toFixed(1)}h{" "}
              <span className={s.status === "approved" ? "ok" : "muted"}>{s.status}</span>
            </span>
          </li>
        ))}
        {week.data?.length === 0 && <p className="muted">No shifts yet this week.</p>}
      </ul>

      {lead && (
        <>
          <h2>Timecards to approve ({toApprove.data?.length ?? 0})</h2>
          <ul className="unit-list">
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
