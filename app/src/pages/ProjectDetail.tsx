import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Scanner } from "../components/Scanner";
import { DirectionsButton } from "../components/maps/DirectionsButton";
import {
  activatePreissuedUnit,
  ensureStagingBays,
  findWindowByCode,
  findWindowBySerial,
  getProjectUnits,
  getProjectWindows,
  getWindowByWindowId,
  listLocations,
  listProjects,
  listReorderNeeds,
  loadUnits,
  loadWindow,
  preissueProjectUnits,
  reconcileProjectDeliveries,
  unloadUnits,
  updateProject,
} from "../lib/api";
import { selectedLoadableIds, toggleSelected, totalReorder } from "../lib/loadout";
import { downloadPdf, windowLabelsPdf } from "../lib/labels";
import {
  computePreissuePlan,
  totalExisting,
  totalPlanned,
  totalToIssue,
} from "../lib/preissue";
import { computeDeliveryProgress } from "../lib/receiving";
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
import {
  STATUS_LABELS,
  type Project,
  type ProjectWindow,
  type WindowUnit,
} from "../lib/types";
import { isForemanPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { listProjectAssignments } from "../lib/schedule/api";
import { listVehicleLinksForProject } from "../lib/vehicles/api";
import { vehicleTitle } from "../lib/vehicles/display";
import { listTrips } from "../lib/travel/api";
import { listRoster } from "../lib/chat/api";
import { mergeJobPeople } from "../lib/whoOnJob";
import { CalendarClock, Plane, Truck, Users } from "lucide-react";
import { resolveWindowFromScan } from "../lib/scanResolve";
import { ProjectMap } from "./install/ProjectMap";
import { MapsInteractive } from "./install/MapsInteractive";
import { DispatchBoard } from "./install/DispatchBoard";
import { ScrollTabs } from "../components/nav/ScrollTabs";
import { PhotoFeed } from "../components/photos/PhotoFeed";
import { JobChat } from "../components/chat/JobChat";
import { useUnreadCounts } from "../lib/chat/useUnreadCounts";
import { formatApiError } from "../lib/errors";

const windowLookups = { getWindowByWindowId, findWindowByCode, findWindowBySerial };

type HubTab =
  | "overview"
  | "warehouse"
  | "map"
  | "maps-interactive"
  | "brain"
  | "dispatch"
  | "exceptions"
  | "photos"
  | "chat";

export function ProjectDetail() {
  const { projectId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: HubTab =
    tabParam === "warehouse" ||
    tabParam === "map" ||
    tabParam === "maps-interactive" ||
    tabParam === "brain" ||
    tabParam === "dispatch" ||
    tabParam === "exceptions" ||
    tabParam === "photos" ||
    tabParam === "chat"
      ? tabParam
      : "overview";

  useRealtimeOpenings(projectId);
  const { effectiveRole } = useEffectiveRole();
  const isLead = isForemanPlus(effectiveRole);
  const unread = useUnreadCounts();
  const chatUnread = unread.data?.[projectId] ?? 0;

  const TABS: { id: HubTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    ...(isLead ? [{ id: "dispatch" as HubTab, label: "Dispatch" }] : []),
    { id: "warehouse", label: "Warehouse" },
    { id: "chat", label: "Chat" },
    { id: "photos", label: "Photos" },
    { id: "map", label: "Map" },
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

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const project = projects.data?.find((p) => p.id === projectId);

  const needs = useQuery({
    queryKey: ["projectWindows", projectId],
    queryFn: () => getProjectWindows(projectId),
  });
  const units = useQuery({
    queryKey: ["projectUnits", projectId],
    queryFn: () => getProjectUnits(projectId),
  });
  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
  });

  const pickList = useMemo(() => {
    return (units.data ?? [])
      .filter((u) => u.status === "in_warehouse" || u.status === "staged")
      .sort((a, b) =>
        (a.locations?.address ?? "~").localeCompare(b.locations?.address ?? "~"),
      );
  }, [units.data]);

  const loaded = (units.data ?? []).filter((u) => u.status === "loaded");
  const installedUnits = (units.data ?? []).filter((u) => u.status === "installed");
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
          <Link to="/projects" className="back-chip" aria-label="Back to jobs">
            ‹
          </Link>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: 26 }}>{project?.job_code ?? "Job"}</h1>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
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
          unitsCount={units.data?.length ?? 0}
          neededTotal={neededTotal}
          pickCount={pickList.length}
          loadedCount={loaded.length}
          installedUnits={installedUnits.length}
          openingsTotal={openingsList.length}
          openingsInstalled={openingsInstalled}
          needs={needs.data ?? []}
          units={units.data ?? []}
          estimate={jobEstimate}
          isLead={isLead}
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
            <PreissuePanel
              projectId={projectId}
              needs={needs.data ?? []}
              units={units.data ?? []}
            />
          )}
          {isLead && (
            <ReceivingPanel projectId={projectId} units={units.data ?? []} />
          )}
          {isLead && <UnloadPanel projectId={projectId} loaded={loaded} />}
          {isLead && <ReorderNeedsPanel projectId={projectId} />}
          <WarehouseTab
            projectId={projectId}
            pickList={pickList}
            loaded={loaded}
            isLead={isLead}
          />
        </>
      )}

      {tab === "dispatch" && isLead && <DispatchBoard projectId={projectId} />}

      {tab === "photos" && (
        <PhotoFeed projectId={projectId} selectedJobCode={project?.job_code ?? null} />
      )}

      {tab === "chat" && (
        <JobChat
          projectId={projectId}
          jobLabel={project?.job_code ?? project?.name ?? "this job"}
        />
      )}

      {tab === "map" && <ProjectMap embedded />}

      {tab === "maps-interactive" && project && <MapsInteractive project={project} />}

      {tab === "exceptions" && isLead && <ExceptionsTab projectId={projectId} />}

      {tab === "brain" && (
        <div>
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
  unitsCount,
  neededTotal,
  pickCount,
  loadedCount,
  installedUnits,
  openingsTotal,
  openingsInstalled,
  needs,
  units,
  estimate,
  isLead,
  project,
}: {
  projectId: string;
  unitsCount: number;
  neededTotal: number;
  pickCount: number;
  loadedCount: number;
  installedUnits: number;
  openingsTotal: number;
  openingsInstalled: number;
  needs: Awaited<ReturnType<typeof getProjectWindows>>;
  units: WindowUnit[];
  estimate: { est: JobEstimate; crew: CrewRecommendation } | null;
  isLead: boolean;
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

      <ScheduledCrewPanel projectId={projectId} />

      <WhoOnJobPanel projectId={projectId} />

      {estimate && estimate.est.remaining > 0 && (
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
            <span title="9 out of 10 jobs like this finish faster than this">
              <strong>{formatHours(estimate.est.p90Minutes)}</strong> slow-case
            </span>
          </div>
          {estimate.est.unknownTypes > 0 && (
            <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
              {estimate.est.unknownTypes} opening(s) use a fallback estimate (no
              install history yet).
            </p>
          )}
          {project?.estimated_minutes != null && (
            <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
              Bid estimate on file: {formatHours(project.estimated_minutes)} /{" "}
              {project.estimated_crew} crew.
            </p>
          )}
        </div>
      )}

      <div className="briefing-stats" style={{ marginBottom: 16 }}>
        <span>
          <strong>{unitsCount}</strong>
          of {neededTotal || "—"} assigned
        </span>
        <span>
          <strong>{pickCount}</strong>
          in warehouse
        </span>
        <span>
          <strong>{loadedCount}</strong>
          on truck
        </span>
        <span>
          <strong>
            {openingsTotal > 0
              ? `${openingsInstalled}/${openingsTotal}`
              : installedUnits}
          </strong>
          {openingsTotal > 0 ? "openings done" : "units installed"}
        </span>
      </div>

      <div className="action-list">
        <Link to={`/projects/${projectId}/upload`} className="action-btn primary">
          Upload plansets
        </Link>
        <Link to={`/projects/${projectId}/review`} className="action-btn">
          Review openings
        </Link>
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
          const have = units.filter((u) => u.window_type_id === n.window_type_id).length;
          return (
            <li key={n.id} className="find-row">
              <div>
                <strong>{n.window_types?.type_code}</strong> {n.window_types?.name}
              </div>
              <span className={have >= n.quantity ? "ok" : "warn-text"} style={{ marginLeft: "auto" }}>
                {have}/{n.quantity}
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
function ScheduledCrewPanel({ projectId }: { projectId: string }) {
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
        <Link to="/scheduling" className="link">
          Scheduling
        </Link>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
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
                <div className="muted" style={{ fontSize: 13 }}>
                  <Users size={13} aria-hidden /> {crew || "No crew"}
                </div>
                {vehicle && (
                  <div className="muted" style={{ fontSize: 13 }}>
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
      <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
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
              <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
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
              <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
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
 * Foreman+ action: turn a project's planned quantities into pre-issued unit
 * records (serial + short_code + QR, status pre_issued) BEFORE the windows
 * physically arrive, then print the label batch so labels get applied on
 * delivery. This is the front of the tracking chain — every expected unit has
 * an ID before arrival, enabling missing-delivery detection next.
 */
function PreissuePanel({
  projectId,
  needs,
  units,
}: {
  projectId: string;
  needs: ProjectWindow[];
  units: WindowUnit[];
}) {
  const queryClient = useQueryClient();

  const plan = useMemo(
    () =>
      computePreissuePlan(
        needs.map((n) => ({
          window_type_id: n.window_type_id,
          quantity: n.quantity,
        })),
        units.map((u) => ({ window_type_id: u.window_type_id })),
      ),
    [needs, units],
  );
  const expected = totalPlanned(plan);
  const issued = totalExisting(plan);
  const toIssue = totalToIssue(plan);

  const preIssuedUnits = useMemo(
    () => (units ?? []).filter((u) => u.status === "pre_issued"),
    [units],
  );

  const preissue = useMutation({
    mutationFn: () => preissueProjectUnits(projectId),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["projectUnits", projectId] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      pushToast(
        created.length > 0
          ? `Pre-issued ${created.length} unit ID${created.length === 1 ? "" : "s"}.`
          : "All planned units already have IDs.",
        "info",
      );
    },
    onError: (e) => toastError(e),
  });

  const printPreIssued = async () => {
    const list = preIssuedUnits;
    if (list.length === 0) {
      pushToast("No pre-issued units to print yet.", "info");
      return;
    }
    try {
      const bytes = await windowLabelsPdf(
        list.map((u) => ({
          window_id: u.window_id,
          typeName: u.window_types?.name ?? u.window_types?.type_code ?? "",
          short_code: u.short_code,
          serial: u.serial,
          display_name: u.display_name,
        })),
      );
      downloadPdf(bytes, `preissued-labels-${projectId}.pdf`);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <section className="detail-card" style={{ marginBottom: 16 }}>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Pre-issue unit IDs & labels</h2>
        <span className={toIssue > 0 ? "warn-text" : "ok"}>
          {issued}/{expected || "—"} issued
        </span>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        Create an ID + printable label for every expected window before it
        arrives, so crew can label units on delivery and we can spot a missing
        delivery later.
      </p>

      <div className="action-list">
        <button
          className="action-btn primary"
          disabled={expected === 0 || toIssue === 0 || preissue.isPending}
          onClick={() => preissue.mutate()}
        >
          {preissue.isPending
            ? "Pre-issuing…"
            : toIssue > 0
              ? `Pre-issue ${toIssue} unit ID${toIssue === 1 ? "" : "s"}`
              : expected === 0
                ? "No planned windows yet"
                : "All planned units have IDs"}
        </button>
        <button
          className="action-btn"
          disabled={preIssuedUnits.length === 0}
          onClick={printPreIssued}
        >
          Print labels for pre-issued units ({preIssuedUnits.length})
        </button>
      </div>

      {expected === 0 && (
        <p className="muted">
          No planned quantities yet. Confirm openings from a planset to populate
          the plan, then pre-issue IDs here.
        </p>
      )}

      {preIssuedUnits.length > 0 && (
        <ul className="unit-list work-list">
          {preIssuedUnits.map((u) => (
            <li key={u.id} className="find-row">
              <Link to={`/w/${encodeURIComponent(u.window_id)}`}>
                <strong>{u.window_id}</strong>
              </Link>
              {u.short_code && (
                <span className="short-code-chip"> {u.short_code}</span>
              )}
              <span className="muted"> {u.window_types?.type_code}</span>
              <span className="big-address">{STATUS_LABELS[u.status]}</span>
            </li>
          ))}
        </ul>
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
          <Link to="/labels" className="link">
            Print the shelf labels →
          </Link>
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
 * Foreman+ action: RECEIVE against the plan. Scan/type a unit's code as it
 * arrives to match it to its pre-issued ID and activate it (into the warehouse,
 * or held as damaged). Shows a "Received X of Y expected" readout, and a
 * reconcile action that flags any still-undelivered pre-issued units as missing
 * issues. The ad-hoc receive_window path (unplanned units) stays on /receive.
 */
function ReceivingPanel({
  projectId,
  units,
}: {
  projectId: string;
  units: WindowUnit[];
}) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [locationId, setLocationId] = useState("");
  const [damaged, setDamaged] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const locations = useQuery({ queryKey: ["locations"], queryFn: listLocations });
  const issues = useQuery({
    queryKey: ["projectIssues", projectId],
    queryFn: () => listProjectIssues(projectId),
  });

  const progress = useMemo(() => computeDeliveryProgress(units), [units]);

  const activate = useMutation({
    mutationFn: () => {
      const c = code.trim();
      if (!c) throw new Error("Scan or type a unit code first.");
      return activatePreissuedUnit(c, locationId || null, damaged);
    },
    onSuccess: (unit: WindowUnit) => {
      setMessage(
        `${damaged ? "Received DAMAGED" : "Received"} ${unit.window_id}` +
          (unit.locations?.address ? ` → ${unit.locations.address}` : ""),
      );
      setCode("");
      setDamaged(false);
      queryClient.invalidateQueries({ queryKey: ["projectUnits", projectId] });
      queryClient.invalidateQueries({ queryKey: ["projectIssues", projectId] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const reconcile = useMutation({
    mutationFn: () => reconcileProjectDeliveries(projectId),
    onSuccess: (created) => {
      pushToast(
        created.length > 0
          ? `Flagged ${created.length} unit${created.length === 1 ? "" : "s"} as missing.`
          : "No missing units — every pre-issued unit is accounted for.",
        created.length > 0 ? "error" : "info",
      );
      queryClient.invalidateQueries({ queryKey: ["projectIssues", projectId] });
      queryClient.invalidateQueries({ queryKey: ["issues"] });
    },
    onError: (e) => toastError(e),
  });

  const openIssues = (issues.data ?? []).filter((i) => i.status === "open");
  const missingOpen = openIssues.filter((i) => i.kind === "missing");
  const damagedOpen = openIssues.filter((i) => i.kind === "damage");
  const flagged = [...damagedOpen, ...missingOpen];

  return (
    <section className="detail-card" style={{ marginBottom: 16 }}>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Receive against the plan</h2>
        <span className={progress.preIssuedRemaining > 0 ? "warn-text" : "ok"}>
          Received {progress.received} of {progress.expected || "—"} expected
        </span>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        Scan or type a unit&apos;s code as it arrives to match it to its
        pre-issued ID and put it in the warehouse. Flip &quot;arrived
        damaged&quot; to hold it and open a damage issue.{" "}
        <Link to="/receive" className="link">
          Extra / unplanned stock? Receive it here →
        </Link>
      </p>

      <div className="manual-entry">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="6-char code or serial"
          autoCapitalize="characters"
          onKeyDown={(e) => e.key === "Enter" && activate.mutate()}
        />
        <button
          disabled={activate.isPending || !code.trim()}
          onClick={() => activate.mutate()}
        >
          {activate.isPending ? "…" : "Receive"}
        </button>
      </div>

      <label className="field-label">Put in location (optional)</label>
      <select
        value={locationId}
        onChange={(e) => setLocationId(e.target.value)}
      >
        <option value="">No slot yet</option>
        {(locations.data ?? []).map((l) => (
          <option key={l.id} value={l.id}>
            {l.address}
          </option>
        ))}
      </select>

      <label
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginTop: 10,
        }}
      >
        <input
          type="checkbox"
          checked={damaged}
          onChange={(e) => setDamaged(e.target.checked)}
        />
        Arrived damaged (hold + open a damage issue)
      </label>

      {message && (
        <p className={message.startsWith("Received") ? "ok" : "error"}>
          {message}
        </p>
      )}

      <div className="briefing-stats" style={{ margin: "12px 0" }}>
        <span>
          <strong>{progress.preIssuedRemaining}</strong>
          awaiting arrival
        </span>
        <span>
          <strong>{damagedOpen.length}</strong>
          damaged
        </span>
        <span>
          <strong>{missingOpen.length}</strong>
          missing
        </span>
      </div>

      <div className="action-list">
        <button
          className="action-btn"
          disabled={reconcile.isPending || progress.preIssuedRemaining === 0}
          onClick={() => reconcile.mutate()}
        >
          {reconcile.isPending
            ? "Reconciling delivery…"
            : progress.preIssuedRemaining > 0
              ? `Reconcile delivery — flag ${progress.preIssuedRemaining} missing`
              : "All pre-issued units received"}
        </button>
        {flagged.length > 0 && (
          <Link to="/issues" className="action-btn">
            View damaged / missing issues ({flagged.length})
          </Link>
        )}
      </div>

      {flagged.length > 0 && (
        <ul className="unit-list work-list">
          {flagged.map((i) => (
            <li key={i.id} className="find-row">
              <strong style={{ color: "#ef4444" }}>{KIND_LABELS[i.kind]}</strong>
              <span className="muted"> {i.note ?? ""}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Foreman+ action: JOBSITE UNLOAD + condition report. Every loaded unit defaults
 * to “arrived OK”; flip any that arrived damaged. Submitting sends the OK units
 * to 'on_site' (ready to install) and holds the damaged ones (opening a
 * damage issue each). Optional location note is logged on the movement.
 */
function UnloadPanel({
  projectId,
  loaded,
}: {
  projectId: string;
  loaded: WindowUnit[];
}) {
  const queryClient = useQueryClient();
  const [damaged, setDamaged] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");

  const damagedIds = loaded.filter((u) => damaged.has(u.id)).map((u) => u.id);
  const okIds = loaded.filter((u) => !damaged.has(u.id)).map((u) => u.id);

  const unload = useMutation({
    mutationFn: () => unloadUnits(okIds, damagedIds, projectId, note),
    onSuccess: (res) => {
      setDamaged(new Set());
      setNote("");
      pushToast(
        `Unloaded ${res.unloaded} on site` +
          (res.damaged > 0 ? `, ${res.damaged} held damaged.` : "."),
        res.damaged > 0 ? "error" : "info",
      );
      queryClient.invalidateQueries({ queryKey: ["projectUnits", projectId] });
      queryClient.invalidateQueries({ queryKey: ["projectIssues", projectId] });
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      queryClient.invalidateQueries({ queryKey: ["reorderNeeds", projectId] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
    },
    onError: (e) => toastError(e),
  });

  if (loaded.length === 0) return null;

  return (
    <section className="detail-card" style={{ marginBottom: 16 }}>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Unload at the jobsite</h2>
        <span className={damagedIds.length > 0 ? "warn-text" : "ok"}>
          {damagedIds.length > 0 ? `${damagedIds.length} flagged` : "all OK"}
        </span>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        Confirm the truck arrived. Everything is marked good by default — flip any
        unit that showed up damaged. Good units become on-site &amp; ready to
        install; damaged units are held and reported.
      </p>

      <ul className="unit-list work-list">
        {loaded.map((u) => {
          const isDamaged = damaged.has(u.id);
          return (
            <li key={u.id} className="find-row">
              <Link to={`/w/${encodeURIComponent(u.window_id)}`}>
                <strong>{u.window_id}</strong>
              </Link>
              <span className="muted"> {u.window_types?.type_code}</span>
              <button
                className={isDamaged ? "action-btn" : "link"}
                style={{ marginLeft: "auto", color: isDamaged ? "#ef4444" : undefined }}
                onClick={() => setDamaged((s) => toggleSelected(s, u.id))}
              >
                {isDamaged ? "Damaged ✓" : "Flag damaged"}
              </button>
            </li>
          );
        })}
      </ul>

      <label className="field-label">Where on site (optional)</label>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. staged in garage"
      />

      <div className="action-list" style={{ marginTop: 12 }}>
        <button
          className="action-btn primary"
          disabled={unload.isPending}
          onClick={() => unload.mutate()}
        >
          {unload.isPending
            ? "Unloading…"
            : damagedIds.length > 0
              ? `Unload — ${okIds.length} OK, ${damagedIds.length} damaged`
              : `Confirm arrival — unload ${okIds.length}`}
        </button>
      </div>
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

/**
 * Pick list + one merged load-out for a run. Two modes over the same list:
 * Scan (scan units one at a time onto the truck — available to everyone) and
 * Select all (foreman+ multi-select a batch and load in one go). Keeps both
 * server actions: `loadWindow` per scan, `loadUnits` for the batch.
 */
function WarehouseTab({
  projectId,
  pickList,
  loaded,
  isLead,
}: {
  projectId: string;
  pickList: WindowUnit[];
  loaded: WindowUnit[];
  isLead: boolean;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"scan" | "select">("scan");
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const selectMode = mode === "select" && isLead;

  // Keep the batch selection in sync when units leave the pick list (loaded).
  const availableIds = useMemo(() => pickList.map((u) => u.id), [pickList]);
  const idsToLoad = selectedLoadableIds(pickList, selected);
  const allSelected = pickList.length > 0 && idsToLoad.length === pickList.length;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["projectUnits", projectId] });
    queryClient.invalidateQueries({ queryKey: ["inventory"] });
  };

  // Scan one unit onto the truck. The unit comes pre-resolved from the shared
  // scan helper; we only re-check it belongs here and is warehouse-ready.
  const loadScan = useMutation({
    mutationFn: async (unit: WindowUnit) => {
      if (unit.project_id !== projectId) {
        throw new Error(
          `${unit.window_id} belongs to ${unit.projects?.job_code ?? "no job"} — not this job!`,
        );
      }
      if (unit.status === "loaded") {
        throw new Error(`${unit.window_id} is already loaded.`);
      }
      if (unit.status !== "in_warehouse" && unit.status !== "staged") {
        throw new Error(
          `${unit.window_id} is not warehouse-ready to load (${STATUS_LABELS[unit.status]}).`,
        );
      }
      return loadWindow(unit.id);
    },
    onSuccess: (unit: WindowUnit) => {
      setScanMessage(`Loaded ${unit.window_id}`);
      invalidate();
    },
    onError: (e) => setScanMessage(formatApiError(e)),
  });

  const loadBatch = useMutation({
    mutationFn: () => loadUnits(idsToLoad, projectId),
    onSuccess: (loadedUnits) => {
      setSelected(new Set());
      pushToast(
        loadedUnits.length > 0
          ? `Loaded ${loadedUnits.length} unit${loadedUnits.length === 1 ? "" : "s"} for the run.`
          : "Nothing eligible to load.",
        "info",
      );
      invalidate();
    },
    onError: (e) => toastError(e),
  });

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(availableIds));
  };

  return (
    <>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Pick list ({pickList.length})</h2>
        {isLead && pickList.length > 0 && (
          <nav className="hub-tabs" aria-label="Load-out mode" style={{ margin: 0 }}>
            <button
              type="button"
              className={mode === "scan" ? "hub-tab active" : "hub-tab"}
              onClick={() => setMode("scan")}
            >
              Scan
            </button>
            <button
              type="button"
              className={mode === "select" ? "hub-tab active" : "hub-tab"}
              onClick={() => setMode("select")}
            >
              Select all
            </button>
          </nav>
        )}
      </div>

      {pickList.length > 0 && !selectMode && (
        <>
          <button
            className={scanning ? "" : "primary"}
            onClick={() => {
              setScanning(!scanning);
              setScanMessage(null);
            }}
          >
            {scanning ? "Stop load-out" : "Start load-out"}
          </button>
          {scanning && (
            <>
              <p className="scanner-hint">
                Scan each window as it goes on the truck. Wrong-job windows are
                rejected automatically.
              </p>
              {scanMessage && (
                <p className={scanMessage.startsWith("Loaded") ? "ok" : "error"}>
                  {scanMessage}
                </p>
              )}
              <Scanner
                onScan={async (payload) => {
                  const res = await resolveWindowFromScan(payload, windowLookups);
                  if (res.status === "ok") {
                    loadScan.mutate(res.unit);
                  } else if (res.status === "not-found") {
                    setScanMessage(`No window found for ${res.query}.`);
                  } else {
                    setScanMessage("That's a slot label — scan a window label.");
                  }
                }}
              />
            </>
          )}
        </>
      )}

      {selectMode && pickList.length > 0 && (
        <>
          <label
            style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}
          >
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            Select all ({pickList.length})
          </label>
          <div className="action-list">
            <button
              className="action-btn primary"
              disabled={idsToLoad.length === 0 || loadBatch.isPending}
              onClick={() => loadBatch.mutate()}
            >
              {loadBatch.isPending
                ? "Loading…"
                : `Load ${idsToLoad.length || ""} for run`.trim()}
            </button>
          </div>
        </>
      )}

      <ul className="unit-list work-list">
        {pickList.map((u) => (
          <li key={u.id} className="find-row">
            {selectMode ? (
              <label
                style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(u.id)}
                  onChange={() => setSelected((s) => toggleSelected(s, u.id))}
                />
                <strong>{u.window_id}</strong>
                <span className="muted"> {u.window_types?.type_code}</span>
                <span className="big-address">
                  {u.locations?.address ?? STATUS_LABELS[u.status]}
                </span>
              </label>
            ) : (
              <>
                <Link to={`/w/${encodeURIComponent(u.window_id)}`}>
                  <strong>{u.window_id}</strong>
                </Link>
                <span className="muted"> {u.window_types?.type_code}</span>
                <span className="big-address">
                  {u.locations?.address ?? STATUS_LABELS[u.status]}
                </span>
              </>
            )}
          </li>
        ))}
        {pickList.length === 0 && (
          <p className="muted">Nothing left in the warehouse for this job.</p>
        )}
      </ul>

      {loaded.length > 0 && (
        <>
          <h2>On truck ({loaded.length})</h2>
          <ul className="unit-list work-list">
            {loaded.map((u) => (
              <li key={u.id} className="find-row">
                <Link to={`/w/${encodeURIComponent(u.window_id)}`}>
                  {u.window_id}
                </Link>{" "}
                <span className="muted">{u.window_types?.type_code}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
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
        className="link"
        style={{ marginLeft: "auto" }}
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
