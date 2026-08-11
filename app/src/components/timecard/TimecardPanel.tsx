// One person's timecard, Horizon style: Day / Week / Pay-period tabs, an
// arrow stepper with a "this week" reset, one big mono total card carrying
// the Regular · Overtime · break split, then collapsible per-day cards —
// empty days included, today open by default — of PunchCards. Approvals stay
// per punch (owner call, 2026-08-11); Horizon's period sign-off was not
// ported. Shared by the lead's drill-down and the installer's own view.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Coffee, Download } from "lucide-react";
import { QueryError, SkeletonList } from "../ui/States";
import { listInstallEventsForProfile } from "../../lib/install/api";
import {
  addDays,
  approveShift,
  currentBreakSeconds,
  elapsedWorkSeconds,
  listOvertimeRules,
  listShiftsForProfile,
  punchDay,
  rangeDays,
  rejectShift,
  shiftHours,
  timecardRange,
  weekRange,
  type TimecardRangeMode,
  type TimeShift,
} from "../../lib/timeclock";
import {
  overtimeRuleFromRow,
  pickOvertimeRule,
  splitOvertime,
} from "../../lib/overtime";
import {
  buildTimecardCsv,
  buildTimecardTsv,
  type TimecardExportShift,
} from "../../lib/timecardExport";
import { PunchCard } from "./PunchCard";
import { ShiftEditor, type CostOpt, type ProjectOpt } from "./ShiftEditor";
import { fmtHours, fmtTime } from "./format";
import { printTimesheet } from "./printTimesheet";

function downloadText(text: string, filename: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Big-card total: 38.5h style reads faster on a phone than H:MM:SS. */
function fmtTotal(hours: number): string {
  return `${hours.toFixed(1)}h`;
}

interface TimecardPanelProps {
  personId: string;
  personName: string;
  isLead: boolean;
  isSup: boolean;
  canEdit: boolean;
  projects: ProjectOpt[];
  costCodes: CostOpt[];
  /** The person's currently-open shift, if any — powers the live hero card. */
  openShift: TimeShift | null;
}

export function TimecardPanel({
  personId,
  personName,
  isLead,
  isSup,
  canEdit,
  projects,
  costCodes,
  openShift,
}: TimecardPanelProps) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<TimecardRangeMode>("week");
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [showRemoved, setShowRemoved] = useState(false);
  const [adding, setAdding] = useState<string | null>(null); // ISO prefill or "now"
  const [exportOpen, setExportOpen] = useState(false);
  const today = punchDay(new Date().toISOString());
  const [openDays, setOpenDays] = useState<Set<string>>(() => new Set([today]));

  const range = useMemo(() => timecardRange(mode, anchor), [mode, anchor]);
  const stepDays = mode === "day" ? 1 : mode === "pay" ? 14 : 7;

  const shifts = useQuery({
    queryKey: ["timecardPanel", personId, range.startIso, range.endIso, showRemoved],
    queryFn: () =>
      listShiftsForProfile(personId, range.startIso, range.endIso, showRemoved),
  });
  const otRules = useQuery({
    queryKey: ["overtimeRules"],
    queryFn: listOvertimeRules,
  });
  // The person's filed installs, keyed by the same local day as the punch
  // groups — so a day card can say what the hours actually built.
  const events = useQuery({
    queryKey: ["timecardInstalls", personId, range.startIso, range.endIso],
    queryFn: () =>
      listInstallEventsForProfile(personId, range.startIso, range.endIso),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["timecardPanel"] });
    qc.invalidateQueries({ queryKey: ["teamShifts"] });
    qc.invalidateQueries({ queryKey: ["unfinishedShifts"] });
  };
  // Weekly approval (owner call, 2026-08-11): one action approves every
  // submitted punch in the visible week. Storage stays per-shift status, so
  // edit-honesty still works — editing an approved punch drops it back to
  // submitted and the week reads "needs approval" again.
  const approveWeek = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await approveShift(id);
      return ids.length;
    },
    onSuccess: refresh,
  });
  const reject = useMutation({
    mutationFn: (args: { id: string; reason: string }) =>
      rejectShift(args.id, args.reason),
    onSuccess: refresh,
  });

  // Live tick while the hero card is showing a running timer.
  const [, setNowTick] = useState(0);
  const heroLive = Boolean(openShift && !openShift.clock_out_at);
  useEffect(() => {
    if (!heroLive) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [heroLive]);

  const rows = useMemo(() => shifts.data ?? [], [shifts.data]);
  const paidRows = useMemo(
    () => rows.filter((s) => s.status !== "voided"),
    [rows],
  );
  const byDay = useMemo(() => {
    const m = new Map<string, TimeShift[]>();
    for (const s of rows) {
      const d = punchDay(s.clock_in_at);
      const arr = m.get(d);
      if (arr) arr.push(s);
      else m.set(d, [s]);
    }
    return m;
  }, [rows]);
  const eventsByDay = useMemo(() => {
    const m = new Map<string, NonNullable<typeof events.data>>();
    for (const ev of events.data ?? []) {
      const d = punchDay(ev.created_at);
      const arr = m.get(d);
      if (arr) arr.push(ev);
      else m.set(d, [ev]);
    }
    return m;
  }, [events.data]);

  const total = paidRows.reduce((t, s) => t + shiftHours(s), 0);
  const breakHours = paidRows.reduce((t, s) => t + (s.break_seconds ?? 0), 0) / 3600;

  /**
   * Weekly OT rule applied per calendar week — a 14-day pay period is two
   * separate weekly buckets, never one 80-hour pool.
   */
  const split = useMemo(() => {
    const row = pickOvertimeRule(otRules.data ?? [], personId);
    const rule = row ? overtimeRuleFromRow(row) : null;
    const weeks = new Map<string, Map<string, number>>();
    for (const s of paidRows) {
      const wk = weekRange(new Date(s.clock_in_at)).startIso;
      const d = punchDay(s.clock_in_at);
      const days = weeks.get(wk) ?? new Map<string, number>();
      days.set(d, (days.get(d) ?? 0) + shiftHours(s));
      weeks.set(wk, days);
    }
    let regular = 0;
    let overtime = 0;
    let doubleTime = 0;
    for (const days of weeks.values()) {
      const s = splitOvertime([...days.values()], rule);
      regular += s.regular;
      overtime += s.overtime;
      doubleTime += s.doubleTime;
    }
    return { regular, overtime, doubleTime };
  }, [paidRows, otRules.data, personId]);

  const submittedIds = useMemo(
    () => paidRows.filter((s) => s.status === "submitted").map((s) => s.id),
    [paidRows],
  );
  // "Approved" only when every closed punch made it through — open shifts
  // and rejected punches keep the week honest instead of green.
  const weekApproved =
    paidRows.length > 0 && paidRows.every((s) => s.status === "approved");

  const totalLabel =
    mode === "day" ? "Total today" : mode === "pay" ? "Total this pay period" : "Total this week";

  function exportRows(): TimecardExportShift[] {
    return paidRows.map((s) => ({
      employee: s.profiles?.display_name ?? personName,
      day: punchDay(s.clock_in_at),
      start: fmtTime(s.clock_in_at),
      end: s.clock_out_at ? fmtTime(s.clock_out_at) : "",
      hours: shiftHours(s),
      job: s.projects?.job_code ?? "—",
      costCode: s.cost_codes ? `${s.cost_codes.code} - ${s.cost_codes.label}` : "-",
      status: s.status,
    }));
  }
  const exportPayload = () => ({
    periodLabel: `${personName} · ${range.label}`,
    shifts: exportRows(),
    overtime: [{ employee: personName, ...split }],
  });

  const onBreak = Boolean(openShift?.break_started_at);

  return (
    <div className="tcx-panel">
      {/* Live hero: this person is on the clock right now. */}
      {openShift && heroLive && (
        <div className={`tcx-hero${onBreak ? " break" : ""}`}>
          <div>
            <div className="tcx-label">
              {onBreak ? "On break" : "On the clock"}
              {openShift.projects?.job_code && ` · ${openShift.projects.job_code}`}
            </div>
            <div className="tcx-hero-timer">
              {new Date(elapsedWorkSeconds(openShift) * 1000).toISOString().slice(11, 19)}
            </div>
            <div className="muted" style={{ fontSize: 11.5 }}>
              since {fmtTime(openShift.clock_in_at)}
              {currentBreakSeconds(openShift) > 0 &&
                ` · ${fmtHours(currentBreakSeconds(openShift) / 3600)} on breaks`}
            </div>
          </div>
          <span className={`tcx-dot${onBreak ? " amber" : ""}`} aria-hidden />
        </div>
      )}

      {/* Range tabs */}
      <div className="seg tcx-tabs" role="tablist" aria-label="Timecard range">
        {(["day", "week", "pay"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            className={mode === m ? "active-pill button-like" : "button-like"}
            onClick={() => setMode(m)}
          >
            {m === "day" ? "Day" : m === "week" ? "Week" : "Pay period"}
          </button>
        ))}
      </div>

      {/* Stepper */}
      <div className="row-gap" style={{ alignItems: "center" }}>
        <button
          className="button-like"
          onClick={() => setAnchor((d) => addDays(d, -stepDays))}
          aria-label="Previous"
        >
          <ChevronLeft size={18} />
        </button>
        <button
          className="button-like"
          style={{ flex: 1 }}
          onClick={() => setAnchor(new Date())}
          title="Jump back to now"
        >
          {range.label}
        </button>
        <button
          className="button-like"
          onClick={() => setAnchor((d) => addDays(d, stepDays))}
          aria-label="Next"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {/* Big total card */}
      <div className="tcx-total">
        <div>
          <div className="tcx-label">{totalLabel}</div>
          <div className="tcx-total-num">{fmtTotal(total)}</div>
          <div className="tcx-split">
            Regular {fmtHours(split.regular)}
            <span className={split.overtime > 0 ? "tcx-ot" : ""}>
              {" "}· Overtime {fmtHours(split.overtime)}
            </span>
            {split.doubleTime > 0 && ` · Double ${fmtHours(split.doubleTime)}`}
          </div>
          {breakHours > 0 && (
            <div className="tcx-breakline">
              <Coffee size={12} aria-hidden /> {fmtHours(breakHours)} on breaks (excluded)
            </div>
          )}
        </div>
        {isLead && canEdit && mode === "week" && (
          submittedIds.length > 0 ? (
            <button
              className="button-like active-pill"
              disabled={approveWeek.isPending}
              onClick={() => approveWeek.mutate(submittedIds)}
            >
              {approveWeek.isPending
                ? "Approving…"
                : `Approve week (${submittedIds.length})`}
            </button>
          ) : weekApproved ? (
            <span className="tcx-week-ok">
              <CheckCircle2 size={15} aria-hidden /> Week approved
            </span>
          ) : null
        )}
      </div>

      {/* Entries strip */}
      <div className="tcx-entries-strip">
        <span className="tcx-label">Entries</span>
        <div className="row-gap" style={{ marginLeft: "auto", position: "relative" }}>
          <button
            className="button-like"
            onClick={() => setExportOpen((v) => !v)}
            disabled={paidRows.length === 0}
          >
            <Download size={14} aria-hidden /> Export <ChevronDown size={12} aria-hidden />
          </button>
          {exportOpen && (
            <div className="tcx-menu" onClick={() => setExportOpen(false)}>
              <button
                className="button-like"
                onClick={() =>
                  downloadText(
                    buildTimecardCsv(exportPayload()),
                    `timecard-${personName.toLowerCase().replace(/\s+/g, "-")}-${range.startIso.slice(0, 10)}.csv`,
                    "text/csv;charset=utf-8",
                  )
                }
              >
                Export CSV
              </button>
              <button
                className="button-like"
                onClick={() =>
                  void navigator.clipboard.writeText(buildTimecardTsv(exportPayload()))
                }
              >
                Copy for Sheets
              </button>
              <button
                className="button-like"
                onClick={() =>
                  printTimesheet({
                    personName,
                    periodLabel: range.label,
                    shifts: paidRows,
                    ...split,
                  })
                }
              >
                Print · PDF
              </button>
            </div>
          )}
          {canEdit && (
            <button
              className="button-like active-pill"
              onClick={() => setAdding((v) => (v == null ? "now" : null))}
            >
              {adding != null ? "Close" : "+ Add entry"}
            </button>
          )}
        </div>
      </div>

      {isLead && (
        <label className="tcx-removed-toggle">
          <input
            type="checkbox"
            checked={showRemoved}
            onChange={(e) => setShowRemoved(e.target.checked)}
          />
          Show removed entries
        </label>
      )}

      {adding != null && canEdit && (
        <ShiftEditor
          mode="add"
          shift={null}
          profileId={personId}
          projects={projects}
          costCodes={costCodes}
          defaultInAt={adding === "now" ? undefined : adding}
          onDone={() => setAdding(null)}
        />
      )}

      {shifts.isError && (
        <QueryError
          error={shifts.error}
          onRetry={() => void shifts.refetch()}
          label="Couldn't load the timecard"
        />
      )}
      {shifts.isLoading && <SkeletonList rows={3} />}

      {/* Day cards — every day in the range, empty ones included. */}
      {!shifts.isLoading &&
        rangeDays(range).map((day) => {
          const list = byDay.get(day) ?? [];
          const paid = list.filter((s) => s.status !== "voided");
          const dayTotal = paid.reduce((t, s) => t + shiftHours(s), 0);
          const isOpen = openDays.has(day) || mode === "day";
          const evs = eventsByDay.get(day) ?? [];
          const label = new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
            weekday: "short",
            month: "numeric",
            day: "numeric",
          });
          return (
            <div key={day} className={`tcx-day${list.length === 0 ? " empty" : ""}`}>
              <button
                type="button"
                className="tcx-day-head"
                aria-expanded={isOpen}
                onClick={() =>
                  setOpenDays((prev) => {
                    const next = new Set(prev);
                    if (next.has(day)) next.delete(day);
                    else next.add(day);
                    return next;
                  })
                }
              >
                <span>{label}</span>
                <span className="tcx-day-total">
                  {list.length > 0 ? fmtHours(dayTotal) : "—"}
                  <ChevronDown
                    size={14}
                    aria-hidden
                    style={{
                      transform: isOpen ? "rotate(180deg)" : "none",
                      transition: "transform .15s",
                    }}
                  />
                </span>
              </button>
              {isOpen && (
                <div className="tcx-day-body">
                  {evs.length > 0 && (
                    <p className="muted" style={{ fontSize: 11.5, margin: "0 0 6px" }}>
                      {evs.length} window{evs.length === 1 ? "" : "s"} installed:{" "}
                      {evs
                        .map(
                          (ev) =>
                            `${ev.opening?.opening_code ?? "?"}` +
                            (ev.minutes != null ? ` ${ev.minutes}m` : "") +
                            (ev.quality_grade != null ? ` · G${ev.quality_grade}` : ""),
                        )
                        .join(", ")}
                    </p>
                  )}
                  {list.map((s) => (
                    <PunchCard
                      key={s.id}
                      shift={s}
                      isLead={isLead}
                      isSup={isSup}
                      canEdit={canEdit}
                      projects={projects}
                      costCodes={costCodes}
                      reject={{ ...reject, error: reject.error }}
                    />
                  ))}
                  {list.length === 0 && (
                    <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                      No entries
                      {canEdit && (
                        <button
                          className="button-like"
                          style={{ marginLeft: 8, fontSize: 11.5, padding: "2px 8px" }}
                          onClick={() => setAdding(`${day}T07:00:00`)}
                        >
                          + Add
                        </button>
                      )}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
