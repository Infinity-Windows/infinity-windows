// One package: what it is, where it sits, and every touch it ever had —
// the license plate's full life. Scanning a sticker lands here.

import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listLocations, listProjects } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import { BackChip } from "../../components/BackChip";
import { downloadPdf, packageLabelsPdf } from "../../lib/labels";
import { placeWhere, toLocationsById } from "../../lib/warehouse/containment";
import { areaLabel, areaOptions } from "../../lib/warehouse/areas";
import { bindLine } from "../../lib/warehouse/markPlan";
import { listScheduledMarks } from "../../lib/warehouse/warehouseCards";
import { setPackageAreaOffline } from "../../lib/warehouse/offlineWrites";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isForemanPlus } from "../../lib/install/types";
import { pushToast } from "../../lib/toast";
import {
  agingDays,
  assignPackageToJob,
  burnPackages,
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
  const navigate = useNavigate();
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
      const row = pkg.data;
      const mark = (row.package_marks ?? [])[0]?.mark_code;
      // The reprinted paper says what the record knows (ticket 16): the job —
      // or BONEYARD — the window and the part. A bare serial on a re-stuck
      // sticker made somebody walk back to a screen to learn what it was.
      const line =
        row.status === "blank"
          ? null
          : bindLine(
              row.project_id ? (jobCode.get(row.project_id) ?? null) : "BONEYARD",
              mark ?? "?",
              row.part_index ?? null,
              row.part_total ?? null,
            );
      downloadPdf(
        await packageLabelsPdf([{ ...row, bindLine: line }]),
        `${row.serial}-sticker.pdf`,
      );
      pushToast("Destroy the old sticker so there aren't two.", "info");
    },
  });

  const burn = useMutation({
    mutationFn: () => burnPackages([pkg.data!.id]),
    onSuccess: () => {
      pushToast(
        "Label burned. Destroy the paper — anything still wearing it scans as nothing.",
      );
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
      navigate(-1);
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });
  const [confirmBurn, setConfirmBurn] = useState(false);
  // Assign to job (ticket 18): the Boneyard's one exit. Open only on boneyard
  // rows; the server refuses everything else anyway.
  const [assigning, setAssigning] = useState(false);
  const [assignJob, setAssignJob] = useState("");
  const [assignMark, setAssignMark] = useState("");
  const assignMarks = useQuery({
    queryKey: ["scheduledMarks", [assignJob]],
    queryFn: () => listScheduledMarks([assignJob]),
    enabled: Boolean(assignJob),
  });
  const assign = useMutation({
    mutationFn: () =>
      assignPackageToJob({
        packageId: pkg.data!.id,
        projectId: assignJob,
        markCode: assignMark,
      }),
    onSuccess: (row) => {
      const code = row.project_id ? (jobCode.get(row.project_id) ?? "the job") : "the job";
      pushToast(`Assigned to ${code} as window ${assignMark}.`);
      setAssigning(false);
      setAssignJob("");
      setAssignMark("");
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
      void qc.invalidateQueries({ queryKey: ["storagePackage", serial] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
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
            {/* Boneyard = tagged company stock, project null ON PURPOSE
                (ticket 17). A finished job's packages keep their job — the
                two must never blur (audit F9). A blank sticker is neither. */}
            {p.project_id
              ? ` · ${jobCode.get(p.project_id) ?? "?"}`
              : p.status !== "blank"
                ? " · Boneyard"
                : ""}
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
        {lead && p.status !== "blank" && p.project_id == null && (
          <button className="button-like" onClick={() => setAssigning((v) => !v)}>
            {assigning ? "Cancel assign" : "Assign to job…"}
          </button>
        )}
        {/* Burn: minted only — the server refuses anything with a life behind
            it, and this button does not even offer. Foreman+, two taps. */}
        {lead && p.status === "minted" && !confirmBurn && (
          <button className="button-like" onClick={() => setConfirmBurn(true)}>
            Burn this label…
          </button>
        )}
      </div>
      {assigning && p.project_id == null && (
        <div className="detail-card" style={{ marginTop: 8 }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Out of the Boneyard</p>
          <p className="muted" style={{ margin: "4px 0 8px", fontSize: 13 }}>
            Putting this on a job changes what that job expects. The sticker
            keeps scanning — printing a fresh label after is offered, never
            required.
          </p>
          <label className="field-label">Job</label>
          <select
            value={assignJob}
            onChange={(e) => {
              setAssignJob(e.target.value);
              setAssignMark("");
            }}
          >
            <option value="">Pick the job…</option>
            {(projects.data ?? []).map((j) => (
              <option key={j.id} value={j.id}>
                {j.job_code} — {j.name}
              </option>
            ))}
          </select>
          {assignJob && (
            <>
              <label className="field-label">Which window</label>
              <select value={assignMark} onChange={(e) => setAssignMark(e.target.value)}>
                <option value="">Pick the window…</option>
                {(assignMarks.data ?? [])
                  .map((m) => m.mark_code)
                  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                  .map((m) => (
                    <option key={m} value={m}>
                      Window {m}
                    </option>
                  ))}
              </select>
              {assignMarks.isSuccess && (assignMarks.data ?? []).length === 0 && (
                <p className="muted" style={{ fontSize: 12.5 }}>
                  That job has no windows on its schedule yet — they come from
                  the plans at spec review.
                </p>
              )}
            </>
          )}
          <div className="row-gap" style={{ marginTop: 8 }}>
            <button
              className="button-like active-pill"
              disabled={!assignJob || !assignMark || assign.isPending}
              onClick={() => assign.mutate()}
            >
              {assign.isPending ? "Assigning…" : "Assign"}
            </button>
            {pkg.data && (
              <button className="button-like" onClick={() => reprint.mutate()}>
                Print updated label
              </button>
            )}
          </div>
        </div>
      )}

      {confirmBurn && p.status === "minted" && (
        <div
          className="detail-card"
          style={{ borderLeft: "3px solid #c0392b", marginTop: 8 }}
        >
          <p style={{ margin: 0, fontSize: 14 }}>
            This throws away label{" "}
            <strong>
              {p.part_index != null && p.part_total != null
                ? `${p.part_index} of ${p.part_total}`
                : p.serial}
            </strong>
            {(p.package_marks ?? [])[0]
              ? ` for window ${(p.package_marks ?? [])[0].mark_code}`
              : ""}
            . The serial dies and the part slot reopens. Destroy the paper —
            anything still wearing it will scan as nothing.
          </p>
          <div className="row-gap" style={{ marginTop: 8 }}>
            <button
              className="button-like"
              style={{ background: "#c0392b", color: "white" }}
              disabled={burn.isPending}
              onClick={() => burn.mutate()}
            >
              {burn.isPending ? "Burning…" : "Burn it — no way back"}
            </button>
            <button className="button-like" onClick={() => setConfirmBurn(false)}>
              Keep it
            </button>
          </div>
        </div>
      )}

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
