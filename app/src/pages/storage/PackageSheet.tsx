// One package: what it is, where it sits, and every touch it ever had —
// the license plate's full life. Scanning a sticker lands here.

import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { listProjects } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import { BackChip } from "../../components/BackChip";
import { downloadPdf, packageLabelsPdf } from "../../lib/labels";
import {
  agingDays,
  CATEGORY_LABELS,
  getPackageBySerial,
  listContainers,
  listPackageEvents,
} from "../../lib/storage";

const EVENT_LABELS: Record<string, string> = {
  bound: "Assigned to its package",
  stored: "Checked in",
  moved: "Moved",
  checked_out: "Checked out",
};

export function PackageSheet() {
  const { serial = "" } = useParams();
  const pkg = useQuery({
    queryKey: ["storagePackage", serial],
    queryFn: () => getPackageBySerial(serial),
  });
  const events = useQuery({
    queryKey: ["packageEvents", pkg.data?.id],
    queryFn: () => listPackageEvents(pkg.data!.id),
    enabled: Boolean(pkg.data?.id),
  });
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const jobCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects.data ?? []) m.set(p.id, p.job_code);
    return m;
  }, [projects.data]);
  const containerName = (id: string | null) =>
    (containers.data ?? []).find((c) => c.id === id)?.name ?? null;

  const reprint = useMutation({
    mutationFn: async () => {
      if (!pkg.data) return;
      downloadPdf(
        await packageLabelsPdf([pkg.data]),
        `${pkg.data.serial}-sticker.pdf`,
      );
    },
  });

  if (pkg.isLoading) {
    return (
      <div className="page">
        <BackChip />
        <p className="muted">Loading…</p>
      </div>
    );
  }
  if (!pkg.data) {
    return (
      <div className="page">
        <BackChip />
        <p className="muted">No package with serial {serial}.</p>
      </div>
    );
  }

  const p = pkg.data;
  const days = agingDays(p.bound_at, new Date());
  const statusLine =
    p.status === "stored"
      ? `In ${containerName(p.container_id) ?? "storage"}`
      : p.status === "received"
        ? "Tagged — not stored yet"
        : p.status === "checked_out"
          ? "Checked out"
          : "Blank sticker";

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <BackChip />
          <p className="home-greeting">{p.short_code ?? "Package"}</p>
          <h1>{p.serial}</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {statusLine}
            {p.project_id ? ` · ${jobCode.get(p.project_id) ?? "?"}` : ""}
            {p.category ? ` · ${CATEGORY_LABELS[p.category]}` : ""}
            {days != null ? ` · tagged ${days}d ago` : ""}
          </p>
          {(p.package_marks ?? []).length > 0 && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Marks inside: {(p.package_marks ?? []).map((m) => m.mark_code).join(", ")}
            </p>
          )}
          {p.note && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>{p.note}</p>
          )}
        </div>
      </header>

      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        <button className="button-like" onClick={() => reprint.mutate()}>
          Reprint sticker
        </button>
      </div>

      <h2>History</h2>
      {events.isError && <p className="error">{formatApiError(events.error)}</p>}
      <div className="home-projects">
        {(events.data ?? []).map((e) => (
          <div key={e.id} className="project-card home-project">
            <div className="home-project-head">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {EVENT_LABELS[e.event] ?? e.event}
                  {e.container_id && ` — ${containerName(e.container_id) ?? "container"}`}
                  {e.event === "checked_out" && e.project_id
                    ? ` → ${jobCode.get(e.project_id) ?? "?"}`
                    : ""}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {new Date(e.created_at).toLocaleString()}
                  {e.reason ? ` · ${e.reason}` : ""}
                </div>
              </div>
            </div>
          </div>
        ))}
        {(events.data ?? []).length === 0 && <p className="muted">No history yet.</p>}
      </div>
    </div>
  );
}
