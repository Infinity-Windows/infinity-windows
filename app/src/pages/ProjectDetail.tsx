import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Scanner } from "../components/Scanner";
import {
  getProjectUnits,
  getProjectWindows,
  getWindowByWindowId,
  listProjects,
  loadWindow,
} from "../lib/api";
import { getMyProfile, listOpenings, saveJobEstimate } from "../lib/install/api";
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
import { STATUS_LABELS, type Project, type WindowUnit } from "../lib/types";
import { isLeadLike } from "../lib/install/types";
import { ProjectMap } from "./install/ProjectMap";
import { DispatchBoard } from "./install/DispatchBoard";

type HubTab = "overview" | "warehouse" | "map" | "brain" | "dispatch";

export function ProjectDetail() {
  const { projectId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: HubTab =
    tabParam === "warehouse" ||
    tabParam === "map" ||
    tabParam === "brain" ||
    tabParam === "dispatch"
      ? tabParam
      : "overview";

  useRealtimeOpenings(projectId);
  const myProfile = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const isLead = isLeadLike(myProfile.data?.role);

  const TABS: { id: HubTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    ...(isLead ? [{ id: "dispatch" as HubTab, label: "Dispatch" }] : []),
    { id: "warehouse", label: "Warehouse" },
    { id: "map", label: "Map" },
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
      </header>

      <nav className="hub-tabs" aria-label="Project sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? "hub-tab active" : "hub-tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

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
        <WarehouseTab
          projectId={projectId}
          pickList={pickList}
          loaded={loaded}
        />
      )}

      {tab === "dispatch" && isLead && <DispatchBoard projectId={projectId} />}

      {tab === "map" && <ProjectMap embedded />}

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
            <span>
              <strong>{formatHours(estimate.est.p90Minutes)}</strong> slow-case (P90)
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
          Upload planset
        </Link>
        <Link to={`/projects/${projectId}/review`} className="action-btn">
          Review openings
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

function WarehouseTab({
  projectId,
  pickList,
  loaded,
}: {
  projectId: string;
  pickList: WindowUnit[];
  loaded: WindowUnit[];
}) {
  const queryClient = useQueryClient();
  const [loadingOut, setLoadingOut] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  const loadScan = useMutation({
    mutationFn: async (windowId: string) => {
      const unit = await getWindowByWindowId(windowId);
      if (!unit) throw new Error(`Unknown window ${windowId}`);
      if (unit.project_id !== projectId) {
        throw new Error(
          `${windowId} belongs to ${unit.projects?.job_code ?? "no job"} — not this job!`,
        );
      }
      if (unit.status === "loaded") throw new Error(`${windowId} is already loaded.`);
      return loadWindow(unit.id);
    },
    onSuccess: (unit: WindowUnit) => {
      setScanMessage(`Loaded ${unit.window_id}`);
      queryClient.invalidateQueries({ queryKey: ["projectUnits", projectId] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => setScanMessage(String(e)),
  });

  return (
    <>
      <div className="row-between">
        <h2>Pick list ({pickList.length})</h2>
        <button
          className={loadingOut ? "" : "primary"}
          onClick={() => {
            setLoadingOut(!loadingOut);
            setScanMessage(null);
          }}
        >
          {loadingOut ? "Stop load-out" : "Start load-out"}
        </button>
      </div>

      {loadingOut && (
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
            onScan={(payload) => {
              if (payload.kind === "window") {
                loadScan.mutate(payload.windowId);
              } else {
                setScanMessage("That's a slot label — scan a window label.");
              }
            }}
          />
        </>
      )}

      <ul className="unit-list work-list">
        {pickList.map((u) => (
          <li key={u.id} className="find-row">
            <Link to={`/w/${encodeURIComponent(u.window_id)}`}>
              <strong>{u.window_id}</strong>
            </Link>
            <span className="muted"> {u.window_types?.type_code}</span>
            <span className="big-address">
              {u.locations?.address ?? STATUS_LABELS[u.status]}
            </span>
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
