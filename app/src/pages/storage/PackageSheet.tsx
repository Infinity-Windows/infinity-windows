// One package: what it is, where it sits, and every touch it ever had —
// the license plate's full life. Scanning a sticker lands here.

import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listLocations, listProjects } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import { BackChip } from "../../components/BackChip";
import { downloadPdf, packageLabelsPdf } from "../../lib/labels";
import { placeWhere, toLocationsById } from "../../lib/warehouse/containment";
import { areaLabel, areaOptions } from "../../lib/warehouse/areas";
import { setPackageAreaOffline } from "../../lib/warehouse/offlineWrites";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isForemanPlus } from "../../lib/install/types";
import { pushToast } from "../../lib/toast";
import {
  agingDays,
  CATEGORY_LABELS,
  getPackageBySerial,
  listContainers,
  listPackageEvents,
  partLabel,
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
  // Racks and staging bays, so a package set aside for a job says so by name.
  const locations = useQuery({ queryKey: ["locations"], queryFn: listLocations });
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const qc = useQueryClient();
  const setArea = useMutation({
    // Offline-first like every warehouse write: pointing at a package happens
    // standing inside the box, which is exactly where the bars are not.
    mutationFn: (area: string | null) =>
      setPackageAreaOffline(pkg.data?.id ?? "", area),
    onSuccess: (r) => {
      if (r.queued) {
        pushToast("Saved on this phone — goes up when you have signal.");
      }
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
      void qc.invalidateQueries({ queryKey: ["storagePackage", serial] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const containersById = useMemo(
    () => new Map((containers.data ?? []).map((c) => [c.id, c])),
    [containers.data],
  );
  const locsById = useMemo(
    () => toLocationsById(locations.data ?? []),
    [locations.data],
  );

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
  // The same "where is it" sentence the Find bar gives, from the same
  // function. This used to be hand-rolled here and only knew about
  // containers, so a package staged on a job's bay — no container, a bay for
  // a location — fell through to the literal word "storage".
  const statusLine =
    p.status === "stored"
      ? placeWhere(p, containersById, locsById)
      : p.status === "received"
        ? "Tagged — not stored yet"
        : p.status === "checked_out"
          ? "Checked out"
          : p.status === "minted"
            ? "On the way — label printed, material not arrived"
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
          {p.status !== "blank" && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              {partLabel(p) ?? "No part number on label — treated as 1 of 1"}
              {p.mfr_mark ? ` · their #${p.mfr_mark}` : ""}
            </p>
          )}
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

      {/* Where in the box (ticket 14, ADR-0006). Foreman+, and only while the
          package is actually IN a box — the options come from what kind of box
          it is, so a re-parkable conex never offers a compass. */}
      {lead && p.status === "stored" && p.container_id && (
        <div style={{ marginTop: 10 }}>
          <label className="field-label">
            Where in {containersById.get(p.container_id)?.name ?? "the box"}
          </label>
          <div className="row-gap" style={{ flexWrap: "wrap" }}>
            {areaOptions(containersById.get(p.container_id)).map((a) => (
              <button
                key={a}
                className={p.area === a ? "button-like active-pill" : "button-like"}
                disabled={setArea.isPending}
                onClick={() => setArea.mutate(p.area === a ? null : a)}
              >
                {areaLabel(a)}
              </button>
            ))}
          </div>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
            A rough pointer, not a slot — it clears on its own the moment the
            package moves. Tap again to unset.
          </p>
        </div>
      )}

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
