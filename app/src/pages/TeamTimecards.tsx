// Team timecards (foreman+): the live roster — pulsing dot and running
// timer for whoever is on the clock, week hours and approval chips on every
// row — and tap a person to open the shared TimecardPanel with full edit.
// Split out of /timecard (owner ask, 2026-08-11): My timecard is personal,
// this tab is the whole crew. The runaway-shift guard lives here because a
// forgotten clock-out is the office's problem, not one person's.

import { BackChip } from "../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { listProjects } from "../lib/api";
import { formatApiError } from "../lib/errors";
import { lastSeenAwayFromJob } from "../lib/farFromJob";
import { useT } from "../lib/i18n";
import { SkeletonList } from "../components/ui/States";
import { listProfiles } from "../lib/install/api";
import { isForemanPlus, isSupervisorPlus, visibleRole } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import {
  closeShiftAsNoWork,
  elapsedWorkSeconds,
  listCostCodes,
  listTeamShifts,
  listUnfinishedShifts,
  shiftsToExportRows,
  summarizeTeamWeek,
  weekRange,
} from "../lib/timeclock";
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

  const week = useMemo(() => weekRange(new Date()), []);
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
  const roster = useMemo(() => {
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
    const q = search.trim().toLowerCase();
    return q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
  }, [crew.data, weekSummary, liveShifts, search]);

  const clockedCount = roster.filter((r) => r.open).length;
  // `sum`, not `t` — `t` is the translator on this component now.
  const pendingCount = weekSummary.reduce((sum, r) => sum + r.submittedCount, 0);

  // ---- Team-wide export (the roster's "Export all") ----
  // T7: shiftsToExportRows (lib/timeclock.ts) is the one shared mapping —
  // see its comment for why it lives there instead of timecardExport.ts.
  const teamPayload = () => ({
    periodLabel: week.label,
    shifts: shiftsToExportRows(teamShifts.data ?? []),
    overtime: [],
  });

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

      {suspects.length > 0 && (
        <section className="detail-card" style={{ marginTop: 12 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>
            Suspect punches this week ({suspects.length})
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

      {(crew.isLoading || teamShifts.isLoading) && <SkeletonList rows={4} />}
      <div className="tcx-roster">
        {roster.map((r) => {
          const live = r.open;
          return (
            <button
              key={r.id}
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
                      {` · ${r.hours.toFixed(1)}h wk`}
                    </>
                  ) : (
                    `Off clock · ${r.hours.toFixed(1)}h wk`
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
        })}
        {roster.length === 0 && !crew.isLoading && (
          <p className="muted">
            {search ? "No members match your search." : "No active crew on the roster yet."}
          </p>
        )}
      </div>

      {/* The pay period's hours cut by job & cost code — the billing basis for
          service work (slice 3). Foreman+, same as this whole page. */}
      <TimeByJobReport />
    </div>
  );
}
