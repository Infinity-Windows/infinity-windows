// Team timecards (foreman+): the live roster — pulsing dot and running
// timer for whoever is on the clock, week hours and approval chips on every
// row — and tap a person to open the shared TimecardPanel with full edit.
// Split out of /timecard (owner ask, 2026-08-11): My timecard is personal,
// this tab is the whole crew. The runaway-shift guard lives here because a
// forgotten clock-out is the office's problem, not one person's.

import { BackChip } from "../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { listProjects } from "../lib/api";
import { formatApiError } from "../lib/errors";
import { lastSeenAwayFromJob } from "../lib/farFromJob";
import {
  formatLocalTime,
  getCompanySettings,
  setEveningNudgeTime,
  toTimeInput,
} from "../lib/companySettings";
import { useT } from "../lib/i18n";
import { SkeletonList } from "../components/ui/States";
import { listProfiles } from "../lib/install/api";
import { isForemanPlus, isSupervisorPlus, visibleRole } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import {
  addDays,
  closeShiftAsNoWork,
  elapsedWorkSeconds,
  listCostCodes,
  listOvertimeRules,
  listTeamShifts,
  listUnfinishedShifts,
  punchDay,
  shiftHours,
  shiftsToExportRows,
  summarizeTeamWeek,
  timecardRange,
  weekRange,
} from "../lib/timeclock";
import { overtimeRuleFromRow, pickOvertimeRule } from "../lib/overtime";
import { splitOvertimeByPerson } from "../lib/overtimeRollup";
import {
  buildGustoCsv,
  gustoFileName,
  splitDisplayName,
} from "../lib/gustoExport";
import { buildTimecardCsv, buildTimecardTsv } from "../lib/timecardExport";
import {
  describeDuration,
  flaggedShifts,
  needsFinishTime,
  shiftGuard,
  suspectReason,
  suspectShifts,
} from "../lib/shiftGuard";
import { TimecardPanel } from "../components/timecard/TimecardPanel";
import { ShiftEditor } from "../components/timecard/ShiftEditor";
import { TimeByJobReport } from "../components/timecard/TimeByJobReport";
import { CrewClockBar } from "../components/timecard/CrewClockBar";
import {
  addCrewIds,
  allCrewIds,
  onClockCrewIds,
  toggleCrewId,
  type CrewClockMember,
} from "../lib/crewClock";
import { fmtTime } from "../components/timecard/format";

function downloadText(text: string, filename: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function TeamTimecards() {
  const qc = useQueryClient();
  const t = useT();
  const { effectiveRole } = useEffectiveRole();
  const isLead = isForemanPlus(effectiveRole);
  const isSup = isSupervisorPlus(effectiveRole);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  /** Which runaway shift the office is entering a real finish time for. */
  const [finishingId, setFinishingId] = useState<string | null>(null);
  /** Which runaway shift is being written off to zero, and why. */
  const [zeroingId, setZeroingId] = useState<string | null>(null);
  const [zeroReason, setZeroReason] = useState("");

  // K5: the page used to be hard-wired to "this week", which is not the shape
  // payroll is paid in. Week or pay period, with a stepper — the same two
  // buckets and the same stepper TimecardPanel gives one person.
  const [rangeMode, setRangeMode] = useState<"week" | "pay">("week");
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const week = useMemo(() => timecardRange(rangeMode, anchor), [rangeMode, anchor]);
  const stepDays = rangeMode === "pay" ? 14 : 7;
  const crew = useQuery({
    queryKey: ["profiles"],
    queryFn: listProfiles,
    enabled: isLead,
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const costCodes = useQuery({ queryKey: ["costCodes"], queryFn: listCostCodes });
  const teamShifts = useQuery({
    queryKey: ["teamShifts", week.startIso, week.endIso],
    queryFn: () => listTeamShifts(week.startIso, week.endIso),
    enabled: isLead,
  });
  // The overtime rules — company default plus any per-person override. Only
  // the exports use them; the roster still shows plain worked hours.
  const otRules = useQuery({
    queryKey: ["overtimeRules"],
    queryFn: listOvertimeRules,
    enabled: isLead,
  });
  /**
   * Deliberately not filtered to the current week. A shift punched on 18 July
   * and never closed is absent from every week after it, which is exactly how
   * one ran for twelve days without anybody on this screen seeing it. Also
   * the roster's live "on the clock" source.
   */
  const unfinished = useQuery({
    queryKey: ["unfinishedShifts"],
    queryFn: listUnfinishedShifts,
    enabled: isLead,
    refetchInterval: 30_000,
  });
  // Tick every second while anyone is live on the roster.
  const liveShifts = useMemo(
    () => (unfinished.data ?? []).filter((s) => s.status === "open"),
    [unfinished.data],
  );
  const [, setTick] = useState(0);
  useEffect(() => {
    if (liveShifts.length === 0 || selectedId != null) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [liveShifts.length, selectedId]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["teamShifts"] });
    qc.invalidateQueries({ queryKey: ["timecardPanel"] });
    qc.invalidateQueries({ queryKey: ["unfinishedShifts"] });
  };
  const zeroOut = useMutation({
    mutationFn: (args: { id: string; reason: string }) =>
      closeShiftAsNoWork(args.id, args.reason),
    onSuccess: () => {
      setZeroingId(null);
      setZeroReason("");
      refresh();
    },
  });

  // K2: the evening nudge hour. Read once, edited in place; the inputs follow
  // the stored row until somebody touches them.
  const settings = useQuery({
    queryKey: ["companySettings"],
    queryFn: getCompanySettings,
    enabled: isLead,
  });
  const [nudgeTime, setNudgeTime] = useState("");
  const [nudgeOn, setNudgeOn] = useState(true);
  useEffect(() => {
    if (!settings.data) return;
    setNudgeTime(toTimeInput(settings.data.evening_nudge_local_time));
    setNudgeOn(settings.data.evening_nudge_enabled);
  }, [settings.data]);
  const saveNudge = useMutation({
    mutationFn: () => setEveningNudgeTime(nudgeTime, nudgeOn),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["companySettings"] }),
  });

  const runaways = useMemo(
    () => flaggedShifts(unfinished.data ?? [], Date.now()),
    [unfinished.data],
  );
  // T6: a data-sanity check on this week's already-closed punches, not a
  // pay calculation — negative or >24h spans are almost always a typo or a
  // bad edit. Scoped to the same week the rest of this page already loads
  // (teamShifts), unlike the runaway list above, which deliberately ignores
  // week boundaries because a shift with no clock_out_at yet has no stable
  // week of its own to be found in.
  const suspects = useMemo(
    () => suspectShifts(teamShifts.data ?? []),
    [teamShifts.data],
  );
  const weekSummary = useMemo(
    () => summarizeTeamWeek(teamShifts.data ?? []),
    [teamShifts.data],
  );

  /** Roster: every active crew member, clocked-in first (longest at top). */
  const rosterAll = useMemo(() => {
    const byId = new Map(weekSummary.map((r) => [r.profileId, r]));
    const openBy = new Map(liveShifts.map((s) => [s.profile_id, s]));
    const rows = (crew.data ?? [])
      .filter((p) => p.active)
      .map((p) => ({
        id: p.id,
        name: p.display_name,
        role: p.role,
        open: openBy.get(p.id) ?? null,
        hours: byId.get(p.id)?.hours ?? 0,
        submitted: byId.get(p.id)?.submittedCount ?? 0,
        rejected: byId.get(p.id)?.rejectedCount ?? 0,
      }));
    rows.sort((a, b) => {
      if (Boolean(a.open) !== Boolean(b.open)) return a.open ? -1 : 1;
      if (a.open && b.open)
        return a.open.clock_in_at.localeCompare(b.open.clock_in_at);
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return rows;
  }, [crew.data, weekSummary, liveShifts]);

  /** What the search box is showing. Selection is kept against the FULL list. */
  const roster = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? rosterAll.filter((r) => r.name.toLowerCase().includes(q)) : rosterAll;
  }, [rosterAll, search]);

  // ---- Clocking the crew in and out (owner ask, 2026-09-04) ----
  // Ticked people, held against the WHOLE roster rather than what the search
  // box happens to be showing: typing a name to find one person must not
  // quietly drop the thirteen already ticked out of the next tap.
  const [selected, setSelected] = useState<string[]>([]);
  const crewMembers = useMemo<CrewClockMember[]>(
    () =>
      rosterAll.map((r) => ({
        id: r.id,
        name: r.name,
        onClock: Boolean(r.open),
        openProjectId: r.open?.project_id ?? null,
      })),
    [rosterAll],
  );
  // …but the two "select" buttons act on what is ON SCREEN. Handing them the
  // whole roster meant a supervisor filtered down to one name could tick, and
  // then clock in, forty-one people in two taps with nothing but a number in
  // the bar to say so (2026-09-04 review). They ADD rather than replace, so
  // finding a second name later never unticks the first.
  const visibleMembers = useMemo<CrewClockMember[]>(() => {
    const shown = new Set(roster.map((r) => r.id));
    return crewMembers.filter((m) => shown.has(m.id));
  }, [crewMembers, roster]);
  const visibleOnClock = useMemo(
    () => onClockCrewIds(visibleMembers),
    [visibleMembers],
  );
  // Somebody who left the roster (deactivated between renders) must not stay
  // in a selection the bar would then send ids the screen can no longer name.
  useEffect(() => {
    setSelected((s) => {
      const live = new Set(crewMembers.map((m) => m.id));
      const kept = s.filter((id) => live.has(id));
      return kept.length === s.length ? s : kept;
    });
  }, [crewMembers]);

  const clockedCount = roster.filter((r) => r.open).length;
  /** "8.0h wk" / "8.0h pay" — the roster total follows the range on show. */
  const hoursSuffix = rangeMode === "pay" ? "pay" : "wk";
  // `sum`, not `t` — `t` is the translator on this component now.
  const pendingCount = weekSummary.reduce((sum, r) => sum + r.submittedCount, 0);

  // ---- Team-wide export (the roster's "Export all") ----
  // T7: shiftsToExportRows (lib/timeclock.ts) is the one shared mapping —
  // see its comment for why it lives there instead of timecardExport.ts.
  //
  // K5: the overtime split is no longer empty. Per person, per CALENDAR week,
  // so a pay period is two weekly buckets and never one 80-hour pool — the
  // same rule the per-person export has always followed.
  const overtimeLines = useMemo(() => {
    const rules = otRules.data ?? [];
    const rows = (teamShifts.data ?? [])
      .filter((s) => s.status !== "voided")
      .map((s) => ({
        profileId: s.profile_id,
        employee: s.profiles?.display_name ?? "Crew",
        day: punchDay(s.clock_in_at),
        week: weekRange(new Date(s.clock_in_at)).startIso,
        hours: shiftHours(s),
      }));
    return splitOvertimeByPerson(rows, (profileId) => {
      const row = pickOvertimeRule(rules, profileId);
      return row ? overtimeRuleFromRow(row) : null;
    });
  }, [teamShifts.data, otRules.data]);

  const teamPayload = () => ({
    periodLabel: week.label,
    shifts: shiftsToExportRows(teamShifts.data ?? []),
    overtime: overtimeLines.map(({ employee, regular, overtime, doubleTime }) => ({
      employee,
      regular,
      overtime,
      doubleTime,
    })),
  });

  /** The Gusto upload: one row per employee for the whole pay period. */
  const gustoRows = () =>
    overtimeLines.map((line) => ({
      ...splitDisplayName(line.employee),
      regular: line.regular,
      overtime: line.overtime,
      doubleOvertime: line.doubleTime,
    }));

  const selectedName =
    roster.find((r) => r.id === selectedId)?.name ??
    crew.data?.find((c) => c.id === selectedId)?.display_name ??
    "Crew member";
  const selectedOpen =
    liveShifts.find((s) => s.profile_id === selectedId) ?? null;

  // ---- Lead, person selected: the drill-down ----
  if (selectedId) {
    return (
      <div className="page">
        <header className="page-header">
          <div className="row-gap" style={{ alignItems: "center", minWidth: 0 }}>
            <button
              className="back-chip"
              aria-label="Back to the team"
              onClick={() => setSelectedId(null)}
            >
              ‹
            </button>
            <span className="tcx-avatar" aria-hidden>
              {initials(selectedName)}
            </span>
            <div style={{ minWidth: 0 }}>
              <h1 style={{ margin: 0, fontSize: 20 }}>{selectedName}</h1>
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                Managing time for {selectedName}
              </p>
            </div>
          </div>
        </header>
        <TimecardPanel
          personId={selectedId}
          personName={selectedName}
          isLead
          isSup={isSup}
          canEdit
          projects={projects.data ?? []}
          costCodes={costCodes.data ?? []}
          openShift={selectedOpen}
        />
      </div>
    );
  }

  // ---- Lead, no selection: the live roster ----
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Team timecards</h1>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            <span className="tcx-on">{clockedCount}</span> on the clock ·{" "}
            {roster.length - clockedCount} off · tap a member to view & edit
          </p>
        </div>
        <BackChip fallback="/" label="Home" />
      </header>

      {/* K5: which stretch of time this whole page is about. */}
      <div className="seg tcx-tabs" role="tablist" aria-label={t("tcx.range.aria")}>
        {(["week", "pay"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={rangeMode === m}
            className={rangeMode === m ? "active-pill button-like" : "button-like"}
            onClick={() => setRangeMode(m)}
          >
            {m === "week" ? t("tcx.range.week") : t("tcx.range.pay")}
          </button>
        ))}
      </div>
      <div className="row-gap" style={{ alignItems: "center" }}>
        <button
          className="button-like"
          onClick={() => setAnchor((d) => addDays(d, -stepDays))}
          aria-label={t("tcx.range.prev")}
        >
          <ChevronLeft size={18} />
        </button>
        <button
          className="button-like"
          style={{ flex: 1 }}
          onClick={() => setAnchor(new Date())}
          title={t("tcx.range.backToNow")}
        >
          {week.label}
        </button>
        <button
          className="button-like"
          onClick={() => setAnchor((d) => addDays(d, stepDays))}
          aria-label={t("tcx.range.next")}
        >
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="row-gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="button-like"
          onClick={() =>
            downloadText(
              buildTimecardCsv(teamPayload()),
              `team-timecard-${week.startIso.slice(0, 10)}.csv`,
              "text/csv;charset=utf-8",
            )
          }
          disabled={(teamShifts.data ?? []).length === 0}
        >
          Export all (CSV)
        </button>
        {/* The file the office uploads to Gusto — one row per employee for the
            whole pay period, so it only means anything in pay-period mode. */}
        {rangeMode === "pay" ? (
          <button
            className="button-like active-pill"
            onClick={() =>
              downloadText(
                buildGustoCsv(gustoRows()),
                gustoFileName(week.startIso),
                "text/csv;charset=utf-8",
              )
            }
            disabled={overtimeLines.length === 0}
          >
            {t("tcx.export.gusto")}
          </button>
        ) : (
          <span className="muted" style={{ fontSize: 11.5 }}>
            {t("tcx.export.gustoHint")}
          </span>
        )}
        <button
          className="button-like"
          onClick={() =>
            void navigator.clipboard.writeText(buildTimecardTsv(teamPayload()))
          }
          disabled={(teamShifts.data ?? []).length === 0}
        >
          Copy for Sheets
        </button>
        {pendingCount > 0 && (
          <span className="tcx-chip sky" style={{ marginLeft: "auto" }}>
            {pendingCount} to approve
          </span>
        )}
      </div>

      {/* K2: when the evening "Still on the job?" push goes out. A foreman's
          call, not a constant — a crew that starts at 5am wants asking earlier.
          Absent entirely on a database that hasn't applied the migration. */}
      {settings.data && (
        <div className="row-gap" style={{ alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            {t("nudge.label", {
              time: formatLocalTime(settings.data.evening_nudge_local_time),
            })}
          </span>
          <input
            type="time"
            aria-label={t("nudge.aria")}
            value={nudgeTime}
            onChange={(e) => setNudgeTime(e.target.value)}
            style={{ width: 120 }}
          />
          <label className="row-gap" style={{ alignItems: "center", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={nudgeOn}
              onChange={(e) => setNudgeOn(e.target.checked)}
            />
            {t("nudge.on")}
          </label>
          <button
            className="button-like"
            disabled={saveNudge.isPending || !nudgeTime}
            onClick={() => saveNudge.mutate()}
          >
            {saveNudge.isPending ? t("nudge.saving") : t("nudge.save")}
          </button>
          {saveNudge.isError && (
            <p className="error" style={{ flexBasis: "100%", margin: 0 }}>
              {formatApiError(saveNudge.error)}
            </p>
          )}
        </div>
      )}

      {suspects.length > 0 && (
        <section className="detail-card" style={{ marginTop: 12 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>
            Suspect punches in this {rangeMode === "pay" ? "pay period" : "week"} ({suspects.length})
          </h2>
          <p className="muted" style={{ margin: "2px 0 8px", fontSize: 12 }}>
            Clock-out before clock-in, or a span over 24 hours — almost
            always a typo or a bad edit, worth a second look before payroll.
          </p>
          <ul className="unit-list">
            {suspects.map((s) => (
              <li key={s.id} className="find-row">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <strong>{s.profiles?.display_name ?? "Crew"}</strong>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {s.projects?.job_code ?? "—"} · {fmtTime(s.clock_in_at)} –{" "}
                    {fmtTime(s.clock_out_at)}
                  </div>
                </div>
                <span className="tcx-chip bad">
                  {suspectReason(s) === "negative" ? "negative duration" : "over 24h"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

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
                    {/* K3: where they were the last time the app was opened on
                        this punch — shown ONLY when that is away from where the
                        punch started, because "last seen at the job" for
                        everybody would just be noise. */}
                    {(() => {
                      const seen = lastSeenAwayFromJob(s);
                      if (!seen) return null;
                      return (
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          {t("lastseen.farFromJob", {
                            miles: seen.miles,
                            time: fmtTime(seen.atIso),
                          })}
                        </div>
                      );
                    })()}
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
                    {/* Q3: this reuses the full edit sheet (edit_shift), now
                        supervisor+ only — a foreman keeps "No work was done"
                        (close_shift_as_no_work, untouched) but no longer sees
                        the edit-sheet path, so nobody hits a permission error
                        clicking a button the page still showed them. */}
                    {isSup && (
                      <button
                        className="button-like active-pill"
                        onClick={() => {
                          setFinishingId(finishingId === s.id ? null : s.id);
                          setZeroingId(null);
                        }}
                      >
                        {finishingId === s.id ? "Close" : "Set finish time"}
                      </button>
                    )}
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
                  {finishingId === s.id && isSup && (
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

      <div className="tcx-search">
        <Search size={14} aria-hidden />
        <input
          type="search"
          placeholder="Search the crew…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Supervisors pick people; foremen only read this page (Q3 keeps every
          time EDIT at supervisor+, and clocking somebody in is an edit to
          their pay), so the checkboxes and the bar are simply absent for them. */}
      {isSup && (
        <div className="row-gap" style={{ marginTop: 10, flexWrap: "wrap" }}>
          <button
            className="button-like"
            disabled={visibleMembers.length === 0}
            onClick={() =>
              setSelected((sel) => addCrewIds(sel, allCrewIds(visibleMembers)))
            }
          >
            {t("crewclock.select.all", { n: visibleMembers.length })}
          </button>
          <button
            className="button-like"
            disabled={visibleOnClock.length === 0}
            onClick={() => setSelected((sel) => addCrewIds(sel, visibleOnClock))}
          >
            {t("crewclock.select.onClock", { n: visibleOnClock.length })}
          </button>
          <button
            className="button-like"
            disabled={selected.length === 0}
            onClick={() => setSelected([])}
          >
            {t("crewclock.select.clear")}
          </button>
        </div>
      )}

      {(crew.isLoading || teamShifts.isLoading) && <SkeletonList rows={4} />}
      <div className={isSup ? "tcx-roster picking" : "tcx-roster"}>
        {roster.map((r) => {
          const live = r.open;
          const row = (
            <button
              type="button"
              className={`tcx-row${live ? " live" : ""}`}
              onClick={() => setSelectedId(r.id)}
            >
              <span className={`tcx-dot${live ? "" : " off"}`} aria-hidden />
              <span className={`tcx-avatar${live ? " live" : ""}`} aria-hidden>
                {initials(r.name)}
              </span>
              <span className="tcx-row-main">
                <span className="tcx-row-name">
                  {r.name}
                  {/* Owners read as supervisors to everyone below owner. */}
                  <span className="tcx-role">{visibleRole(r.role, effectiveRole)}</span>
                </span>
                <span className="tcx-row-sub">
                  {live ? (
                    <>
                      <span className="tcx-timer">
                        {describeDuration(elapsedWorkSeconds(live))}
                      </span>
                      {live.projects?.job_code && ` · ${live.projects.job_code}`}
                      {` · ${r.hours.toFixed(1)}h ${hoursSuffix}`}
                    </>
                  ) : (
                    `Off clock · ${r.hours.toFixed(1)}h ${hoursSuffix}`
                  )}
                </span>
              </span>
              {r.submitted > 0 && (
                <span className="tcx-chip sky">{r.submitted} to approve</span>
              )}
              {r.rejected > 0 && <span className="tcx-chip bad">{r.rejected} rejected</span>}
              <ChevronRight size={16} className="muted" aria-hidden />
            </button>
          );
          if (!isSup) return <Fragment key={r.id}>{row}</Fragment>;
          return (
            <div key={r.id} className="tcx-row-pick">
              {/* 48px of tap target, its own label: a checkbox inside the row
                  button would be a control inside a control, and on a phone
                  the wrong one wins. */}
              <label className="tcx-check">
                <input
                  type="checkbox"
                  aria-label={t("crewclock.select.person", { name: r.name })}
                  checked={selected.includes(r.id)}
                  onChange={() => setSelected((s) => toggleCrewId(s, r.id))}
                />
              </label>
              {row}
            </div>
          );
        })}
        {roster.length === 0 && !crew.isLoading && (
          <p className="muted">
            {search ? "No members match your search." : "No active crew on the roster yet."}
          </p>
        )}
      </div>

      {/* Sticky, and deliberately ABOVE the by-job report: it needs page left
          below it to stay pinned to the bottom of the screen while a long
          roster scrolls (the same shape the schedule board's publish bar
          uses). */}
      {isSup && (
        <CrewClockBar
          members={crewMembers}
          selected={selected}
          projects={projects.data ?? []}
          onDone={() => {
            refresh();
            setSelected([]);
          }}
        />
      )}

      {/* The pay period's hours cut by job & cost code — the billing basis for
          service work (slice 3). Foreman+, same as this whole page. */}
      <TimeByJobReport />
    </div>
  );
}
