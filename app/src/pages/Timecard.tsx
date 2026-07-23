import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { listProjects } from "../lib/api";
import { formatApiError } from "../lib/errors";
import { QueryError, SkeletonList } from "../components/ui/States";
import { getMyProfile, listProfiles } from "../lib/install/api";
import { isForemanPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import {
  addDays,
  approveShift,
  leadAddShift,
  leadEditShift,
  listCostCodes,
  listShiftsForProfile,
  listTeamShifts,
  punchDay,
  rejectShift,
  shiftHours,
  summarizeTeamWeek,
  weekRange,
  type TimeShift,
} from "../lib/timeclock";
import {
  buildTimecardCsv,
  buildTimecardTsv,
  type TimecardExportShift,
} from "../lib/timecardExport";

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** ISO → value for a <input type="datetime-local"> (viewer local time). */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function statusStyle(status: string): React.CSSProperties {
  if (status === "approved") return { color: "var(--ok, #34d399)" };
  if (status === "rejected") return { color: "var(--danger, #f87171)" };
  if (status === "submitted") return { color: "var(--warn, #fbbf24)" };
  return { color: "var(--muted)" };
}

function downloadText(text: string, filename: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

interface DayGroup {
  day: string;
  label: string;
  shifts: TimeShift[];
  total: number;
}

function groupByDay(shifts: TimeShift[]): DayGroup[] {
  const m = new Map<string, TimeShift[]>();
  for (const s of shifts) {
    const d = punchDay(s.clock_in_at);
    const arr = m.get(d);
    if (arr) arr.push(s);
    else m.set(d, [s]);
  }
  return [...m.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, list]) => ({
      day,
      label: new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
      }),
      shifts: list,
      total: list.reduce((t, s) => t + shiftHours(s), 0),
    }));
}

type ProjectOpt = { id: string; job_code: string; name: string };
type CostOpt = { id: string; code: string; label: string };

/** Inline add/adjust punch form for leads. */
function ShiftEditor({
  mode,
  shift,
  profileId,
  projects,
  costCodes,
  onDone,
}: {
  mode: "add" | "edit";
  shift: TimeShift | null;
  profileId: string;
  projects: ProjectOpt[];
  costCodes: CostOpt[];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState(shift?.project_id ?? "");
  const [codeId, setCodeId] = useState(shift?.cost_code_id ?? "");
  const [inAt, setInAt] = useState(
    toLocalInput(shift?.clock_in_at ?? new Date().toISOString()),
  );
  const [outAt, setOutAt] = useState(toLocalInput(shift?.clock_out_at ?? null));
  const [breakMin, setBreakMin] = useState(
    String(Math.round((shift?.break_seconds ?? 0) / 60)),
  );
  const [note, setNote] = useState(shift?.edited_note ?? "");

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["teamShifts"] });
    qc.invalidateQueries({ queryKey: ["timecardMine"] });
  };

  const save = useMutation({
    mutationFn: () => {
      const breakSeconds = Math.max(0, Math.round(Number(breakMin) || 0) * 60);
      if (mode === "add") {
        return leadAddShift({
          profileId,
          projectId: projectId || null,
          costCodeId: codeId || null,
          clockInAt: fromLocalInput(inAt)!,
          clockOutAt: fromLocalInput(outAt),
          breakSeconds,
          note: note.trim() || null,
        });
      }
      return leadEditShift(shift!.id, {
        projectId: projectId || null,
        costCodeId: codeId || null,
        clockInAt: fromLocalInput(inAt),
        clockOutAt: fromLocalInput(outAt),
        breakSeconds,
        note: note.trim() || null,
      });
    },
    onSuccess: () => {
      refresh();
      onDone();
    },
  });

  return (
    <div className="detail-card" style={{ marginTop: 8 }}>
      <label className="field-label">Job</label>
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">— no job —</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.job_code} — {p.name}
          </option>
        ))}
      </select>
      <label className="field-label">Cost code</label>
      <select value={codeId} onChange={(e) => setCodeId(e.target.value)}>
        <option value="">— no code —</option>
        {costCodes.map((c) => (
          <option key={c.id} value={c.id}>
            {c.code} · {c.label}
          </option>
        ))}
      </select>
      <label className="field-label">Clock in</label>
      <input
        type="datetime-local"
        value={inAt}
        onChange={(e) => setInAt(e.target.value)}
      />
      <label className="field-label">Clock out</label>
      <input
        type="datetime-local"
        value={outAt}
        onChange={(e) => setOutAt(e.target.value)}
      />
      <label className="field-label">Break (minutes)</label>
      <input
        type="number"
        min={0}
        value={breakMin}
        onChange={(e) => setBreakMin(e.target.value)}
      />
      <label className="field-label">Note (why adjusted)</label>
      <input
        type="text"
        value={note}
        placeholder="e.g. forgot to clock out"
        onChange={(e) => setNote(e.target.value)}
      />
      {save.isError && <p className="error">{formatApiError(save.error)}</p>}
      <div className="row-gap" style={{ marginTop: 10 }}>
        <button
          className="button-like active-pill"
          disabled={save.isPending || !inAt}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : mode === "add" ? "Add punch" : "Save changes"}
        </button>
        <button className="button-like" onClick={onDone} disabled={save.isPending}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function Timecard() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole } = useEffectiveRole();
  const isLead = isForemanPlus(effectiveRole);

  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const week = useMemo(() => weekRange(anchor), [anchor]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const crew = useQuery({
    queryKey: ["profiles"],
    queryFn: listProfiles,
    enabled: isLead,
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const costCodes = useQuery({ queryKey: ["costCodes"], queryFn: listCostCodes });

  const teamShifts = useQuery({
    queryKey: ["teamShifts", week.startIso],
    queryFn: () => listTeamShifts(week.startIso, week.endIso),
    enabled: isLead,
  });
  const mineShifts = useQuery({
    queryKey: ["timecardMine", me.data?.id, week.startIso],
    queryFn: () => listShiftsForProfile(me.data!.id, week.startIso, week.endIso),
    enabled: !isLead && Boolean(me.data?.id),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["teamShifts"] });
    qc.invalidateQueries({ queryKey: ["timecardMine"] });
  };

  const approve = useMutation({ mutationFn: approveShift, onSuccess: refresh });
  const reject = useMutation({
    mutationFn: (args: { id: string; reason: string }) =>
      rejectShift(args.id, args.reason),
    onSuccess: () => {
      setRejectingId(null);
      setRejectReason("");
      refresh();
    },
  });

  const activePersonId = selectedId ?? me.data?.id ?? null;
  const roster = useMemo(
    () => summarizeTeamWeek(teamShifts.data ?? []),
    [teamShifts.data],
  );
  const personShifts = useMemo(() => {
    if (!isLead) return mineShifts.data ?? [];
    return (teamShifts.data ?? []).filter((s) => s.profile_id === activePersonId);
  }, [isLead, mineShifts.data, teamShifts.data, activePersonId]);

  const personName = isLead
    ? roster.find((r) => r.profileId === activePersonId)?.displayName ??
      crew.data?.find((c) => c.id === activePersonId)?.display_name ??
      "Crew member"
    : me.data?.display_name ?? "My timecard";
  const personTotal = personShifts.reduce((t, s) => t + shiftHours(s), 0);
  const pendingCount = (teamShifts.data ?? []).filter(
    (s) => s.status === "submitted",
  ).length;

  const dayGroups = useMemo(() => groupByDay(personShifts), [personShifts]);

  function exportShifts(source: TimeShift[]): TimecardExportShift[] {
    return source.map((s) => ({
      employee: s.profiles?.display_name ?? "Crew",
      day: punchDay(s.clock_in_at),
      start: fmtTime(s.clock_in_at),
      end: s.clock_out_at ? fmtTime(s.clock_out_at) : "",
      hours: shiftHours(s),
      job: s.projects?.job_code ?? "—",
      costCode: s.cost_codes
        ? `${s.cost_codes.code} - ${s.cost_codes.label}`
        : "-",
      status: s.status,
    }));
  }

  function handleExportCsv() {
    const payload = {
      periodLabel: week.label,
      shifts: exportShifts(teamShifts.data ?? []),
    };
    downloadText(
      buildTimecardCsv(payload),
      `team-timecard-${week.startIso.slice(0, 10)}.csv`,
      "text/csv;charset=utf-8",
    );
  }

  async function handleCopyTsv() {
    const payload = {
      periodLabel: week.label,
      shifts: exportShifts(teamShifts.data ?? []),
    };
    await navigator.clipboard.writeText(buildTimecardTsv(payload));
  }

  const canEdit = isLead && activePersonId != null;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Timecard</h1>
          <p className="muted" style={{ margin: 0 }}>
            {isLead ? "Crew hours, approvals & payroll" : "Your hours this week"}
          </p>
        </div>
        <Link to="/" className="back-chip" aria-label="Home" />
      </header>

      {/* Week navigation */}
      <div className="row-gap" style={{ alignItems: "center" }}>
        <button
          className="button-like"
          onClick={() => setAnchor((d) => addDays(d, -7))}
          aria-label="Previous week"
        >
          <ChevronLeft size={18} />
        </button>
        <button
          className="button-like"
          style={{ flex: 1 }}
          onClick={() => setAnchor(new Date())}
        >
          {week.label}
        </button>
        <button
          className="button-like"
          onClick={() => setAnchor((d) => addDays(d, 7))}
          aria-label="Next week"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {isLead && (
        <>
          <div
            className="row-gap"
            style={{ marginTop: 12, alignItems: "center", flexWrap: "wrap" }}
          >
            <button
              className="button-like"
              onClick={handleExportCsv}
              disabled={(teamShifts.data ?? []).length === 0}
            >
              Export CSV
            </button>
            <button
              className="button-like"
              onClick={handleCopyTsv}
              disabled={(teamShifts.data ?? []).length === 0}
            >
              Copy for Sheets
            </button>
            {pendingCount > 0 && (
              <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
                {pendingCount} punch{pendingCount === 1 ? "" : "es"} to review
              </span>
            )}
          </div>

          <h2>Crew ({roster.length})</h2>
          <ul className="unit-list">
            {roster.map((r) => (
              <li
                key={r.profileId}
                className="find-row"
                style={{
                  cursor: "pointer",
                  outline:
                    r.profileId === activePersonId
                      ? "2px solid var(--accent, #4A9DFF)"
                      : "none",
                }}
                onClick={() => {
                  setSelectedId(r.profileId);
                  setEditingId(null);
                  setAdding(false);
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <strong>{r.displayName}</strong>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {r.shiftCount} shift{r.shiftCount === 1 ? "" : "s"}
                    {r.submittedCount > 0 && (
                      <span style={statusStyle("submitted")}>
                        {" "}· {r.submittedCount} to approve
                      </span>
                    )}
                    {r.rejectedCount > 0 && (
                      <span style={statusStyle("rejected")}>
                        {" "}· {r.rejectedCount} rejected
                      </span>
                    )}
                  </div>
                </div>
                <span className="week-hours" style={{ marginLeft: "auto" }}>
                  {r.hours.toFixed(1)}h
                </span>
              </li>
            ))}
            {roster.length === 0 && (
              <p className="muted">No crew hours logged this week.</p>
            )}
          </ul>
        </>
      )}

      {/* Per-person timecard detail */}
      <div className="page-header" style={{ marginTop: 8 }}>
        <div>
          <h2 style={{ margin: 0 }}>{personName}</h2>
          <p className="muted" style={{ margin: 0 }}>
            {personTotal.toFixed(1)} h this week
          </p>
        </div>
        {canEdit && (
          <button
            className="button-like active-pill"
            onClick={() => {
              setAdding((v) => !v);
              setEditingId(null);
            }}
          >
            {adding ? "Close" : "Add punch"}
          </button>
        )}
      </div>

      {adding && canEdit && activePersonId && (
        <ShiftEditor
          mode="add"
          shift={null}
          profileId={activePersonId}
          projects={projects.data ?? []}
          costCodes={costCodes.data ?? []}
          onDone={() => setAdding(false)}
        />
      )}

      {(isLead ? teamShifts.isError : mineShifts.isError) && (
        <QueryError
          error={isLead ? teamShifts.error : mineShifts.error}
          onRetry={() => void (isLead ? teamShifts.refetch() : mineShifts.refetch())}
          label="Couldn't load the timecard"
        />
      )}
      {(isLead ? teamShifts.isLoading : mineShifts.isLoading) && (
        <div style={{ marginTop: 12 }}>
          <SkeletonList rows={3} />
        </div>
      )}
      {dayGroups.map((g) => (
        <div key={g.day} style={{ marginTop: 12 }}>
          <div
            className="row-gap"
            style={{ justifyContent: "space-between", alignItems: "baseline" }}
          >
            <h3 style={{ margin: 0, fontSize: 14 }}>{g.label}</h3>
            <span className="week-hours" style={{ fontSize: 14 }}>
              {g.total.toFixed(1)}h
            </span>
          </div>
          <ul className="unit-list">
            {g.shifts.map((s) => (
              <li key={s.id} className="week-row" style={{ flexWrap: "wrap" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                    {s.projects?.job_code ?? "—"} ·{" "}
                    {s.cost_codes?.code ?? "no code"}
                  </div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {fmtTime(s.clock_in_at)} – {fmtTime(s.clock_out_at)}
                    {s.break_seconds > 0 &&
                      ` · ${Math.round(s.break_seconds / 60)}m break`}
                  </div>
                  <div style={{ fontSize: 11.5, ...statusStyle(s.status) }}>
                    {s.status}
                    {s.injured && (
                      <span style={statusStyle("rejected")}> · injury</span>
                    )}
                    {s.edited_by && <span className="muted"> · adjusted</span>}
                  </div>
                  {s.status === "rejected" && s.reject_reason && (
                    <div style={{ fontSize: 11.5, ...statusStyle("rejected") }}>
                      “{s.reject_reason}”
                    </div>
                  )}
                  {s.note && (
                    <div
                      className="muted"
                      style={{ fontSize: 11.5, marginTop: 2, fontStyle: "italic" }}
                    >
                      Note: {s.note}
                    </div>
                  )}
                </div>
                <span className="week-hours">{shiftHours(s).toFixed(1)}h</span>
                {isLead && (
                  <div
                    className="row-gap"
                    style={{ flexBasis: "100%", marginTop: 6, flexWrap: "wrap" }}
                  >
                    {s.status === "submitted" && (
                      <button
                        className="button-like active-pill"
                        disabled={approve.isPending}
                        onClick={() => approve.mutate(s.id)}
                      >
                        <Check size={14} aria-hidden /> Approve
                      </button>
                    )}
                    {s.status !== "rejected" && (
                      <button
                        className="button-like"
                        onClick={() => {
                          setRejectingId(rejectingId === s.id ? null : s.id);
                          setRejectReason("");
                        }}
                      >
                        Reject
                      </button>
                    )}
                    <button
                      className="button-like"
                      onClick={() => {
                        setEditingId(editingId === s.id ? null : s.id);
                        setAdding(false);
                      }}
                    >
                      {editingId === s.id ? "Close" : "Edit"}
                    </button>
                  </div>
                )}
                {rejectingId === s.id && (
                  <div className="row-gap" style={{ flexBasis: "100%", marginTop: 6 }}>
                    <input
                      type="text"
                      style={{ flex: 1 }}
                      placeholder="Reason (optional)"
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                    />
                    <button
                      className="button-like active-pill"
                      disabled={reject.isPending}
                      onClick={() =>
                        reject.mutate({ id: s.id, reason: rejectReason })
                      }
                    >
                      Send back
                    </button>
                  </div>
                )}
                {editingId === s.id && canEdit && (
                  <div style={{ flexBasis: "100%" }}>
                    <ShiftEditor
                      mode="edit"
                      shift={s}
                      profileId={s.profile_id}
                      projects={projects.data ?? []}
                      costCodes={costCodes.data ?? []}
                      onDone={() => setEditingId(null)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {dayGroups.length === 0 &&
        !(isLead ? teamShifts.isLoading : mineShifts.isLoading) &&
        !(isLead ? teamShifts.isError : mineShifts.isError) && (
          <p className="muted" style={{ marginTop: 12 }}>
            No shifts for {isLead ? "this person" : "you"} this week.
          </p>
        )}
    </div>
  );
}
