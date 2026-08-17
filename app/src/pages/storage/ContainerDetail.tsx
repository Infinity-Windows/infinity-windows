// One container: the door poster's landing page. Manifest grouped by job
// with aging, the address + gate code at arm's reach, and CHECK IN — the
// no-camera multi-select the owner asked for: pick this container once,
// then tick packages as they're carried in.

import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listProjects } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import { isForemanPlus } from "../../lib/install/types";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { pushToast } from "../../lib/toast";
import { BackChip } from "../../components/BackChip";
import { containerPostersPdf, downloadPdf } from "../../lib/labels";
import { ContainerForm } from "./StorageHub";
import {
  agingDays,
  CATEGORY_LABELS,
  groupByJob,
  listActivePackages,
  listContainers,
  moveContainer,
  storePackages,
  type StoragePackage,
} from "../../lib/storage";
import { canNest, ridesAlong } from "../../lib/warehouse/containment";

export function ContainerDetail() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const [checkin, setCheckin] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);

  const container = (containers.data ?? []).find((c) => c.id === id) ?? null;
  const jobCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects.data ?? []) m.set(p.id, p.job_code);
    return m;
  }, [projects.data]);

  const stored = (packages.data ?? []).filter(
    (p) => p.status === "stored" && p.container_id === id,
  );
  /** Check-in candidates: tagged but nowhere yet, or stored in ANOTHER
   * container (ticking one of those is a transfer — it re-stores here). */
  const candidates = (packages.data ?? []).filter(
    (p) =>
      (p.status === "received" && !p.container_id) ||
      (p.status === "stored" && p.container_id !== id) ||
      (p.status === "checked_out"),
  );

  const store = useMutation({
    mutationFn: () => storePackages([...picked], id),
    onSuccess: (n) => {
      pushToast(`${n} package${n === 1 ? "" : "s"} checked in.`);
      setPicked(new Set());
      setCheckin(false);
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const poster = useMutation({
    mutationFn: async () => {
      if (!container) return;
      downloadPdf(await containerPostersPdf([container]), `${container.serial}-poster.pdf`);
    },
  });

  // Everything that would ride along if this container moved — the honest
  // count on the move buttons: one action, N packages.
  const riders = ridesAlong(id, packages.data ?? [], containers.data ?? []);
  const parent = (containers.data ?? []).find(
    (c) => c.id === container?.parent_container_id,
  );
  const children = (containers.data ?? []).filter((c) => c.parent_container_id === id);
  const nestTargets = (containers.data ?? []).filter(
    (c) => c.active && canNest(id, c.id, containers.data ?? []),
  );

  const move = useMutation({
    mutationFn: (parentContainerId: string | null) =>
      moveContainer({ containerId: id, parentContainerId }),
    onSuccess: (_c, dest) => {
      const n = riders.length;
      pushToast(
        dest
          ? `Moved — ${n} package${n === 1 ? "" : "s"} rode along.`
          : `Out on its own — ${n} package${n === 1 ? "" : "s"} rode along.`,
      );
      setMoving(false);
      void qc.invalidateQueries({ queryKey: ["storageContainers"] });
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  if (!container) {
    return (
      <div className="page">
        <BackChip />
        <p className="muted">
          {containers.isLoading ? "Loading…" : "Container not found."}
        </p>
      </div>
    );
  }

  const row = (p: StoragePackage, extra?: string) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontWeight: 600 }}>
        {p.serial}
        {p.short_code ? ` · ${p.short_code}` : ""}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        {jobCode.get(p.project_id ?? "") ?? "no job"}
        {p.category ? ` · ${CATEGORY_LABELS[p.category]}` : ""}
        {(p.package_marks ?? []).length > 0 &&
          ` · marks ${(p.package_marks ?? []).map((m) => m.mark_code).join(", ")}`}
        {extra ? ` · ${extra}` : ""}
      </div>
    </div>
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <BackChip />
          <p className="home-greeting">{container.serial}</p>
          <h1>{container.name}</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {container.address ?? "no address on file"}
            {container.access_code ? ` · code ${container.access_code}` : ""}
            {parent ? ` · inside ${parent.name}` : ""}
          </p>
          {children.length > 0 && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Holding: {children.map((c) => c.name).join(", ")}
            </p>
          )}
          {container.notes && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>{container.notes}</p>
          )}
        </div>
      </header>

      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        <button
          className={checkin ? "button-like" : "button-like active-pill"}
          onClick={() => setCheckin((v) => !v)}
        >
          {checkin ? "Done checking in" : "Check in packages"}
        </button>
        <button className="button-like" onClick={() => poster.mutate()}>
          Print poster
        </button>
        <button className="button-like" onClick={() => setMoving((v) => !v)}>
          {moving ? "Cancel move" : "Move"}
        </button>
        {lead && (
          <button className="button-like" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>

      {moving && (
        <>
          <h2>Move {container.name}</h2>
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
            Everything inside moves with it — {riders.length} package
            {riders.length === 1 ? "" : "s"}
            {children.length > 0
              ? ` (including what's in ${children.map((c) => c.name).join(", ")})`
              : ""}{" "}
            in one action. One level only: a crate can sit in a conex, never in
            another crate.
          </p>
          <div className="row-gap" style={{ flexWrap: "wrap" }}>
            {nestTargets.map((c) => (
              <button
                key={c.id}
                className="button-like"
                disabled={move.isPending}
                onClick={() => move.mutate(c.id)}
              >
                Into {c.name}
              </button>
            ))}
            {parent && (
              <button
                className="button-like"
                disabled={move.isPending}
                onClick={() => move.mutate(null)}
              >
                Out of {parent.name} — on its own
              </button>
            )}
            {nestTargets.length === 0 && !parent && (
              <p className="muted" style={{ fontSize: 12 }}>
                Nowhere to move it — every other container is nested or holds
                containers of its own.
              </p>
            )}
          </div>
        </>
      )}

      {checkin && (
        <>
          <h2>Tick packages as they go in</h2>
          {candidates.length === 0 && (
            <p className="muted">Nothing waiting — tag packages at the truck first.</p>
          )}
          <div className="home-projects">
            {candidates.map((p) => {
              const on = picked.has(p.id);
              const from =
                p.status === "stored"
                  ? `moving from ${
                      (containers.data ?? []).find((c) => c.id === p.container_id)?.name ?? "?"
                    }`
                  : p.status === "checked_out"
                    ? "coming back in"
                    : undefined;
              return (
                <button
                  key={p.id}
                  className="project-card home-project"
                  style={{ textAlign: "left" }}
                  onClick={() =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(p.id)) next.delete(p.id);
                      else next.add(p.id);
                      return next;
                    })
                  }
                >
                  <div className="home-project-head">
                    {row(p, from)}
                    <span style={{ fontSize: 20 }}>{on ? "☑" : "☐"}</span>
                  </div>
                </button>
              );
            })}
          </div>
          <button
            className="button-like active-pill"
            disabled={picked.size === 0 || store.isPending}
            onClick={() => store.mutate()}
          >
            {store.isPending ? "Storing…" : `Store ${picked.size} here`}
          </button>
        </>
      )}

      <h2>Inside now ({stored.length})</h2>
      {groupByJob(stored).map((g) => (
        <div key={g.projectId ?? "none"} style={{ marginBottom: 10 }}>
          <p className="tcx-label" style={{ margin: "6px 0 4px" }}>
            {jobCode.get(g.projectId ?? "") ?? "No job"} · {g.packages.length}
          </p>
          <div className="home-projects">
            {g.packages.map((p) => {
              const days = agingDays(p.bound_at, new Date());
              return (
                <Link key={p.id} to={`/pkg/${p.serial}`} className="project-card home-project">
                  <div className="home-project-head">
                    {row(p, days != null ? `${days}d in storage` : undefined)}
                    <span className="muted">›</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
      {stored.length === 0 && <p className="muted">Empty.</p>}

      {editing && (
        <ContainerForm
          initial={container}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void qc.invalidateQueries({ queryKey: ["storageContainers"] });
          }}
        />
      )}
    </div>
  );
}
