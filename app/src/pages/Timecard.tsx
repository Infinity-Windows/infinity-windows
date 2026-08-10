import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { listProjects } from "../lib/api";
import { formatApiError } from "../lib/errors";
import { QueryError, SkeletonList } from "../components/ui/States";
import {
  getMyProfile,
  listInstallEventsForProfile,
  listProfiles,
} from "../lib/install/api";
import { isForemanPlus, isSupervisorPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { sendPush } from "../lib/permissions/pushServer";
import {
  addDays,
  approveShift,
  leadAddShift,
  leadEditShift,
  listCostCodes,
  listOvertimeRules,
  listShiftEdits,
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
  overtimeRuleFromRow,
  pickOvertimeRule,
  splitOvertime,
} from "../lib/overtime";
import {
  buildTimecardCsv,
  buildTimecardTsv,
  type TimecardExportShift,
} from "../lib/timecardExport";
import { closeShiftAsNoWork, listUnfinishedShifts } from "../lib/timeclock";
import {
  describeDuration,
  flaggedShifts,
  needsFinishTime,
  shiftGuard,
} from "../lib/shiftGuard";

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
  // Every edit needs its OWN reason (the server refuses without one), so this
  // never prefills from the last edit's note - a stale reason on a new change
  // would be a false audit entry.
  const [note, setNote] = useState("");

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["teamShifts"] });
    qc.invalidateQueries({ queryKey: ["timecardMine"] });
    qc.invalidateQueries({ queryKey: ["unfinishedShifts"] });
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
        note: note.trim(),
      });
    },
    onSuccess: () => {
      // Editing an approved shift un-approves it server-side; tell the crew
      // member their numbers changed rather than letting payroll surprise
      // them. Fire-and-forget, same as the approval push.
      if (mode === "edit" && shift?.status === "approved") {
        void sendPush({
          profileIds: [shift.profile_id],
          title: "Timecard adjusted",
          body: "Your approved hours were changed and need re-approval.",
          tag: `timecard-edited-${shift.id}`,
          url: "/clock",
        });
      }
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
      <label className="field-label">
        {mode === "edit" ? "Reason (required — goes in the audit log)" : "Note (why adjusted)"}
      </label>
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
          disabled={save.isPending || !inAt || (mode === "edit" && note.trim() === "")}
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

/** A timestamp field's raw value reads better as a local time. */
function fmtEditValue(field: string, v: string | null): string {
  if (v === null) return "—";
  if (field.endsWith("_at")) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    }
  }
  return v;
}

/**
 * The append-only trail behind an "adjusted" badge — supervisor+ only (RLS
 * enforces it; the UI just doesn't offer the button below that). Shifts
 * adjusted before the audit log existed have a stamp but no rows; say so
 * rather than showing an empty list that looks like a bug.
 */
function ShiftHistory({ shiftId }: { shiftId: string }) {
  const edits = useQuery({
    queryKey: ["shiftEdits", shiftId],
    queryFn: () => listShiftEdits(shiftId),
  });
  if (edits.isLoading) return <p className="muted">Loading history…</p>;
  if (edits.isError) return <p className="error">{formatApiError(edits.error)}</p>;
  const list = edits.data ?? [];
  if (list.length === 0) {
    return (
      <p className="muted" style={{ fontSize: 11.5 }}>
        No logged edits — this punch was adjusted before the audit log existed.
      </p>
    );
  }
  return (
    <ul className="unit-list" style={{ flexBasis: "100%", marginTop: 6 }}>
      {list.map((e) => (
        <li key={e.id} className="muted" style={{ fontSize: 11.5 }}>
          {new Date(e.created_at).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}{" "}
          · {e.editor?.display_name ?? "someone"} · {e.field}:{" "}
          {fmtEditValue(e.field, e.old_value)} → {fmtEditValue(e.field, e.new_value)} ·
          “{e.reason}”
        </li>
      ))}
    </ul>
  );
}

export function Timecard() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole } = useEffectiveRole();
  const isLead = isForemanPlus(effectiveRole);
  const isSup = isSupervisorPlus(effectiveRole);

  const [anchor, setAnchor] = useState<Date>(() => new Date());
  /** Which shift's edit history is expanded (supervisor+). */
  const [historyId, setHistoryId] = useState<string | null>(null);
  const week = useMemo(() => weekRange(anchor), [anchor]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  /** Which runaway shift the office is entering a real finish time for. */
  const [finishingId, setFinishingId] = useState<string | null>(null);
  /** Which runaway shift is being written off to zero, and why. */
  const [zeroingId, setZeroingId] = useState<string | null>(null);
  const [zeroReason, setZeroReason] = useState("");

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
  /**
   * Deliberately not filtered to the selected week. A shift punched on 18 July
   * and never closed is absent from every week after it, which is exactly how
   * one ran for twelve days without anybody on this screen seeing it.
   */
  const unfinished = useQuery({
    queryKey: ["unfinishedShifts"],
    queryFn: listUnfinishedShifts,
    enabled: isLead,
    refetchInterval: 60_000,
  });
  const mineShifts = useQuery({
    queryKey: ["timecardMine", me.data?.id, week.startIso],
    queryFn: () => listShiftsForProfile(me.data!.id, week.startIso, week.endIso),
    enabled: !isLead && Boolean(me.data?.id),
  });
  const otRules = useQuery({
    queryKey: ["overtimeRules"],
    queryFn: listOvertimeRules,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["teamShifts"] });
    qc.invalidateQueries({ queryKey: ["timecardMine"] });
    qc.invalidateQueries({ queryKey: ["unfinishedShifts"] });
  };

  const runaways = useMemo(
    () => flaggedShifts(unfinished.data ?? [], Date.now()),
    [unfinished.data],
  );

  const approve = useMutation({ mutationFn: approveShift, onSuccess: refresh });
  const zeroOut = useMutation({
    mutationFn: (args: { id: string; reason: string }) =>
      closeShiftAsNoWork(args.id, args.reason),
    onSuccess: () => {
      setZeroingId(null);
      setZeroReason("");
      refresh();
    },
  });
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

  // The person's filed installs this week, keyed by the same local day as the
  // shift groups - so a day row can say what the hours actually built.
  const personEvents = useQuery({
    queryKey: ["timecardInstalls", activePersonId, week.startIso],
    queryFn: () =>
      listInstallEventsForProfile(activePersonId!, week.startIso, week.endIso),
    enabled: Boolean(activePersonId),
  });
  const eventsByDay = useMemo(() => {
    const m = new Map<string, typeof personEvents.data>();
    for (const ev of personEvents.data ?? []) {
      const d = punchDay(ev.created_at);
      const arr = m.get(d);
      if (arr) arr.push(ev);
      else m.set(d, [ev]);
    }
    return m;
  }, [personEvents.data]);

  /** One person's weekly regular/OT/double split under the rule that applies. */
  const splitFor = (profileId: string, shifts: TimeShift[]) => {
    const row = pickOvertimeRule(otRules.data ?? [], profileId);
    const rule = row ? overtimeRuleFromRow(row) : null;
    const byDay = new Map<string, number>();
    for (const s of shifts) {
      const d = punchDay(s.clock_in_at);
      byDay.set(d, (byDay.get(d) ?? 0) + shiftHours(s));
    }
    return splitOvertime([...byDay.values()], rule);
  };
  const personSplit = activePersonId ? splitFor(activePersonId, personShifts) : null;

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

  /** Weekly OT split per person, priced by whichever rule applies to them. */
  function exportOvertime() {
    const byPerson = new Map<string, { name: string; shifts: TimeShift[] }>();
    for (const s of teamShifts.data ?? []) {
      const e = byPerson.get(s.profile_id) ?? {
        name: s.profiles?.display_name ?? "Crew",
        shifts: [],
      };
      e.shifts.push(s);
      byPerson.set(s.profile_id, e);
    }
    return [...byPerson.entries()].map(([pid, e]) => ({
      employee: e.name,
      ...splitFor(pid, e.shifts),
    }));
  }

  function handleExportCsv() {
    const payload = {
      periodLabel: week.label,
      shifts: exportShifts(teamShifts.data ?? []),
      overtime: exportOvertime(),
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
      overtime: exportOvertime(),
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

          {runaways.length > 0 && (
            <section className="detail-card runaway-shifts" style={{ marginTop: 12 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>
                Still on the clock ({runaways.length})
              </h2>
              <p className="muted" style={{ margin: "2px 0 8px", fontSize: 12 }}>
                Longer than a normal day. These add <strong>no hours</strong> to
                anybody's total until someone puts a real finish time in — so a
                forgotten clock-out costs nothing, but it does need sorting.
              </p>
              <ul className="unit-list">
                {runaways.map((s) => {
                  const view = shiftGuard(s, Date.now());
                  const stopped = view.workedSeconds == null;
                  return (
                    <li key={s.id} className="find-row" style={{ flexWrap: "wrap" }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <strong>{s.profiles?.display_name ?? "Crew"}</strong>
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          {s.projects?.job_code ?? "—"} ·{" "}
                          {new Date(s.clock_in_at).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </div>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: stopped
                              ? "var(--danger, #f87171)"
                              : "var(--warn, #fbbf24)",
                          }}
                        >
                          {describeDuration(view.sinceClockInSeconds)} with no
                          clock-out
                          {stopped
                            ? " · stopped counting, needs a real finish time"
                            : " · still counting"}
                        </div>
                        {needsFinishTime(s) && s.edited_note && (
                          <div
                            className="muted"
                            style={{ fontSize: 11, marginTop: 2, fontStyle: "italic" }}
                          >
                            {s.edited_note}
                          </div>
                        )}
                      </div>
                      {/* Own row: two buttons and the crew name do not fit
                          side by side on a phone. */}
                      <div
                        className="row-gap"
                        style={{ flexBasis: "100%", flexWrap: "wrap", marginTop: 6 }}
                      >
                        <button
                          className="button-like active-pill"
                          onClick={() => {
                            setFinishingId(finishingId === s.id ? null : s.id);
                            setZeroingId(null);
                          }}
                        >
                          {finishingId === s.id ? "Close" : "Set finish time"}
                        </button>
                        <button
                          className="button-like"
                          onClick={() => {
                            setZeroingId(zeroingId === s.id ? null : s.id);
                            setZeroReason("");
                            setFinishingId(null);
                          }}
                        >
                          {zeroingId === s.id ? "Cancel" : "No work was done"}
                        </button>
                      </div>
                      {finishingId === s.id && (
                        <div style={{ flexBasis: "100%" }}>
                          <ShiftEditor
                            mode="edit"
                            shift={s}
                            profileId={s.profile_id}
                            projects={projects.data ?? []}
                            costCodes={costCodes.data ?? []}
                            onDone={() => setFinishingId(null)}
                          />
                        </div>
                      )}
                      {zeroingId === s.id && (
                        <div style={{ flexBasis: "100%", marginTop: 6 }}>
                          <p className="muted" style={{ margin: "0 0 6px", fontSize: 11.5 }}>
                            This records the punch as <strong>zero hours</strong> and
                            keeps it for the record. Nothing is paid and nothing is
                            deleted.
                          </p>
                          <div className="row-gap">
                            <input
                              type="text"
                              style={{ flex: 1 }}
                              placeholder="Why? e.g. clocked in by mistake"
                              value={zeroReason}
                              onChange={(e) => setZeroReason(e.target.value)}
                            />
                            <button
                              className="button-like active-pill"
                              disabled={zeroOut.isPending}
                              onClick={() =>
                                zeroOut.mutate({ id: s.id, reason: zeroReason })
                              }
                            >
                              {zeroOut.isPending ? "Saving…" : "Record as zero"}
                            </button>
                          </div>
                          {zeroOut.isError && (
                            <p className="error">{formatApiError(zeroOut.error)}</p>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

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
            {personSplit && personSplit.overtime + personSplit.doubleTime > 0 && (
              <span style={statusStyle("submitted")}>
                {" "}· {personSplit.regular.toFixed(1)} reg ·{" "}
                {personSplit.overtime.toFixed(1)} OT
                {personSplit.doubleTime > 0 &&
                  ` · ${personSplit.doubleTime.toFixed(1)} DT`}
              </span>
            )}
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
          {(eventsByDay.get(g.day) ?? []).length > 0 && (
            <p className="muted" style={{ fontSize: 11.5, margin: "2px 0 4px" }}>
              {(eventsByDay.get(g.day) ?? []).length} window
              {(eventsByDay.get(g.day) ?? []).length === 1 ? "" : "s"} installed:{" "}
              {(eventsByDay.get(g.day) ?? [])
                .map(
                  (ev) =>
                    `${ev.opening?.opening_code ?? "?"}` +
                    (ev.minutes != null ? ` ${ev.minutes}m` : "") +
                    (ev.quality_grade != null ? ` · G${ev.quality_grade}` : ""),
                )
                .join(", ")}
            </p>
          )}
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
                    {needsFinishTime(s) ? "needs a finish time" : s.status}
                    {s.injured && (
                      <span style={statusStyle("rejected")}> · injury</span>
                    )}
                    {/* The crew member answered "No" to "is your time correct?"
                        at clock-out — the day is theirs to dispute, and this is
                        where the office sees it. */}
                    {s.time_confirmed === false && (
                      <span style={statusStyle("rejected")}> · time flagged by crew</span>
                    )}
                    {s.edited_by &&
                      (isSup ? (
                        <button
                          className="button-like"
                          style={{ fontSize: 11, padding: "0 6px", marginLeft: 4 }}
                          onClick={() =>
                            setHistoryId((v) => (v === s.id ? null : s.id))
                          }
                        >
                          adjusted · history
                        </button>
                      ) : (
                        <span className="muted"> · adjusted</span>
                      ))}
                  </div>
                  {historyId === s.id && isSup && <ShiftHistory shiftId={s.id} />}
                  {shiftGuard(s, Date.now()).flagged && (
                    <div style={{ fontSize: 11.5, ...statusStyle("submitted") }}>
                      {describeDuration(shiftGuard(s, Date.now()).sinceClockInSeconds)}{" "}
                      since clock-in — longer than a normal day
                    </div>
                  )}
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
