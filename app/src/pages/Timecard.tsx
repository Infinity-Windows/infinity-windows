// Timecard, Horizon style (owner call, 2026-08-11): leads land on a live
// searchable roster — pulsing dot and running timer for whoever is on the
// clock, week hours and approval chips on every row — and tap a person to
// open the shared TimecardPanel. Installers land straight on their own
// panel. Approvals stay per punch; the runaway-shift guard keeps its own
// section above the roster because a forgotten clock-out is the office's
// problem, not one person's.

import { BackChip } from "../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { listProjects } from "../lib/api";
import { formatApiError } from "../lib/errors";
import { SkeletonList } from "../components/ui/States";
import { getMyProfile, listProfiles } from "../lib/install/api";
import { isForemanPlus, isSupervisorPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import {
  closeShiftAsNoWork,
  elapsedWorkSeconds,
  getOpenShift,
  listCostCodes,
  listTeamShifts,
  listUnfinishedShifts,
  punchDay,
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
import {
  describeDuration,
  flaggedShifts,
  needsFinishTime,
  shiftGuard,
} from "../lib/shiftGuard";
import { TimecardPanel } from "../components/timecard/TimecardPanel";
import { ShiftEditor } from "../components/timecard/ShiftEditor";
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

export function Timecard() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
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
  const myOpen = useQuery({
    queryKey: ["openShift", me.data?.id],
    queryFn: () => getOpenShift(me.data!.id),
    enabled: !isLead && Boolean(me.data?.id),
    refetchInterval: 60_000,
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
  const pendingCount = weekSummary.reduce((t, r) => t + r.submittedCount, 0);

  // ---- Team-wide export (the roster's "Export all") ----
  function exportShifts(source: TimeShift[]): TimecardExportShift[] {
    return source.map((s) => ({
      employee: s.profiles?.display_name ?? "Crew",
      day: punchDay(s.clock_in_at),
      start: fmtTime(s.clock_in_at),
      end: s.clock_out_at ? fmtTime(s.clock_out_at) : "",
      hours: shiftHours(s),
      job: s.projects?.job_code ?? "—",
      costCode: s.cost_codes ? `${s.cost_codes.code} - ${s.cost_codes.label}` : "-",
      status: s.status,
    }));
  }
  const teamPayload = () => ({
    periodLabel: week.label,
    shifts: exportShifts(teamShifts.data ?? []),
    overtime: [],
  });

  const selectedName =
    roster.find((r) => r.id === selectedId)?.name ??
    crew.data?.find((c) => c.id === selectedId)?.display_name ??
    "Crew member";
  const selectedOpen =
    liveShifts.find((s) => s.profile_id === selectedId) ?? null;

  // ---- Installer: straight to their own panel ----
  if (!isLead) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <h1>Timecard</h1>
            <p className="muted" style={{ margin: 0 }}>Your hours</p>
          </div>
          <BackChip fallback="/" label="Home" />
        </header>
        {me.data?.id && (
          <TimecardPanel
            personId={me.data.id}
            personName={me.data.display_name}
            isLead={false}
            isSup={false}
            canEdit={false}
            projects={projects.data ?? []}
            costCodes={costCodes.data ?? []}
            openShift={myOpen.data ?? null}
          />
        )}
      </div>
    );
  }

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
                  <span className="tcx-role">{r.role}</span>
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
    </div>
  );
}
