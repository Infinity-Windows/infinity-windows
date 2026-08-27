import { BackChip } from "../components/BackChip";
import { PlanPackagesPanel } from "../components/warehouse/PlanPackagesPanel";
import { JobPackagesPanel } from "../components/warehouse/JobPackagesPanel";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { DirectionsButton } from "../components/maps/DirectionsButton";
import {
  deleteTestProject,
  ensureStagingBays,
  getProjectWindows,
  listLocations,
  listReorderNeeds,
  setProjectTest,
  updateProject,
  listProjectsAnyStatus,
  setProjectStatus,
} from "../lib/api";
import { totalReorder } from "../lib/loadout";
import { missingStagingSlots, stagingBaysFor } from "../lib/staging";
import { pushToast, toastError } from "../lib/toast";
import { listOpenings, saveJobEstimate } from "../lib/install/api";
import {
  compareIssues,
  KIND_LABELS,
  listProjectIssues,
  resolveIssue,
  URGENCY_MARK,
  type Issue,
  type IssueKind,
} from "../lib/issues";
import {
  estimateJob,
  formatHours,
  recommendCrew,
  type CrewRecommendation,
  type JobEstimate,
  type TypeStat,
} from "../lib/estimate";
import { prefetchJobPack } from "../lib/queryClient";
import { useRealtimeOpenings } from "../lib/useRealtimeOpenings";
import { type Project } from "../lib/types";
import { listActivePackages, type StoragePackage } from "../lib/storage";
import { normalizeMarkCode } from "../lib/fitview/adapter";
import { unitParts } from "../lib/warehouse/unitParts";
import { isForemanPlus, isOwner, isSupervisorPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { listProjectAssignments } from "../lib/schedule/api";
import { listVehicleLinksForProject } from "../lib/vehicles/api";
import { vehicleTitle } from "../lib/vehicles/display";
import { listTrips } from "../lib/travel/api";
import { listRoster } from "../lib/chat/api";
import { mergeJobPeople } from "../lib/whoOnJob";
import { CalendarClock, Plane, Truck, Users } from "lucide-react";
import { MapsInteractive } from "./install/MapsInteractive";
import { DispatchBoard } from "./install/DispatchBoard";
import { SignatureEstimates } from "../components/install/SignatureEstimates";
import { ScrollTabs } from "../components/nav/ScrollTabs";
import { PhotoFeed } from "../components/photos/PhotoFeed";
import { JobChat } from "../components/chat/JobChat";
import { DailyLogsTab } from "../components/dailyLogs/DailyLogsTab";
import { useUnreadCounts } from "../lib/chat/useUnreadCounts";
import { formatApiError } from "../lib/errors";



type HubTab =
  | "overview"
  | "warehouse"
  | "map"
  | "model-studio"
  | "maps-interactive"
  | "brain"
  | "dispatch"
  | "exceptions"
  | "photos"
  | "chat"
  | "logs";

export function ProjectDetail() {
  const { projectId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  // Read before the tab is resolved: which tabs a URL may open depends on it.
  const { effectiveRole } = useEffectiveRole();
  const isLead = isForemanPlus(effectiveRole);
  const tabParam = searchParams.get("tab");
  const tab: HubTab =
    tabParam === "warehouse" ||
    tabParam === "map" ||
    tabParam === "model-studio" ||
    tabParam === "maps-interactive" ||
    tabParam === "brain" ||
    // Lead-only tabs, and ONLY when the viewer is one. The tab BUTTONS are
    // already hidden from non-leads, but a shared or bookmarked link went
    // straight through — the tab opened and its lead-gated content rendered
    // nothing, so the page was a header and empty space with no message.
    (isLead && (tabParam === "dispatch" || tabParam === "exceptions" || tabParam === "logs")) ||
    tabParam === "photos" ||
    tabParam === "chat"
      ? tabParam
      : "overview";

  // Legacy deep links (?tab=map) land on the merged tab's Sheets view — the
  // 8 places that link to the 2D map keep working without edits. The Studio
  // left the job tabs entirely (?tab=model-studio → its own home).
  const navigate = useNavigate();
  useEffect(() => {
    if (tabParam === "map") {
      setSearchParams({ tab: "maps-interactive", mapview: "sheets" }, { replace: true });
    }
    if (tabParam === "model-studio") {
      navigate(`/studio/j/${projectId}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabParam]);

  useRealtimeOpenings(projectId);
  const unread = useUnreadCounts();
  const chatUnread = unread.data?.[projectId] ?? 0;

  const TABS: { id: HubTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    ...(isLead ? [{ id: "dispatch" as HubTab, label: "Dispatch" }] : []),
    ...(isLead ? [{ id: "logs" as HubTab, label: "Logs" }] : []),
    { id: "warehouse", label: "Warehouse" },
    { id: "chat", label: "Chat" },
    { id: "photos", label: "Photos" },
    // "Map" and "Maps Interactive" merged 2026-08-13 (owner call): one tab,
    // 3D + Sheets views inside. ?tab=map deep links redirect below.
    // The Studio stood up as its own top-level tab the same day — the old
    // ?tab=model-studio deep links redirect to /studio/j/<id> below.
    { id: "maps-interactive", label: "Maps Interactive" },
    ...(isLead ? [{ id: "exceptions" as HubTab, label: "Exceptions" }] : []),
    { id: "brain", label: "Brain" },
  ];

  const setTab = (next: HubTab) => {
    if (next === "overview") {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ tab: next }, { replace: true });
    }
  };

  // Any-status on purpose (owner ask, 2026-08-26): job history links here,
  // and a finished job's page must keep opening with everything it tracked.
  const projects = useQuery({ queryKey: ["projectsAll"], queryFn: listProjectsAnyStatus });
  const project = projects.data?.find((p) => p.id === projectId);

  const needs = useQuery({
    queryKey: ["projectWindows", projectId],
    queryFn: () => getProjectWindows(projectId),
  });
  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
  });
  // The job's material, in the package chain's own terms (ticket 21). Same
  // query key every warehouse screen uses, so it is a cache hit on a phone
  // that has been anywhere near the warehouse today.
  const jobPackages = useQuery({
    queryKey: ["storagePackages"],
    queryFn: listActivePackages,
  });
  const minePkgs = useMemo(
    () => (jobPackages.data ?? []).filter((p) => p.project_id === projectId),
    [jobPackages.data, projectId],
  );
  const heldCount = minePkgs.filter(
    (p) => p.status === "received" || p.status === "stored",
  ).length;
  const outCount = minePkgs.filter((p) => p.status === "checked_out").length;
  const brainTypes = useMemo(() => {
    const map = new Map<
      string,
      { id: string; type_code: string; name: string; count: number }
    >();
    for (const o of openings.data ?? []) {
      if (!o.window_types) continue;
      const existing = map.get(o.window_types.id);
      if (existing) existing.count += 1;
      else {
        map.set(o.window_types.id, {
          id: o.window_types.id,
          type_code: o.window_types.type_code,
          name: o.window_types.name,
          count: 1,
        });
      }
    }
    for (const n of needs.data ?? []) {
      if (!n.window_types || map.has(n.window_types.id)) continue;
      map.set(n.window_types.id, {
        id: n.window_types.id,
        type_code: n.window_types.type_code,
        name: n.window_types.name,
        count: n.quantity,
      });
    }
    return [...map.values()].sort((a, b) => a.type_code.localeCompare(b.type_code));
  }, [openings.data, needs.data]);

  const openingsList = openings.data ?? [];
  const openingsInstalled = openingsList.filter((o) => o.status === "installed").length;
  const neededTotal = (needs.data ?? []).reduce((sum, n) => sum + n.quantity, 0);

  const jobEstimate = useMemo(() => {
    const list = openings.data ?? [];
    if (list.length === 0) return null;
    const typeStats: TypeStat[] = [];
    const seen = new Set<string>();
    for (const o of list) {
      const t = o.window_types;
      if (t && !seen.has(t.id)) {
        seen.add(t.id);
        typeStats.push({
          window_type_id: t.id,
          median_minutes: t.median_minutes ?? null,
          p90_minutes: t.p90_minutes ?? null,
          difficulty: t.learned_difficulty ?? t.difficulty_rating ?? null,
        });
      }
    }
    const est = estimateJob(
      list.map((o) => ({
        window_type_id: o.window_type_id,
        installed: o.status === "installed",
      })),
      typeStats,
    );
    return { est, crew: recommendCrew(est) };
  }, [openings.data]);

  return (
    <div className="page">
      <header className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <BackChip fallback="/projects" label="Back to jobs" />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: 26 }}>{project?.job_code ?? "Job"}</h1>
            <p className="wh-row-sub" style={{ margin: 0 }}>
              {project?.name}
              {project?.address ? ` — ${project.address}` : ""}
            </p>
          </div>
        </div>
        <DirectionsButton address={project?.address} />
      </header>

      <ScrollTabs className="hub-tabs" label="Project sections" activeId={tab}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? "hub-tab active" : "hub-tab"}
            data-tab-active={tab === t.id}
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "chat" && chatUnread > 0 && (
              <span className="chat-badge hub-tab-badge">{chatUnread}</span>
            )}
          </button>
        ))}
      </ScrollTabs>

      {tab === "overview" && (
        <OverviewTab
          projectId={projectId}
          neededTotal={neededTotal}
          heldCount={heldCount}
          outCount={outCount}
          openingsTotal={openingsList.length}
          openingsInstalled={openingsInstalled}
          needs={needs.data ?? []}
          packages={minePkgs}
          openings={openingsList}
          estimate={jobEstimate}
          isLead={isLead}
          canStudio={isSupervisorPlus(effectiveRole)}
          canFlagTesting={isSupervisorPlus(effectiveRole)}
          canDeleteTesting={isOwner(effectiveRole)}
          project={project}
        />
      )}

      {tab === "warehouse" && (
        <>
          <StagingBaysPanel
            projectId={projectId}
            jobCode={project?.job_code ?? null}
            isLead={isLead}
          />
          {isLead && (
            <PlanPackagesPanel
              projectId={projectId}
              jobCode={project?.job_code ?? null}
            />
          )}
          {isLead && <ReorderNeedsPanel projectId={projectId} />}
          {/* The unit chain's panels lived here — pre-issue, the delivery
              reconciliation, unload, and the load-to-truck tab (ticket 21,
              ADR-0005). Their jobs moved onto packages: labels mint in the
              plan panel above, the truck confirms on Tag packages, taking
              material to the job is Check out, and site arrival is the
              arrival check. */}
          <JobPackagesPanel projectId={projectId} />
        </>
      )}

      {tab === "dispatch" && isLead && <DispatchBoard projectId={projectId} />}

      {tab === "logs" && isLead && (
        <DailyLogsTab
          projectId={projectId}
          jobLabel={project?.job_code ?? project?.name ?? "this job"}
        />
      )}

      {tab === "photos" && (
        <PhotoFeed projectId={projectId} selectedJobCode={project?.job_code ?? null} />
      )}

      {tab === "chat" && (
        <JobChat
          projectId={projectId}
          jobLabel={project?.job_code ?? project?.name ?? "this job"}
        />
      )}

      {tab === "maps-interactive" && project && <MapsInteractive project={project} />}

      {tab === "exceptions" && isLead && <ExceptionsTab projectId={projectId} />}

      {tab === "brain" && (
        <div>
          {/* Foreman+ only (standing decision): the cohort ladder's numbers. */}
          {isLead && <SignatureEstimates projectId={projectId} />}
          <p className="muted">
            Type brain cards — tips and times from installs on this job&apos;s
            window types.
          </p>
          <ul className="unit-list work-list">
            {brainTypes.map((t) => (
              <li key={t.id} className="find-row">
                <Link to={`/brain/${t.id}`} className="job-row">
                  <strong>{t.type_code}</strong> — {t.name}
                  <span className="muted"> {t.count} opening(s)</span>
                </Link>
              </li>
            ))}
            {brainTypes.length === 0 && (
              <p className="muted">
                No types yet. Confirm openings from a planset to populate the
                brain list.
              </p>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function OfflineDownloadButton({ projectId }: { projectId: string }) {
  const download = useMutation({
    mutationFn: () => prefetchJobPack(projectId),
  });
  return (
    <button
      className="action-btn"
      disabled={download.isPending}
      onClick={() => download.mutate()}
    >
      {download.isPending
        ? "Downloading job for offline…"
        : download.isSuccess
          ? `Saved offline (${download.data} type brains) — re-download`
          : "Download job for offline use"}
    </button>
  );
}

function OverviewTab({
  projectId,
  neededTotal,
  heldCount,
  outCount,
  openingsTotal,
  openingsInstalled,
  needs,
  packages,
  openings,
  estimate,
  isLead,
  canStudio,
  canFlagTesting,
  canDeleteTesting,
  project,
}: {
  projectId: string;
  neededTotal: number;
  heldCount: number;
  outCount: number;
  openingsTotal: number;
  openingsInstalled: number;
  needs: Awaited<ReturnType<typeof getProjectWindows>>;
  packages: StoragePackage[];
  openings: Awaited<ReturnType<typeof listOpenings>>;
  estimate: { est: JobEstimate; crew: CrewRecommendation } | null;
  isLead: boolean;
  canStudio: boolean;
  canFlagTesting: boolean;
  canDeleteTesting: boolean;
  project?: Project;
}) {
  const queryClient = useQueryClient();
  const saveEstimate = useMutation({
    mutationFn: () =>
      saveJobEstimate(
        projectId,
        estimate!.est.expectedMinutes,
        estimate!.crew.recommendedCrew,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
  });

  return (
    <>
      {project && <JobDetailsPanel project={project} isLead={isLead} />}

      {/* effectiveRole-gated, not project.is_test — "view as installer" must
          stay faithful even when the real signed-in user is a supervisor
          previewing a testing project (CLAUDE.md: use effectiveRole for what
          the UI shows, realRole for identity). */}
      {project && canFlagTesting && (
        <TestingProjectPanel
          project={project}
          canDelete={canDeleteTesting}
          openingsCount={openingsTotal}
          packagesCount={packages.length}
        />
      )}

      {/* The job's end of life (owner ask, 2026-08-26): finish or cancel
          moves it off every active screen into Job history — reversible,
          nothing deleted. Supervisor+, same gate the server holds. */}
      {project && canFlagTesting && (
        <JobLifecyclePanel project={project} heldCount={heldCount} />
      )}

      <ScheduledCrewPanel projectId={projectId} isLead={isLead} />

      <WhoOnJobPanel projectId={projectId} />

      {/* Foreman+ only (P1, owner-approved). This card comes from the OLDER
          estimating code, which uses a per-type median with NO minimum sample
          size — the first install ever recorded sets the baseline and the
          second makes it a median, so a confident "slow-case" number can be
          built from two events. The Brain tab's cohort ladder does it the way
          CONTEXT.md settled: always labelled with its rung and sample count,
          and it refuses to print a number below n=5. Two answers for one job,
          and the un-hedged one was the one installers saw. Gating it is not a
          new decision — comparisons across units are already foreman+.
          Retiring lib/estimate.ts in favour of the ladder is the real fix and
          is its own piece of work. */}
      {isLead && estimate && estimate.est.remaining > 0 && (
        <div className="estimate-card">
          <div className="estimate-head">
            <span className="field-label">Forecast (remaining {estimate.est.remaining})</span>
            {isLead && (
              <button
                className="link"
                disabled={saveEstimate.isPending}
                onClick={() => saveEstimate.mutate()}
              >
                {project?.estimated_at ? "Update bid estimate" : "Save as bid estimate"}
              </button>
            )}
          </div>
          <div className="estimate-row">
            <span>
              <strong>{formatHours(estimate.est.expectedMinutes)}</strong> crew-work
            </span>
            <span>
              <strong>~{estimate.crew.recommendedCrew}</strong> installer(s) to finish today
            </span>
            <span>
              <strong>{formatHours(estimate.est.p90Minutes)}</strong> slow-case
              {/* Pick 8 (wave I-2): was title= only, invisible with no hover. */}
              <span className="wh-row-sub" style={{ display: "block" }}>
                9 out of 10 jobs like this finish faster than this
              </span>
            </span>
          </div>
          {estimate.est.unknownTypes > 0 && (
            <p className="wh-row-sub" style={{ margin: "6px 0 0" }}>
              {estimate.est.unknownTypes} opening(s) use a fallback estimate (no
              install history yet).
            </p>
          )}
          {project?.estimated_minutes != null && (
            <p className="wh-row-sub" style={{ margin: "6px 0 0" }}>
              Bid estimate on file: {formatHours(project.estimated_minutes)} /{" "}
              {project.estimated_crew} crew.
            </p>
          )}
        </div>
      )}

      {/* Package language now (ticket 21): what the warehouse holds for this
          job, what has left for the site, and how the install itself stands.
          "N of M assigned/on truck" were the unit chain's words. */}
      <div className="briefing-stats" style={{ marginBottom: 16 }}>
        <span>
          <strong>{heldCount}</strong>
          packages on hand
        </span>
        <span>
          <strong>{outCount}</strong>
          checked out
        </span>
        <span>
          <strong>
            {openingsTotal > 0 ? `${openingsInstalled}/${openingsTotal}` : "—"}
          </strong>
          openings done
        </span>
        <span>
          <strong>{neededTotal || "—"}</strong>
          windows planned
        </span>
      </div>

      <div className="action-list">
        {/* Plan-set upload + tracing live in the Studio now (owner,
            2026-08-14: "that is where the build will begin anyways").
            Foremen can't open the Studio, so they keep the direct upload. */}
        {/* Both destinations are foreman+ routes. Shown to an installer they
            dead-end on "Not available for your role", and the app's own rule
            is that a button landing there is worse than no button
            (installer audit, 2026-08-17). */}
        {canStudio ? (
          <Link to={`/studio/j/${projectId}`} className="action-btn primary">
            Studio — plans, trace &amp; build
          </Link>
        ) : (
          isLead && (
            <Link to={`/projects/${projectId}/upload`} className="action-btn primary">
              Upload plansets
            </Link>
          )
        )}
        {isLead && (
          <Link to={`/projects/${projectId}/review`} className="action-btn">
            Review openings
          </Link>
        )}
        <Link to={`/supplies?job=${projectId}`} className="action-btn">
          Supplies for this job
        </Link>
        <OfflineDownloadButton projectId={projectId} />
      </div>

      <h2>Needed (by type)</h2>
      <p className="muted">
        Quantities roll up from confirmed planset openings — one source of truth.
      </p>
      <ul className="unit-list work-list">
        {needs.map((n) => {
          // "On hand" means a crew could pick the whole window up today
          // (ticket 21): every part of the opening's window physically here.
          // Minted labels are on the way, counted separately rather than
          // hidden — the same owner call (P8) the unit chain honored, kept in
          // package terms. A window with no packages at all counts nowhere,
          // which is what the Not-Tagged card is for.
          const typeOpenings = openings.filter(
            (o) => o.window_types?.id === n.window_type_id,
          );
          let have = 0;
          let onTheWay = 0;
          for (const o of typeOpenings) {
            const r = unitParts(packages, projectId, normalizeMarkCode(o.opening_code));
            if (r.rows.length === 0) continue;
            if (r.complete) have += 1;
            else if (r.onTheWayIndexes.length > 0) onTheWay += 1;
          }
          return (
            <li key={n.id} className="find-row">
              <div>
                <strong>{n.window_types?.type_code}</strong> {n.window_types?.name}
              </div>
              <span className={`${have >= n.quantity ? "ok" : "warn-text"} wh-actions`}>
                {have}/{n.quantity}
                {onTheWay > 0 && (
                  <span className="wh-row-sub" style={{ marginLeft: 6 }}>
                    · {onTheWay} on the way
                  </span>
                )}
              </span>
            </li>
          );
        })}
        {needs.length === 0 && (
          <p className="muted">
            No demand yet. Confirm openings after a planset extract to populate
            warehouse need.
          </p>
        )}
      </ul>
    </>
  );
}

/**
 * Read-only view of the PUBLISHED schedule for this job: crew + dates, plus any
 * linked vehicle/trailer and planned trips. Sources everything from the
 * scheduling board (does not duplicate or edit it) and sits alongside the
 * hand-typed project.start_date/end_date in Job details.
 */
function ScheduledCrewPanel({
  projectId,
  isLead,
}: {
  projectId: string;
  isLead: boolean;
}) {
  const assignments = useQuery({
    queryKey: ["projectSchedule", projectId],
    queryFn: () => listProjectAssignments(projectId),
  });
  const vlinks = useQuery({
    queryKey: ["projectVehicleLinks", projectId],
    queryFn: () => listVehicleLinksForProject(projectId),
  });
  const trips = useQuery({ queryKey: ["trips"], queryFn: listTrips });

  const list = assignments.data ?? [];
  const vehicleByAssignment = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of vlinks.data ?? []) {
      if (l.assignment_id && l.vehicle) map.set(l.assignment_id, vehicleTitle(l.vehicle));
    }
    return map;
  }, [vlinks.data]);
  const projectTrips = useMemo(
    () => (trips.data ?? []).filter((t) => t.project_id === projectId),
    [trips.data, projectId],
  );

  if (list.length === 0 && projectTrips.length === 0) return null;

  const dateRange = (start: string, end: string) =>
    start === end ? fmtDay(start) : `${fmtDay(start)} – ${fmtDay(end)}`;

  return (
    <section className="detail-card" style={{ marginBottom: 16 }}>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>
          <CalendarClock size={16} aria-hidden /> Published crew dates
        </h2>
        {/* /scheduling is foreman+. The crew dates stay visible to everyone —
            only the edit door is gated. */}
        {isLead && (
          <Link to="/scheduling" className="link">
            Scheduling
          </Link>
        )}
      </div>
      <p className="wh-row-sub" style={{ margin: "4px 0 0" }}>
        The dates &amp; crew that actually work this job, from the published
        schedule (not the bid / target window). Edit them on the Scheduling board.
      </p>

      {list.length === 0 ? (
        <p className="muted" style={{ marginTop: 8 }}>
          No published crew assignment yet.
        </p>
      ) : (
        <ul className="unit-list work-list" style={{ marginTop: 8 }}>
          {list.map((a) => {
            const vehicle = vehicleByAssignment.get(a.id);
            const crew = a.members.map((m) => m.display_name ?? "Crew").join(", ");
            return (
              <li key={a.id} className="find-row" style={{ display: "block" }}>
                <div>
                  <strong>{dateRange(a.start_date, a.end_date)}</strong>
                </div>
                <div className="wh-row-sub">
                  <Users size={13} aria-hidden /> {crew || "No crew"}
                </div>
                {vehicle && (
                  <div className="wh-row-sub">
                    <Truck size={13} aria-hidden /> {vehicle}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {projectTrips.length > 0 && (
        <ul className="unit-list work-list" style={{ marginTop: 8 }}>
          {projectTrips.map((t) => (
            <li key={t.id} className="find-row">
              <Link to={`/travel/${t.id}`} className="job-row">
                <Plane size={13} aria-hidden /> {t.destination || t.name}
                <span className="muted"> · {dateRange(t.start_date, t.end_date)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  schedule: "scheduled",
  dispatch: "dispatched",
  chat: "chat",
};

/**
 * Read-only "Who's on this job?" — merges the published schedule crew, the
 * installers dispatched to openings, and the job chat roster into one deduped
 * people list, plus any linked vehicle/trailer. Pulls from the existing sources
 * (does not edit or collapse any of them); each of those surfaces keeps its own
 * detailed view.
 */
function WhoOnJobPanel({ projectId }: { projectId: string }) {
  const assignments = useQuery({
    queryKey: ["projectSchedule", projectId],
    queryFn: () => listProjectAssignments(projectId),
  });
  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
  });
  const roster = useQuery({
    queryKey: ["projectRoster", projectId],
    queryFn: () => listRoster(projectId),
  });
  const vlinks = useQuery({
    queryKey: ["projectVehicleLinks", projectId],
    queryFn: () => listVehicleLinksForProject(projectId),
  });

  const people = useMemo(
    () =>
      mergeJobPeople({
        scheduleMembers: (assignments.data ?? []).flatMap((a) =>
          a.members.map((m) => ({
            profile_id: m.profile_id,
            display_name: m.display_name ?? null,
            role: m.role,
          })),
        ),
        openingAssignees: (openings.data ?? [])
          .filter((o) => o.assigned_to)
          .map((o) => ({
            id: o.assigned_to as string,
            display_name: o.assignee?.display_name ?? null,
            role: o.assignee?.role ?? null,
          })),
        rosterMembers: roster.data?.members ?? [],
      }),
    [assignments.data, openings.data, roster.data],
  );

  const vehicles = useMemo(() => {
    const names = (vlinks.data ?? [])
      .map((l) => (l.vehicle ? vehicleTitle(l.vehicle) : null))
      .filter((n): n is string => Boolean(n));
    return [...new Set(names)];
  }, [vlinks.data]);

  if (people.length === 0 && vehicles.length === 0) return null;

  return (
    <section className="detail-card" style={{ marginBottom: 16 }}>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>
          <Users size={16} aria-hidden /> Who&apos;s on this job?
        </h2>
      </div>
      <p className="wh-row-sub" style={{ margin: "4px 0 0" }}>
        Everyone attached to this job — from the schedule, dispatched openings,
        and the job chat.
      </p>

      {people.length > 0 ? (
        <ul className="unit-list work-list" style={{ marginTop: 8 }}>
          {people.map((p) => (
            <li key={p.id} className="find-row">
              <div>
                <strong>{p.name}</strong>
                {p.role && <span className="muted"> · {p.role}</span>}
              </div>
              <span className="wh-row-sub wh-actions">
                {p.sources.map((s) => SOURCE_LABELS[s]).join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted" style={{ marginTop: 8 }}>
          No one assigned yet.
        </p>
      )}

      {vehicles.length > 0 && (
        <p className="muted" style={{ marginTop: 8 }}>
          <Truck size={13} aria-hidden /> {vehicles.join(", ")}
        </p>
      )}
    </section>
  );
}

function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "";
  // date columns come back as YYYY-MM-DD; render without TZ drift.
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Job details card: the Horizon-style intake fields (customer/contact, site
 * address, scheduled dates, notes) shown on the hub, with an inline edit form
 * for foreman+. Mirrors Horizon's add/edit-project fields in windows terms.
 */
function JobDetailsPanel({
  project,
  isLead,
}: {
  project: Project;
  isLead: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [address, setAddress] = useState(project.address ?? "");
  const [customerName, setCustomerName] = useState(project.customer_name ?? "");
  const [contactPhone, setContactPhone] = useState(project.contact_phone ?? "");
  const [contactEmail, setContactEmail] = useState(project.contact_email ?? "");
  const [unitNumber, setUnitNumber] = useState(project.unit_number ?? "");
  const [siteState, setSiteState] = useState(project.site_state ?? "");
  const [startDate, setStartDate] = useState(project.start_date?.slice(0, 10) ?? "");
  const [endDate, setEndDate] = useState(project.end_date?.slice(0, 10) ?? "");
  const [notes, setNotes] = useState(project.notes ?? "");

  const resetForm = () => {
    setName(project.name);
    setAddress(project.address ?? "");
    setCustomerName(project.customer_name ?? "");
    setContactPhone(project.contact_phone ?? "");
    setContactEmail(project.contact_email ?? "");
    setUnitNumber(project.unit_number ?? "");
    setSiteState(project.site_state ?? "");
    setStartDate(project.start_date?.slice(0, 10) ?? "");
    setEndDate(project.end_date?.slice(0, 10) ?? "");
    setNotes(project.notes ?? "");
  };

  const save = useMutation({
    mutationFn: () =>
      updateProject(project.id, {
        name,
        address,
        customerName,
        contactPhone,
        contactEmail,
        unitNumber,
        siteState,
        startDate,
        endDate,
        notes,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setEditing(false);
      pushToast("Job details saved.", "info");
    },
    onError: (e) => toastError(e),
  });

  const detailRows: { label: string; value: string }[] = [
    { label: "Customer / contact", value: project.customer_name ?? "" },
    { label: "Phone", value: project.contact_phone ?? "" },
    { label: "Email", value: project.contact_email ?? "" },
    { label: "Site address", value: project.address ?? "" },
    { label: "Building / unit / lot", value: project.unit_number ?? "" },
    { label: "State", value: project.site_state ?? "" },
    { label: "Bid / target start", value: fmtDay(project.start_date) },
    { label: "Bid / target completion", value: fmtDay(project.end_date) },
  ].filter((r) => r.value);
  const hasTargetDates =
    Boolean(project.start_date) || Boolean(project.end_date);

  if (!editing) {
    const hasAny = detailRows.length > 0 || Boolean(project.notes);
    return (
      <section className="detail-card" style={{ marginBottom: 16 }}>
        <div className="row-between">
          <h2 style={{ margin: 0 }}>Job details</h2>
          {isLead && (
            <button type="button" className="link" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
        </div>
        {hasAny ? (
          <>
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(min(160px, 100%), 1fr))",
                gap: "10px 16px",
                margin: "10px 0 0",
              }}
            >
              {detailRows.map((r) => (
                <div key={r.label}>
                  <dt className="field-label">{r.label}</dt>
                  <dd style={{ margin: 0 }}>{r.value}</dd>
                  {r.label === "Site address" && (
                    <DirectionsButton address={r.value} />
                  )}
                </div>
              ))}
            </dl>
            {project.notes && (
              <p className="muted" style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>
                {project.notes}
              </p>
            )}
            {hasTargetDates && (
              <p className="wh-row-sub" style={{ marginTop: 8 }}>
                Your bid / target window. The dates crew actually work are the
                published crew dates on the schedule (shown above).
              </p>
            )}
          </>
        ) : (
          <p className="muted" style={{ marginTop: 6 }}>
            {isLead
              ? "No customer or schedule details yet. Tap Edit to add them."
              : "No customer or schedule details yet."}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="detail-card" style={{ marginBottom: 16 }}>
      <form
        className="project-create"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="row-between">
          <h2 style={{ margin: 0 }}>Edit job details</h2>
          <button
            type="button"
            className="link"
            onClick={() => {
              resetForm();
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </div>
        <div className="project-create-grid">
          <label>
            <span className="field-label">Project name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            <span className="field-label">Customer / contact</span>
            <input
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Pecan Valley HOA · Jane Doe"
            />
          </label>
          <label>
            <span className="field-label">Contact phone</span>
            <input
              type="tel"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder="(435) 555-0173"
            />
          </label>
          <label>
            <span className="field-label">Contact email</span>
            <input
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="office@pecanvalley.com"
            />
          </label>
          <label className="project-create-address">
            <span className="field-label">Site address</span>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="173 Pecan Valley Dr, Hurricane, UT 84737"
            />
          </label>
          <label>
            <span className="field-label">Building / unit / lot</span>
            <input
              value={unitNumber}
              onChange={(e) => setUnitNumber(e.target.value)}
              placeholder="Building 14 · Lots 173–183"
            />
          </label>
          <label>
            <span className="field-label">State</span>
            <input
              value={siteState}
              onChange={(e) => setSiteState(e.target.value)}
              placeholder="UT"
              maxLength={2}
              autoCapitalize="characters"
            />
          </label>
          <label>
            <span className="field-label">Bid / target start</span>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">Bid / target completion</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </label>
          <label className="project-create-address">
            <span className="field-label">Job notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Access, gate codes, staging area, scope reminders…"
              rows={3}
            />
          </label>
        </div>
        {save.isError && <p className="error">{formatApiError(save.error)}</p>}
        <button
          type="submit"
          className="action-btn primary"
          disabled={save.isPending || !name.trim()}
        >
          {save.isPending ? "Saving…" : "Save job details"}
        </button>
      </form>
    </section>
  );
}

/**
 * Testing projects are fake data for practice or QA (owner call,
 * 2026-08-25): flagging one hides it below supervisor (RLS, this file
 * doesn't enforce that — it just reflects it) and pulls its packages out of
 * every warehouse inventory figure client-side. Only rendered for
 * supervisor+ (see the call site) — this toggle is the write path, since
 * `projects.is_test` itself is not writable directly from any client role.
 *
 * Delete is owner-only and only appears once a job is already flagged
 * testing, so there is no path from "real job" straight to "gone" — a job
 * has to be marked fake first, a separate and reversible step, before the
 * irreversible one becomes available at all.
 */
function TestingProjectPanel({
  project,
  canDelete,
  openingsCount,
  packagesCount,
}: {
  project: Project;
  canDelete: boolean;
  openingsCount: number;
  packagesCount: number;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const flag = useMutation({
    mutationFn: (isTest: boolean) => setProjectTest(project.id, isTest),
    onSuccess: (_result, isTest) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      pushToast(
        isTest ? "Flagged as a testing project." : "No longer a testing project.",
        "info",
      );
    },
    onError: (e) => toastError(e),
  });

  const remove = useMutation({
    mutationFn: () => deleteTestProject(project.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      pushToast(`${project.job_code} permanently deleted.`, "info");
      navigate("/projects");
    },
    onError: (e) => toastError(e),
  });

  const confirmDelete = () => {
    const sure = window.confirm(
      `Permanently delete ${project.job_code}? This deletes its ${openingsCount} ` +
        `opening${openingsCount === 1 ? "" : "s"} and ${packagesCount} ` +
        `package${packagesCount === 1 ? "" : "s"}, and every install record, ` +
        `photo and note against them. This cannot be undone.`,
    );
    if (sure) remove.mutate();
  };

  return (
    <section className="detail-card" style={{ marginBottom: 16 }}>
      <h2 style={{ margin: 0 }}>Testing</h2>
      <label
        style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 10 }}
      >
        <input
          type="checkbox"
          checked={project.is_test ?? false}
          disabled={flag.isPending}
          onChange={(e) => flag.mutate(e.target.checked)}
        />
        <span>
          <strong>Testing project</strong>
          <br />
          <span className="wh-row-sub">
            Fake data for practice. Hidden from installers and foremen; its
            material never counts as real inventory.
          </span>
        </span>
      </label>
      {flag.isError && <p className="error">{formatApiError(flag.error)}</p>}

      {canDelete && project.is_test && (
        <div
          style={{
            marginTop: 16,
            paddingTop: 16,
            borderTop: "1px solid var(--border)",
          }}
        >
          <button
            type="button"
            className="action-btn danger-outline"
            disabled={remove.isPending}
            onClick={confirmDelete}
          >
            {remove.isPending ? "Deleting…" : "Delete this testing project…"}
          </button>
          <p className="wh-row-sub" style={{ marginTop: 6 }}>
            Permanent. Only possible because this job is flagged testing —
            there is no way to do this to a real job.
          </p>
          {remove.isError && <p className="error">{formatApiError(remove.error)}</p>}
        </div>
      )}
    </section>
  );
}

/**
 * The job's two staging bays — the shelves that keep this job's windows
 * together instead of mixed into shared stock.
 *
 * Normally this is a quiet one-line confirmation. It turns into a warning with
 * a fix button when a bay is missing or has been retired, which is the state
 * that used to be invisible: the app would just start suggesting a shared
 * stock shelf, and the only symptom was two absent entries in a 44-item
 * dropdown. Repairing it previously meant an engineer writing SQL against
 * production; now it is one tap for a foreman.
 */
function StagingBaysPanel({
  projectId,
  jobCode,
  isLead,
}: {
  projectId: string;
  jobCode: string | null;
  isLead: boolean;
}) {
  const queryClient = useQueryClient();
  const locations = useQuery({ queryKey: ["locations"], queryFn: listLocations });

  const bays = stagingBaysFor(locations.data ?? [], jobCode);
  const missing = missingStagingSlots(locations.data ?? [], jobCode);

  const create = useMutation({
    mutationFn: () => ensureStagingBays(projectId),
    onSuccess: () => {
      pushToast(`Staging bays ready for ${jobCode ?? "this job"}.`, "success");
      queryClient.invalidateQueries({ queryKey: ["locations"] });
      queryClient.invalidateQueries({ queryKey: ["suggest"] });
    },
    onError: (e) => toastError(e),
  });

  // Nothing to say while the list is still loading, or before we know the job.
  if (!jobCode || locations.isLoading) return null;

  if (missing.length === 0) {
    return (
      <section className="detail-card" style={{ marginBottom: 16 }}>
        <div className="row-between">
          <h2 style={{ margin: 0 }}>Staging bays</h2>
          <span className="ok">Ready</span>
        </div>
        <p className="muted" style={{ marginTop: 6 }}>
          {bays
            .filter((b) => b.active)
            .map((b) => b.address)
            .join(" and ")}{" "}
          — this job&apos;s windows are kept together here.{" "}
          {isLead && (
            <Link to="/labels" className="link">
              Print the shelf labels →
            </Link>
          )}
        </p>
      </section>
    );
  }

  return (
    <section className="detail-card" style={{ marginBottom: 16 }} role="alert">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Staging bays</h2>
        <span className="warn-text">
          {missing.length === 2 ? "None" : "One missing"}
        </span>
      </div>
      <p style={{ marginTop: 6 }}>
        This job has no shelf of its own for{" "}
        {missing.map((s) => `J-${jobCode}-${s}`).join(" and ")}. Until that is
        fixed, the app will not tell anyone where to put this job&apos;s
        windows, because the only other answer is a shared stock shelf — and
        windows stacked with another job&apos;s material get installed at the
        wrong address.
      </p>
      {isLead ? (
        <button
          className="action-btn primary"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending
            ? "Creating…"
            : `Create ${missing.length === 2 ? "both staging bays" : "the missing staging bay"}`}
        </button>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          Ask a foreman to create them from this screen.
        </p>
      )}
    </section>
  );
}



/**
 * Foreman+/office ROLLUP: units that need reordering for this job — damaged
 * units plus still-missing deliveries, grouped by window type — with a link to
 * the Issues list so shortfalls get reordered fast.
 */
function ReorderNeedsPanel({ projectId }: { projectId: string }) {
  const needs = useQuery({
    queryKey: ["reorderNeeds", projectId],
    queryFn: () => listReorderNeeds(projectId),
  });

  const rows = needs.data ?? [];
  const total = totalReorder(rows);

  if (needs.isLoading || rows.length === 0) {
    // Hide the panel entirely when there's nothing to reorder.
    return null;
  }

  return (
    <section className="detail-card" style={{ marginBottom: 16 }}>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Reorder needs</h2>
        <span className="warn-text">{total} to reorder</span>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        Units short for this job — damaged or never delivered. Reorder these so
        the crew isn’t held up.
      </p>
      <ul className="unit-list work-list">
        {rows.map((r) => (
          <li key={r.window_type_id} className="find-row">
            <strong>{r.type_name}</strong>
            <span className="big-address" style={{ color: "#ef4444" }}>
              {r.missing_count > 0 && `${r.missing_count} missing`}
              {r.missing_count > 0 && r.damaged_count > 0 && " · "}
              {r.damaged_count > 0 && `${r.damaged_count} damaged`}
            </span>
          </li>
        ))}
      </ul>
      <div className="action-list">
        <Link to="/issues" className="action-btn">
          View damaged / missing issues
        </Link>
      </div>
    </section>
  );
}


function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

// Kinds shown in the Exceptions tab, in triage order. Exceptions is now just a
// per-project filtered view of the unified `issues` table.
const EXCEPTION_KIND_ORDER: { kind: IssueKind; heading: string }[] = [
  { kind: "failed_install", heading: "Failed / undone installs" },
  { kind: "damage", heading: "Damaged" },
  { kind: "missing", heading: "Missing deliveries" },
  { kind: "flag", heading: "Flagged" },
  { kind: "blocker", heading: "Blockers" },
  { kind: "complication", heading: "Complications" },
  { kind: "spec_gap", heading: "Spec sheet gaps" },
  // framing was added to IssueKind later and this list was never updated, so a
  // failed rough-opening check filed an URGENT issue that rendered zero
  // sections here — and, because an open issue existed, suppressed the
  // "everything looks clean" message too. The foreman saw an empty tab.
  { kind: "framing", heading: "Framing fixes needed" },
];

function ExceptionsTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const issues = useQuery({
    queryKey: ["projectIssues", projectId],
    queryFn: () => listProjectIssues(projectId),
  });

  const resolve = useMutation({
    mutationFn: (id: string) => resolveIssue(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projectIssues", projectId] });
      queryClient.invalidateQueries({ queryKey: ["issues"] });
    },
  });

  if (issues.isLoading) {
    return <p className="muted">Loading exceptions…</p>;
  }
  if (issues.isError) {
    return <p className="error">{formatApiError(issues.error)}</p>;
  }

  const open = (issues.data ?? []).filter((i) => i.status === "open");
  const byKind = new Map<IssueKind, Issue[]>();
  for (const i of open) {
    const list = byKind.get(i.kind) ?? [];
    list.push(i);
    byKind.set(i.kind, list);
  }

  const issueRow = (i: Issue) => (
    <li key={i.id} className="find-row">
      {i.opening_id ? (
        <Link to={`/projects/${projectId}/opening/${i.opening_id}`}>
          <strong>{URGENCY_MARK[i.urgency] || "•"}</strong>
        </Link>
      ) : (
        <strong>{URGENCY_MARK[i.urgency] || "•"}</strong>
      )}
      <span className="muted">{fmtDate(i.created_at)}</span>
      <span
        className="big-address"
        style={{ color: i.urgency === "normal" ? undefined : "#ef4444" }}
      >
        {i.note ?? KIND_LABELS[i.kind]}
      </span>
      <button
        className="link wh-actions"
        disabled={resolve.isPending}
        onClick={() => resolve.mutate(i.id)}
      >
        Resolve
      </button>
    </li>
  );

  return (
    <div>
      <p className="muted">
        A filtered view of this job&apos;s issues — failed installs, damage,
        flags, blockers, and complications. Same data as the cross-project{" "}
        <Link to="/issues">Issues</Link> list; nothing is deleted.
      </p>

      {open.length === 0 && (
        <p className="muted">No open issues right now — everything looks clean.</p>
      )}

      {EXCEPTION_KIND_ORDER.map(({ kind, heading }) => {
        const list = (byKind.get(kind) ?? []).sort(compareIssues);
        if (list.length === 0) return null;
        return (
          <div key={kind}>
            <h2>
              {heading} ({list.length})
            </h2>
            <ul className="unit-list work-list">{list.map(issueRow)}</ul>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Finish, cancel, or reopen the job (owner ask, 2026-08-26). Reversible on
 * purpose — the job moves to Job history with everything it ever tracked
 * and comes back with one tap. Deleting is a different, owner-only door on
 * the history page, and only for empty shells.
 */
function JobLifecyclePanel({
  project,
  heldCount,
}: {
  project: Project;
  /** Packages of this job still received/stored in the warehouse — the
   *  finish confirm names them (warn, never block — house rule). */
  heldCount: number;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const lifecycle = useMutation({
    mutationFn: (status: "active" | "completed" | "cancelled") =>
      setProjectStatus(project.id, status),
    onSuccess: (_r, status) => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["projectsAll"] });
      if (status === "active") {
        pushToast("Reopened — back on every active list.");
      } else {
        pushToast(
          status === "completed"
            ? "Job finished — moved to Job history with everything it tracked."
            : "Job cancelled — moved to Job history with everything it tracked.",
        );
        navigate("/projects");
      }
    },
    onError: (e) => toastError(e, formatApiError(e)),
  });

  return (
    <div className="detail-card wh-card">
      <div className="wh-row">
        <strong>
          {project.status === "active"
            ? "Wrap this job up"
            : project.status === "completed"
              ? "This job is finished"
              : "This job is cancelled"}
        </strong>
        {project.status === "active" ? (
          <>
            <button
              className="button-like"
              disabled={lifecycle.isPending}
              onClick={() => {
                const held =
                  heldCount > 0
                    ? ` ${heldCount} package${heldCount === 1 ? " is" : "s are"} still in the warehouse — they stay findable under Job history.`
                    : "";
                if (
                  window.confirm(
                    `Finish ${project.job_code}? It leaves every active list and moves to Job history — nothing is deleted, and a supervisor can reopen it any time.${held}`,
                  )
                ) {
                  lifecycle.mutate("completed");
                }
              }}
            >
              Finish this job…
            </button>
            <button
              className="button-like"
              disabled={lifecycle.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `Cancel ${project.job_code}? For jobs that fell through — it moves to Job history with everything it tracked. Reopen any time.`,
                  )
                ) {
                  lifecycle.mutate("cancelled");
                }
              }}
            >
              Cancel this job…
            </button>
          </>
        ) : (
          <button
            className="button-like"
            disabled={lifecycle.isPending}
            onClick={() => lifecycle.mutate("active")}
          >
            Reopen this job
          </button>
        )}
      </div>
      <p className="wh-row-sub" style={{ margin: "4px 0 0" }}>
        Finished and cancelled jobs live in Job history — nothing about them
        is deleted.
      </p>
    </div>
  );
}
