import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Plus, Send } from "lucide-react";
import { listProjects } from "../lib/api";
import { getMyProfile, listProfiles } from "../lib/install/api";
import { EmptyState, QueryError, SkeletonList } from "../components/ui/States";
import { WeekView } from "../components/schedule/WeekView";
import { CrewBoard, type ChipMove } from "../components/schedule/CrewBoard";
import { MonthView } from "../components/schedule/MonthView";
import { TimelineView } from "../components/schedule/TimelineView";
import { AssignmentEditor, type EditorResult } from "../components/schedule/AssignmentEditor";
import {
  addDaysISO,
  clashRangeLabel,
  monthGridRange,
  startOfMonthISO,
  startOfWeekISO,
} from "../lib/schedule/dates";
import {
  conflictBannerEntries,
  conflictingAssignmentIds,
  detectConflicts,
} from "../lib/schedule/conflicts";
import { unassignedProjects } from "../lib/schedule/grouping";
import {
  boardLanes,
  boardWeek,
  boardChips,
  copyWeekForward,
  coverageReport,
  dedupeProposals,
  outsideWindowEntries,
  repeatLastWorkedDay,
  type BoardChip,
  type SeedProposal,
} from "../lib/schedule/board";
import { isSupervisorPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { listTeamShifts } from "../lib/timeclock";
import {
  affectedByEdit,
  buildPublishDigests,
  digestMessage,
} from "../lib/schedule/notify";
import {
  createAssignment,
  deleteAssignment,
  horizonRange,
  listAssignments,
  listDraftAssignments,
  publishAssignments,
  updateAssignment,
} from "../lib/schedule/api";
import type { ScheduleAssignment } from "../lib/schedule/types";
import {
  linkVehicleToSchedule,
  listAllVehicleLinks,
  listVehicles,
  unlinkVehicleFromSchedule,
} from "../lib/vehicles/api";
import { vehicleTitle } from "../lib/vehicles/display";
import type { VehicleBooking } from "../lib/vehicles/scheduleConflicts";
import { isOutOfTown } from "../lib/travel/homeBase";
import type { NewTripInput } from "../lib/travel/types";
import { TripEditor } from "../components/travel/TripEditor";
import { sendPush } from "../lib/permissions/pushServer";
import { notifyLocal } from "../lib/permissions/notifyLocal";

type View = "board" | "week" | "month" | "timeline";

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function myScheduleUrl(): string {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  if (typeof window === "undefined") return "/my-schedule";
  return `${window.location.origin}${base}/my-schedule`;
}

interface EditorState {
  assignment: ScheduleAssignment | null;
  defaults?: { start_date?: string; project_id?: string };
  /** Crew ids to emphasize as the clash when opened from the conflict banner. */
  highlightMemberIds?: string[];
}

export function Scheduling() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const today = todayLocalISO();
  const horizon = useMemo(() => horizonRange(today), [today]);

  const [view, setView] = useState<View>("board");
  /** Quick-create target from an empty board cell. */
  const [quickCreate, setQuickCreate] = useState<{ personId: string; day: string } | null>(null);
  const [quickJob, setQuickJob] = useState("");
  /** One-level undo for the last board move/remove. */
  const [undoOp, setUndoOp] = useState<{ label: string; run: () => Promise<void> } | null>(null);
  const [seedProposals, setSeedProposals] = useState<SeedProposal[] | null>(null);
  const [seedChecked, setSeedChecked] = useState<Set<string>>(new Set());
  const [seedLabel, setSeedLabel] = useState("");
  const [anchor, setAnchor] = useState(today);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [travelDraft, setTravelDraft] = useState<NewTripInput | null>(null);

  const range = useMemo(() => {
    if (view === "week" || view === "board") {
      const from = startOfWeekISO(anchor);
      return { from, to: addDaysISO(from, 6), label: rangeLabel(from, addDaysISO(from, 6)) };
    }
    if (view === "month") {
      const grid = monthGridRange(startOfMonthISO(anchor));
      return { from: grid.from, to: grid.to, label: monthLabel(anchor) };
    }
    const from = startOfMonthISO(anchor);
    const to = addDaysISO(from, 183);
    return { from, to, label: rangeLabel(from, to) };
  }, [view, anchor]);

  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const crew = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const assignments = useQuery({
    queryKey: ["scheduleAssignments", range.from, range.to],
    queryFn: () => listAssignments(range.from, range.to),
  });
  const drafts = useQuery({
    queryKey: ["scheduleDrafts"],
    queryFn: listDraftAssignments,
  });
  const { effectiveRole } = useEffectiveRole();
  // Foremen can open the board and read the week; moving people stays a
  // supervisor call (owner decision, 2026-08-11).
  const canEdit = isSupervisorPlus(effectiveRole);
  // Coverage looks 21 days out regardless of the visible range.
  const coverageWindow = useQuery({
    queryKey: ["scheduleCoverage", today],
    queryFn: () => listAssignments(today, addDaysISO(today, 21)),
  });
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: listVehicles });
  const vehicleLinks = useQuery({ queryKey: ["vehicleLinks"], queryFn: listAllVehicleLinks });

  const loaded = useMemo(() => assignments.data ?? [], [assignments.data]);
  const conflictIds = useMemo(() => conflictingAssignmentIds(loaded), [loaded]);

  // ---- Crew board wiring ------------------------------------------------
  const weekDays = useMemo(() => boardWeek(anchor), [anchor]);
  const lanes = useMemo(() => boardLanes(crew.data ?? []), [crew.data]);
  const jobCodeById = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p.job_code])),
    [projects.data],
  );
  const profileById = useMemo(
    () => new Map((crew.data ?? []).map((p) => [p.id, p])),
    [crew.data],
  );
  const outsideWindow = useMemo(
    () => outsideWindowEntries(loaded, projects.data ?? []),
    [loaded, projects.data],
  );
  const coverage = useMemo(
    () =>
      coverageReport(
        (projects.data ?? []).filter((p) => p.status === "active"),
        coverageWindow.data ?? [],
        today,
      ),
    [projects.data, coverageWindow.data, today],
  );

  const roleOf = (personId: string): "foreman" | "installer" => {
    const p = profileById.get(personId);
    return p && isSupervisorPlus(p.role) ? "foreman" : p?.role === "foreman" ? "foreman" : "installer";
  };

  /** One-day draft for one person — the board's native unit. */
  const createDayDraft = (personId: string, day: string, projectId: string) =>
    createAssignment({
      project_id: projectId,
      start_date: day,
      end_date: day,
      members: [{ profile_id: personId, role: roleOf(personId) }],
    });

  const moveChip = useMutation({
    mutationFn: async ({ chip, toDay, toPersonId }: ChipMove) => {
      const a = loaded.find((x) => x.id === chip.assignmentId)
        ?? (drafts.data ?? []).find((x) => x.id === chip.assignmentId);
      if (!a || a.status !== "draft" || a.start_date !== a.end_date) {
        throw new Error("Only single-day drafts move on the board.");
      }
      if (a.members.length === 1) {
        await updateAssignment(a.id, {
          start_date: toDay,
          end_date: toDay,
          members: [{ profile_id: toPersonId, role: roleOf(toPersonId) }],
        });
        return {
          label: "Moved — undo",
          run: async () => {
            await updateAssignment(a.id, {
              start_date: chip.day,
              end_date: chip.day,
              members: a.members.map((m) => ({ profile_id: m.profile_id, role: m.role })),
            });
          },
        };
      }
      // Shared chip: peel this person off, give them their own day.
      await updateAssignment(a.id, {
        members: a.members
          .filter((m) => m.profile_id !== chip.personId)
          .map((m) => ({ profile_id: m.profile_id, role: m.role })),
      });
      const created = await createDayDraft(toPersonId, toDay, chip.projectId);
      return {
        label: "Moved — undo",
        run: async () => {
          await deleteAssignment(created.id);
          await updateAssignment(a.id, {
            members: a.members.map((m) => ({ profile_id: m.profile_id, role: m.role })),
          });
        },
      };
    },
    onSuccess: (undo) => {
      setUndoOp(undo);
      refresh();
    },
    onError: (e) => window.alert(String((e as Error).message ?? e)),
  });

  const removeChip = useMutation({
    mutationFn: async (chip: BoardChip) => {
      const a = loaded.find((x) => x.id === chip.assignmentId)
        ?? (drafts.data ?? []).find((x) => x.id === chip.assignmentId);
      if (!a || a.status !== "draft" || a.start_date !== a.end_date) {
        throw new Error("Only single-day drafts are removed from the board.");
      }
      if (a.members.length === 1) {
        await deleteAssignment(a.id);
        return {
          label: "Removed — undo",
          run: async () => {
            await createDayDraft(chip.personId, chip.day, chip.projectId);
          },
        };
      }
      await updateAssignment(a.id, {
        members: a.members
          .filter((m) => m.profile_id !== chip.personId)
          .map((m) => ({ profile_id: m.profile_id, role: m.role })),
      });
      return {
        label: "Removed — undo",
        run: async () => {
          await updateAssignment(a.id, {
            members: a.members.map((m) => ({ profile_id: m.profile_id, role: m.role })),
          });
        },
      };
    },
    onSuccess: (undo) => {
      setUndoOp(undo);
      refresh();
    },
    onError: (e) => window.alert(String((e as Error).message ?? e)),
  });

  const addSeeds = useMutation({
    mutationFn: async (proposals: SeedProposal[]) => {
      for (const pr of proposals) {
        await createDayDraft(pr.personId, pr.day, pr.projectId);
      }
      return proposals.length;
    },
    onSuccess: (n) => {
      setSeedProposals(null);
      setSeedChecked(new Set());
      refresh();
      void n;
    },
  });

  const runSeed = async (kind: "repeat" | "copy") => {
    const names = new Map([...profileById.values()].map((p) => [p.id, p.display_name]));
    let proposals: SeedProposal[];
    if (kind === "repeat") {
      // Everyone who actually clocked in on the most recent worked day,
      // proposed onto tomorrow. The checkboxes are the human's veto.
      const shifts = await listTeamShifts(addDaysISO(today, -14), today);
      proposals = repeatLastWorkedDay(
        shifts.map((sh) => ({
          profile_id: sh.profile_id,
          project_id: sh.project_id,
          clock_in_at: sh.clock_in_at,
        })),
        names,
        jobCodeById,
        addDaysISO(today, 1),
      );
      setSeedLabel("Repeat the last worked day onto tomorrow");
    } else {
      proposals = copyWeekForward(boardChips(loaded, weekDays), names, jobCodeById);
      setSeedLabel("Copy this week's plan onto next week");
    }
    const { fresh, skipped } = dedupeProposals(proposals, [
      ...loaded,
      ...(coverageWindow.data ?? []),
    ]);
    setSeedProposals(fresh);
    setSeedChecked(new Set(fresh.map((pr) => `${pr.personId}|${pr.projectId}|${pr.day}`)));
    if (skipped > 0 && fresh.length === 0) {
      setSeedLabel(`Everything from that seed is already on the board (${skipped} skipped)`);
    }
  };

  const vehicleByAssignment = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of vehicleLinks.data ?? []) {
      if (l.assignment_id) map.set(l.assignment_id, l.vehicle_id);
    }
    return map;
  }, [vehicleLinks.data]);

  const vehicleBookings = useMemo<VehicleBooking[]>(
    () =>
      (vehicleLinks.data ?? []).map((l) => ({
        vehicle_id: l.vehicle_id,
        assignment_id: l.assignment_id,
        start_date: l.start_date,
        end_date: l.end_date,
      })),
    [vehicleLinks.data],
  );

  const vehicleLabelByAssignment = useMemo(() => {
    const byId = new Map((vehicles.data ?? []).map((v) => [v.id, v]));
    const map = new Map<string, string>();
    for (const l of vehicleLinks.data ?? []) {
      if (!l.assignment_id) continue;
      const v = byId.get(l.vehicle_id);
      map.set(l.assignment_id, v ? vehicleTitle(v) : "Vehicle");
    }
    return map;
  }, [vehicleLinks.data, vehicles.data]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["scheduleAssignments"] });
    qc.invalidateQueries({ queryKey: ["scheduleDrafts"] });
    qc.invalidateQueries({ queryKey: ["vehicleLinks"] });
  };

  async function syncVehicleLink(result: EditorResult, assignmentId: string) {
    if (result.vehicle_id) {
      await linkVehicleToSchedule({
        vehicleId: result.vehicle_id,
        projectId: result.project_id,
        assignmentId,
        startDate: result.start_date,
        endDate: result.end_date,
      });
    } else {
      await unlinkVehicleFromSchedule(assignmentId);
    }
  }

  const save = useMutation({
    mutationFn: async (result: EditorResult) => {
      const existing = editor?.assignment ?? null;
      if (!existing) {
        const created = await createAssignment(result);
        await syncVehicleLink(result, created.id);
        return;
      }
      const beforeMembers = existing.members.map((m) => m.profile_id);
      const afterMembers = result.members.map((m) => m.profile_id);
      const scheduleChanged =
        existing.start_date !== result.start_date ||
        existing.end_date !== result.end_date ||
        (existing.start_time ?? null) !== result.start_time;
      await updateAssignment(existing.id, result);
      await syncVehicleLink(result, existing.id);
      // Re-notify only affected people when editing an already-published block.
      if (existing.status === "published") {
        const affected = affectedByEdit({
          membersBefore: beforeMembers,
          membersAfter: afterMembers,
          scheduleChanged,
        });
        await fanOut(affected, {
          title: "Schedule updated",
          body: "One of your jobs changed. Tap to check your schedule.",
        });
      }
    },
    onSuccess: () => {
      setEditor(null);
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: async () => {
      const existing = editor?.assignment;
      if (!existing) return;
      const affected =
        existing.status === "published"
          ? existing.members.map((m) => m.profile_id)
          : [];
      await deleteAssignment(existing.id);
      if (affected.length > 0) {
        await fanOut(affected, {
          title: "Schedule updated",
          body: "A job was removed from your schedule. Tap to check.",
        });
      }
    },
    onSuccess: () => {
      setEditor(null);
      refresh();
    },
  });

  async function fanOut(
    profileIds: string[],
    msg: { title: string; body: string },
  ) {
    for (const pid of profileIds) {
      void sendPush({
        profileIds: [pid],
        title: msg.title,
        body: msg.body,
        tag: `schedule-${pid}`,
        url: myScheduleUrl(),
      });
    }
    if (me.data?.id && profileIds.includes(me.data.id)) {
      void notifyLocal({ title: msg.title, body: msg.body, tag: `schedule-${me.data.id}`, url: myScheduleUrl() });
    }
  }

  async function doPublish() {
    const draftList = drafts.data ?? [];
    if (draftList.length === 0) return;
    setPublishing(true);
    try {
      await publishAssignments(draftList.map((a) => a.id));
      const digests = buildPublishDigests(
        draftList.map((a) => ({
          id: a.id,
          status: a.status,
          members: a.members.map((m) => ({ profile_id: m.profile_id })),
        })),
      );
      for (const d of digests) {
        const msg = digestMessage(d.assignmentIds.length);
        void sendPush({
          profileIds: [d.profileId],
          title: msg.title,
          body: msg.body,
          tag: `schedule-${d.profileId}`,
          url: myScheduleUrl(),
        });
      }
      refresh();
      setPublishOpen(false);
    } finally {
      setPublishing(false);
    }
  }

  const draftList = useMemo(() => drafts.data ?? [], [drafts.data]);

  // Everything currently in play (loaded window + all drafts), deduped. Drives
  // the conflict banner, the red outlines and the pre-publish summary alike.
  const knownById = useMemo(() => {
    const byId = new Map<string, ScheduleAssignment>();
    for (const a of [...loaded, ...draftList]) byId.set(a.id, a);
    return byId;
  }, [loaded, draftList]);

  const conflictInput = useMemo(
    () =>
      [...knownById.values()].map((a) => ({
        id: a.id,
        start_date: a.start_date,
        end_date: a.end_date,
        members: a.members.map((m) => ({ profile_id: m.profile_id })),
      })),
    [knownById],
  );

  const publishConflicts = useMemo(
    () => detectConflicts(conflictInput),
    [conflictInput],
  );

  const nameOf = (id: string) =>
    crew.data?.find((p) => p.id === id)?.display_name ?? "Crew";

  const jobLabelOf = (assignmentId: string) => {
    const a = knownById.get(assignmentId);
    return a?.project?.job_code ?? a?.project?.name ?? "a job";
  };

  const bannerConflicts = useMemo(
    () => conflictBannerEntries(conflictInput),
    [conflictInput],
  );

  function fixConflict(entry: { aId: string; bId: string; profileId: string }) {
    const a = knownById.get(entry.aId);
    const b = knownById.get(entry.bId);
    // Prefer the later-starting (then more-recently-edited) assignment to edit.
    const pick =
      !a ? b : !b ? a : a.start_date !== b.start_date
          ? a.start_date > b.start_date ? a : b
          : (a.updated_at ?? "") >= (b.updated_at ?? "") ? a : b;
    if (!pick) return;
    setEditor({ assignment: pick, highlightMemberIds: [entry.profileId] });
  }

  const tray = useMemo(() => {
    if (!projects.data) return [];
    const known = [...loaded, ...draftList];
    return unassignedProjects(
      projects.data.map((p) => ({ id: p.id, job_code: p.job_code, name: p.name })),
      known,
      today,
    ).slice(0, 8);
  }, [projects.data, loaded, draftList, today]);

  function step(dir: -1 | 1) {
    if (view === "month" || view === "timeline") {
      setAnchor((a) => addDaysISO(startOfMonthISO(a), dir > 0 ? 32 : -1));
    } else {
      setAnchor((a) => addDaysISO(a, dir * 7));
    }
  }

  const projectById = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p])),
    [projects.data],
  );

  function openTravelDraft(a: ScheduleAssignment) {
    const project = projectById.get(a.project_id) ?? null;
    const label = project?.name || project?.job_code || a.project?.name || "Job";
    setEditor(null);
    setTravelDraft({
      name: `${label} travel`,
      destination: project?.address ?? a.project?.address ?? null,
      start_date: a.start_date,
      end_date: a.end_date,
      project_id: a.project_id,
      crew: a.members.map((m) => ({
        profile_id: m.profile_id,
        role: m.role,
        display_name: m.display_name ?? null,
      })),
    });
  }

  const editingAssignment = editor?.assignment ?? null;
  const canPlanTravel =
    editingAssignment != null &&
    editingAssignment.status === "published" &&
    isOutOfTown(projectById.get(editingAssignment.project_id)?.site_state);

  return (
    <div className="page sched-page">
      <header className="page-header">
        <div>
          <h1>Scheduling</h1>
          <p className="muted" style={{ margin: 0 }}>
            Assign crews to jobs, then publish to the field.
          </p>
        </div>
        <Link to="/" className="back-chip" aria-label="Home" />
      </header>

      {bannerConflicts.length > 0 && (
        <div className="sched-conflict-banner" role="alert">
          <div className="sched-conflict-banner-head">
            <AlertTriangle size={16} aria-hidden />
            <strong>
              {bannerConflicts.length} double-booking
              {bannerConflicts.length === 1 ? "" : "s"} to sort out
            </strong>
          </div>
          <ul className="sched-conflict-banner-list">
            {bannerConflicts.map((c) => (
              <li key={`${c.profileId}-${c.aId}-${c.bId}`} className="sched-conflict-banner-row">
                <span className="sched-conflict-banner-text">
                  <strong>{nameOf(c.profileId)}</strong> — {jobLabelOf(c.aId)} &amp;{" "}
                  {jobLabelOf(c.bId)}, {clashRangeLabel(c.overlap.start, c.overlap.end)}
                </span>
                <button
                  className="button-like sched-conflict-banner-fix"
                  onClick={() => fixConflict(c)}
                >
                  Fix
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Coverage: the nag BEFORE a job starts uncovered. */}
      {coverage.upcoming.length > 0 && (
        <div
          className={
            coverage.uncovered.length > 0 ? "cov-strip warn" : "cov-strip ok"
          }
          role={coverage.imminent.length > 0 ? "alert" : undefined}
        >
          {coverage.uncovered.length === 0 ? (
            <span>
              ✓ All {coverage.upcoming.length} job
              {coverage.upcoming.length === 1 ? "" : "s"} starting in the next 21
              days have crew scheduled.
            </span>
          ) : (
            <>
              <strong>
                {coverage.uncovered.length} of {coverage.upcoming.length} jobs
                starting in the next 21 days {coverage.uncovered.length === 1 ? "has" : "have"}{" "}
                nobody scheduled
              </strong>
              <ul className="cov-list">
                {coverage.uncovered.map((j) => (
                  <li key={j.id} className={coverage.imminent.some((x) => x.id === j.id) ? "imminent" : ""}>
                    {j.job_code} — starts {j.start_date}
                    {canEdit && (
                      <button
                        className="button-like cov-fix"
                        onClick={() =>
                          setEditor({
                            assignment: null,
                            defaults: { project_id: j.id, start_date: j.start_date },
                          })
                        }
                      >
                        Schedule crew
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {outsideWindow.length > 0 && (
        <p className="warn-text" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
          Outside the job's target dates (fine, but worth a look):{" "}
          {outsideWindow.slice(0, 4).map((e) => `${e.jobCode} ${e.detail}`).join(" · ")}
          {outsideWindow.length > 4 ? ` · +${outsideWindow.length - 4} more` : ""}
        </p>
      )}

      <div className="sched-toolbar">
        <div className="sched-viewswitch" role="tablist">
          {(["board", "week", "month", "timeline"] as View[]).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              className={`sched-viewtab${view === v ? " is-active" : ""}`}
              onClick={() => setView(v)}
            >
              {v === "board" ? "Board" : v === "week" ? "Week" : v === "month" ? "Month" : "Calendar"}
            </button>
          ))}
        </div>
        <button
          className="button-like active-pill sched-new"
          onClick={() => setEditor({ assignment: null, defaults: { start_date: anchor } })}
        >
          <Plus size={16} aria-hidden /> New
        </button>
      </div>

      <div className="sched-navrow">
        <button className="button-like" onClick={() => step(-1)} aria-label="Previous">
          <ChevronLeft size={18} />
        </button>
        <button className="button-like" style={{ flex: 1 }} onClick={() => setAnchor(today)}>
          {range.label}
        </button>
        <button className="button-like" onClick={() => step(1)} aria-label="Next">
          <ChevronRight size={18} />
        </button>
      </div>

      {tray.length > 0 && (
        <div className="sched-tray">
          <span className="sched-tray-label">Unassigned</span>
          <div className="sched-tray-chips">
            {tray.map((p) => (
              <button
                key={p.id}
                className="sched-tray-chip"
                onClick={() =>
                  setEditor({ assignment: null, defaults: { project_id: p.id, start_date: anchor } })
                }
              >
                <CalendarDays size={13} aria-hidden /> {p.job_code}
              </button>
            ))}
          </div>
        </div>
      )}

      {assignments.isError && (
        <QueryError
          error={assignments.error}
          onRetry={() => void assignments.refetch()}
          label="Couldn't load the schedule"
        />
      )}
      {assignments.isLoading ? (
        <SkeletonList rows={4} />
      ) : loaded.length === 0 && view !== "timeline" && view !== "board" ? (
        <EmptyState
          icon={<CalendarDays size={22} />}
          title="Nothing scheduled here yet"
          message="Tap a day or “New” to put a crew on a job."
        />
      ) : view === "board" ? (
        <>
          {canEdit && (
            <div className="cb-seedrow">
              <button className="button-like" onClick={() => void runSeed("repeat")}>
                Repeat yesterday's crew
              </button>
              <button className="button-like" onClick={() => void runSeed("copy")}>
                Copy week forward
              </button>
              {undoOp && (
                <button
                  className="button-like active-pill"
                  onClick={() => {
                    void undoOp.run().then(() => refresh());
                    setUndoOp(null);
                  }}
                >
                  {undoOp.label}
                </button>
              )}
            </div>
          )}
          <CrewBoard
            weekDays={weekDays}
            lanes={lanes}
            assignments={loaded}
            jobCodeById={jobCodeById}
            profileById={profileById}
            conflictIds={conflictIds}
            canEdit={canEdit}
            onMoveChip={(m) => moveChip.mutate(m)}
            onRemoveChip={(c) => removeChip.mutate(c)}
            onCreateAt={(personId, day) => {
              setQuickJob("");
              setQuickCreate({ personId, day });
            }}
            onOpenAssignment={(id) => {
              const a = loaded.find((x) => x.id === id);
              if (a && canEdit) setEditor({ assignment: a });
            }}
          />
        </>
      ) : view === "week" ? (
        <WeekView
          weekStart={range.from}
          todayISO={today}
          assignments={loaded}
          conflictIds={conflictIds}
          vehicleLabels={vehicleLabelByAssignment}
          onOpen={(a) => setEditor({ assignment: a })}
          onCreate={(day) => setEditor({ assignment: null, defaults: { start_date: day } })}
        />
      ) : view === "month" ? (
        <MonthView
          monthAnchor={anchor}
          todayISO={today}
          assignments={loaded}
          conflictIds={conflictIds}
          onOpen={(a) => setEditor({ assignment: a })}
          onCreate={(day) => setEditor({ assignment: null, defaults: { start_date: day } })}
        />
      ) : (
        <TimelineView
          from={range.from}
          to={range.to}
          todayISO={today}
          assignments={loaded}
          conflictIds={conflictIds}
          onOpen={(a) => setEditor({ assignment: a })}
        />
      )}

      {draftList.length > 0 && (
        <div className="sched-publishbar">
          <div>
            <strong>
              {draftList.length} unpublished change{draftList.length === 1 ? "" : "s"}
            </strong>
            {publishConflicts.length > 0 && (
              <span className="sched-publishbar-warn">
                · {publishConflicts.length} double-booked
              </span>
            )}
          </div>
          <button className="button-like active-pill" onClick={() => setPublishOpen(true)}>
            <Send size={15} aria-hidden /> Review &amp; Publish
          </button>
        </div>
      )}

      {quickCreate && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setQuickCreate(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: 0, fontWeight: 700 }}>
              {profileById.get(quickCreate.personId)?.display_name ?? "Crew"} · {quickCreate.day}
            </p>
            <label className="field-label">Job</label>
            <select value={quickJob} onChange={(e) => setQuickJob(e.target.value)}>
              <option value="">— pick a job —</option>
              {(projects.data ?? [])
                .filter((pr) => pr.status === "active")
                .map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.job_code} — {pr.name}
                  </option>
                ))}
            </select>
            <div className="row-gap" style={{ marginTop: 10 }}>
              <button
                className="button-like active-pill"
                disabled={!quickJob}
                onClick={() => {
                  void createDayDraft(quickCreate.personId, quickCreate.day, quickJob).then(() => {
                    refresh();
                  });
                  setQuickCreate(null);
                }}
              >
                Add to draft
              </button>
              <button className="button-like" onClick={() => setQuickCreate(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {seedProposals && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setSeedProposals(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: 0, fontWeight: 700 }}>{seedLabel}</p>
            <p className="muted" style={{ margin: "2px 0 8px", fontSize: 12.5 }}>
              A proposal, not a commit — untick anything that's wrong, then add
              the rest as drafts.
            </p>
            {seedProposals.length === 0 ? (
              <p className="muted">Nothing new to add.</p>
            ) : (
              <ul className="seed-list">
                {seedProposals.map((pr) => {
                  const k = `${pr.personId}|${pr.projectId}|${pr.day}`;
                  return (
                    <li key={k}>
                      <label>
                        <input
                          type="checkbox"
                          checked={seedChecked.has(k)}
                          onChange={(e) => {
                            setSeedChecked((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(k);
                              else next.delete(k);
                              return next;
                            });
                          }}
                        />
                        {pr.personName} — {pr.jobCode} · {pr.day}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="row-gap" style={{ marginTop: 10 }}>
              <button
                className="button-like active-pill"
                disabled={addSeeds.isPending || seedChecked.size === 0}
                onClick={() =>
                  addSeeds.mutate(
                    seedProposals.filter((pr) =>
                      seedChecked.has(`${pr.personId}|${pr.projectId}|${pr.day}`),
                    ),
                  )
                }
              >
                {addSeeds.isPending
                  ? "Adding…"
                  : `Add ${seedChecked.size} to draft`}
              </button>
              <button className="button-like" onClick={() => setSeedProposals(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {editor && (
        <AssignmentEditor
          assignment={editor.assignment}
          defaults={editor.defaults}
          projects={projects.data ?? []}
          crew={crew.data ?? []}
          others={loaded}
          highlightMemberIds={editor.highlightMemberIds}
          horizon={horizon}
          vehicles={vehicles.data ?? []}
          currentVehicleId={
            editor.assignment ? (vehicleByAssignment.get(editor.assignment.id) ?? null) : null
          }
          vehicleBookings={vehicleBookings}
          onPlanTravel={
            canPlanTravel && editingAssignment
              ? () => openTravelDraft(editingAssignment)
              : undefined
          }
          saving={save.isPending || remove.isPending}
          onSave={(result) => save.mutate(result)}
          onDelete={editor.assignment ? () => remove.mutate() : undefined}
          onClose={() => setEditor(null)}
        />
      )}

      {travelDraft && (
        <TripEditor
          trip={null}
          defaults={travelDraft}
          onClose={() => setTravelDraft(null)}
          onSaved={(saved) => {
            setTravelDraft(null);
            navigate(`/travel/${saved.id}`);
          }}
          onDeleted={() => setTravelDraft(null)}
        />
      )}

      {publishOpen && (
        <div className="sched-sheet-backdrop" role="dialog" aria-modal="true">
          <div className="sched-sheet">
            <div className="sched-sheet-head">
              <h2 style={{ margin: 0 }}>Review &amp; publish</h2>
            </div>
            <p className="muted">
              Publishing sends {draftList.length} assignment
              {draftList.length === 1 ? "" : "s"} to the field and notifies each crew member once.
            </p>
            {publishConflicts.length > 0 ? (
              <div className="sched-conflict-inline" role="alert" style={{ marginBottom: 10 }}>
                <div>
                  <strong>Heads-up: {publishConflicts.length} double-booked</strong>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                    {publishConflicts.map((c) => (
                      <li key={c.profileId}>
                        {nameOf(c.profileId)} — {c.assignmentIds.length} overlapping jobs
                      </li>
                    ))}
                  </ul>
                  <span className="muted" style={{ fontSize: 12 }}>
                    You can still publish; this is just a warning.
                  </span>
                </div>
              </div>
            ) : (
              <p className="ok" style={{ fontSize: 13 }}>No conflicts detected.</p>
            )}
            <div className="sched-sheet-actions">
              <button className="button-like" onClick={() => setPublishOpen(false)} disabled={publishing}>
                Cancel
              </button>
              <button
                className="button-like active-pill"
                style={{ marginLeft: "auto" }}
                onClick={() => void doPublish()}
                disabled={publishing}
              >
                {publishing ? "Publishing…" : `Publish ${draftList.length}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function rangeLabel(from: string, to: string): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  const f = new Date(`${from}T00:00:00Z`).toLocaleDateString(undefined, opts);
  const t = new Date(`${to}T00:00:00Z`).toLocaleDateString(undefined, opts);
  return `${f} – ${t}`;
}

function monthLabel(iso: string): string {
  return new Date(`${startOfMonthISO(iso)}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
