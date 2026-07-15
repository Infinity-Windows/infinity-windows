import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Scanner } from "../components/Scanner";
import {
  getProjectUnits,
  getProjectWindows,
  getWindowByWindowId,
  listProjects,
  loadWindow,
} from "../lib/api";
import { STATUS_LABELS, type WindowUnit } from "../lib/types";

export function ProjectDetail() {
  const { projectId = "" } = useParams();
  const queryClient = useQueryClient();
  const [loadingOut, setLoadingOut] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

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

  // Pick list: warehouse units sorted by slot address = natural walk order.
  const pickList = useMemo(() => {
    return (units.data ?? [])
      .filter((u) => u.status === "in_warehouse" || u.status === "staged")
      .sort((a, b) =>
        (a.locations?.address ?? "~").localeCompare(b.locations?.address ?? "~"),
      );
  }, [units.data]);

  const loaded = (units.data ?? []).filter((u) => u.status === "loaded");
  const installed = (units.data ?? []).filter((u) => u.status === "installed");

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

  const neededTotal = (needs.data ?? []).reduce((sum, n) => sum + n.quantity, 0);

  return (
    <div className="page">
      <header className="page-header">
        <h1>{project?.job_code ?? "Job"}</h1>
      </header>
      <p className="muted">{project?.name} {project?.address}</p>

      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-num">{units.data?.length ?? "-"}</span>
          <span>assigned of {neededTotal} needed</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{pickList.length}</span>
          <span>in warehouse</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{loaded.length}</span>
          <span>on truck</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{installed.length}</span>
          <span>installed</span>
        </div>
      </div>

      <h2>Needed (by type)</h2>
      <ul className="unit-list">
        {(needs.data ?? []).map((n) => {
          const have = (units.data ?? []).filter(
            (u) => u.window_type_id === n.window_type_id,
          ).length;
          return (
            <li key={n.id}>
              <strong>{n.window_types?.type_code}</strong>{" "}
              {n.window_types?.name}{" "}
              <span className={have >= n.quantity ? "ok" : "warn-text"}>
                {have}/{n.quantity}
              </span>
            </li>
          );
        })}
      </ul>

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

      <ul className="unit-list">
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
          <ul className="unit-list">
            {loaded.map((u) => (
              <li key={u.id}>
                <Link to={`/w/${encodeURIComponent(u.window_id)}`}>
                  {u.window_id}
                </Link>{" "}
                <span className="muted">{u.window_types?.type_code}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
