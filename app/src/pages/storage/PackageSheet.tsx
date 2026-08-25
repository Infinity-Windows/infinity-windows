// One package: what it is, where it sits, and every touch it ever had —
// the license plate's full life. Scanning a sticker lands here.

import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listLocations, listProjects } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { formatApiError } from "../../lib/errors";
import { BackChip } from "../../components/BackChip";
import { downloadPdf, packageLabelsPdf } from "../../lib/labels";
import { listJobModelRows } from "../../lib/modelstudio/projects";
import { placeWhere, toLocationsById } from "../../lib/warehouse/containment";
import { areaLabel, areaOptions, areaZoneOptions } from "../../lib/warehouse/areas";
import { bindLine } from "../../lib/warehouse/markPlan";
import { listScheduledMarks } from "../../lib/warehouse/warehouseCards";
// setPackageWindow rides the storage import below
import { setPackageAreaOffline, setPackageNoteOffline } from "../../lib/warehouse/offlineWrites";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isForemanPlus } from "../../lib/install/types";
import { pushToast } from "../../lib/toast";
import {
  type PartType,
  addPartTypeOption,
  deletePackages,
  listPartTypeOptions,
  setPackagePart,
  PART_TYPES,
  PART_LABELS,
  agingDays,
  assignPackageToJob,
  daysInStorage,
  reportMakerCount,
  setPackageWindow,
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
  // Job-building glow's door (#16): does THIS package's job even have a
  // Studio model to show it on? Same cheap all-jobs query StudioList.tsx
  // already runs, under the same key.
  const studioJobModels = useQuery({ queryKey: ["studioJobModels"], queryFn: listJobModelRows });
  const { effectiveRole } = useEffectiveRole();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const lead = isForemanPlus(effectiveRole);
  const [newPartType, setNewPartType] = useState("");
  const [partWarn, setPartWarn] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [spreadOffer, setSpreadOffer] = useState<{ count: number; type: string } | null>(null);
  const spread = useMutation({
    mutationFn: (args: { type: string }) =>
      setPackagePart(
        pkg.data?.id ?? "",
        pkg.data?.part_index ?? null,
        pkg.data?.part_total ?? null,
        args.type,
        true,
      ),
    onSuccess: () => {
      setSpreadOffer(null);
      setPartWarn(null);
      void qc.invalidateQueries({ queryKey: ["storagePackage", serial] });
    },
    onError: (e) => setPartWarn(formatApiError(e)),
  });
  const [deleteWarn, setDeleteWarn] = useState<string | null>(null);
  const partOptions = useQuery({
    queryKey: ["partTypeOptions"],
    queryFn: listPartTypeOptions,
  });
  const partChoices = [
    ...PART_TYPES,
    ...(partOptions.data ?? []).filter((t) => !PART_TYPES.includes(t as PartType)),
  ];
  const addType = useMutation({
    mutationFn: (name: string) => addPartTypeOption(name),
    onSuccess: () => {
      setNewPartType("");
      void qc.invalidateQueries({ queryKey: ["partTypeOptions"] });
    },
  });
  const partEdit = useMutation({
    mutationFn: (args: { index: number | null; total: number | null; type: string | null }) =>
      setPackagePart(pkg.data?.id ?? "", args.index, args.total, args.type),
    onSuccess: async (_res, args) => {
      void qc.invalidateQueries({ queryKey: ["storagePackage", serial] });
      setPartWarn(null);
      // Identical siblings (clone sets): same mark, same slot. Offer to
      // spread the label; warn about the slot-clash only when NOT spreading.
      setSpreadOffer(null);
      const mark = (pkg.data?.package_marks ?? [])[0]?.mark_code;
      if (mark && args.index != null && pkg.data?.project_id) {
        const { data: twins } = await supabase
          .from("packages")
          .select("id, part_type, package_marks!inner(mark_code)")
          .eq("project_id", pkg.data.project_id)
          .eq("part_index", args.index)
          .eq("package_marks.mark_code", mark)
          .neq("id", pkg.data?.id ?? "");
        const n = (twins ?? []).length;
        if (n > 0 && args.type) {
          setSpreadOffer({ count: n, type: args.type });
          setPartWarn(null);
        } else if (n > 0) {
          setPartWarn(
            `Heads up — #${mark} has ${n + 1} boxes labeled ${args.index} of ${args.total}. Identical clones? Fine. A mislabel? Fix the wrong one.`,
          );
        }
      }
    },
    onError: (e) => setPartWarn(formatApiError(e)),
  });
  const deleteOne = useMutation({
    mutationFn: () => deletePackages([pkg.data?.id ?? ""]),
    onSuccess: (r) => {
      if (r.refused.length > 0) {
        setDeleteWarn(r.refused[0].reason);
        return;
      }
      navigate("/warehouse");
    },
    onError: (e) => setDeleteWarn(formatApiError(e)),
  });
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

  // A custom note on the piece (owner ask). Any signed-in crew, same as the
  // maker-count flag below — offline-first for the same reason area is: it
  // gets written standing in the box.
  const [editingNote, setEditingNote] = useState(false);
  const [noteText, setNoteText] = useState("");
  const noteMutation = useMutation({
    mutationFn: (note: string | null) => setPackageNoteOffline(pkg.data?.id ?? "", note),
    onSuccess: (r) => {
      if (r.queued) {
        pushToast("Saved on this phone — goes up when you have signal.");
      }
      setEditingNote(false);
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
  const [makerCount, setMakerCount] = useState("");
  const maker = useMutation({
    mutationFn: (total: number | null) => {
      const n = total == null ? null : Math.trunc(total);
      if (n != null && (!Number.isFinite(n) || n < 1)) {
        throw new Error("A package count starts at 1");
      }
      return reportMakerCount(pkg.data!.id, n);
    },
    onSuccess: (row) => {
      pushToast(
        row.mfr_part_total == null
          ? "Cleared."
          : `Recorded — the maker says ${row.mfr_part_total}. The flag is up for the foreman.`,
      );
      setMakerCount("");
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
      void qc.invalidateQueries({ queryKey: ["storagePackage", serial] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });
  // The window fix-up (owner ask, 2026-08-18): a package tagged before the
  // worksheet existed carries no window, and a mis-typed one needs moving
  // without burning a live sticker. Offered only at zero-or-one window links —
  // a rare old multi-mark package should not be silently collapsed to one.
  const [settingWindow, setSettingWindow] = useState(false);
  const [windowPick, setWindowPick] = useState("");
  const jobMarks = useQuery({
    queryKey: ["scheduledMarks", [pkg.data?.project_id ?? ""]],
    queryFn: () => listScheduledMarks([pkg.data?.project_id ?? ""]),
    enabled: settingWindow && Boolean(pkg.data?.project_id),
  });
  const setWindow = useMutation({
    mutationFn: () => setPackageWindow(pkg.data!.id, windowPick),
    onSuccess: () => {
      pushToast(`Window set to #${windowPick.trim().toUpperCase()}.`);
      setSettingWindow(false);
      setWindowPick("");
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
      void qc.invalidateQueries({ queryKey: ["storagePackage", serial] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

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
  // Separate from "tagged Nd ago": a package can be bound for months while
  // passing through two or three containers, so this answers how long it's
  // sat where it is NOW, off the most recent 'stored' movement.
  const storedDays =
    p.status === "stored" ? daysInStorage(events.data ?? [], new Date()) : null;
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
              : p.pending_job_name
                ? ` · waiting for “${p.pending_job_name}”`
                : p.status !== "blank"
                  ? " · Boneyard"
                  : ""}
            {p.category ? ` · ${CATEGORY_LABELS[p.category]}` : ""}
            {p.piece_count != null
              ? ` · ${p.piece_count} piece${p.piece_count === 1 ? "" : "s"} inside`
              : ""}
            {days != null ? ` · tagged ${days}d ago` : ""}
            {storedDays != null ? ` · stored ${storedDays}d` : ""}
          </p>
          {p.status !== "blank" && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              {partLabel(p) ?? "No part number on label — treated as 1 of 1"}
              {p.mfr_mark ? ` · their #${p.mfr_mark}` : ""}
              {p.mfr_part_total != null && p.mfr_part_total !== p.part_total
                ? ` · maker's label says of ${p.mfr_part_total}`
                : ""}
            </p>
          )}
          {(p.package_marks ?? []).length > 0 && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Marks inside: {(p.package_marks ?? []).map((m) => m.mark_code).join(", ")}
            </p>
          )}
        </div>
      </header>

      {/* A custom note on this piece (owner ask) — shown prominently rather
          than as a muted aside, because it exists to flag something out of
          the ordinary. Any signed-in crew can add or change it. */}
      {p.status !== "blank" && (
        <div className="detail-card" style={{ marginTop: 8, padding: "10px 14px" }}>
          {editingNote ? (
            <>
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                maxLength={1000}
                rows={3}
                style={{ width: "100%", resize: "vertical" }}
                placeholder="Anything out of the ordinary about this piece"
                aria-label="Note on this package"
              />
              <div className="row-gap" style={{ marginTop: 6 }}>
                <button
                  className="button-like active-pill"
                  disabled={noteMutation.isPending}
                  onClick={() =>
                    noteMutation.mutate(noteText.trim() === "" ? null : noteText.trim())
                  }
                >
                  {noteMutation.isPending ? "Saving…" : "Save note"}
                </button>
                <button className="button-like" onClick={() => setEditingNote(false)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <p style={{ margin: 0, fontSize: 13.5 }}>
                {p.note ?? <span className="muted">No note on this piece.</span>}
              </p>
              <button
                className="button-like"
                style={{ marginTop: 6 }}
                onClick={() => {
                  setNoteText(p.note ?? "");
                  setEditingNote(true);
                }}
              >
                {p.note ? "Edit note" : "Add a note"}
              </button>
            </>
          )}
        </div>
      )}

      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        <button className="button-like" onClick={() => reprint.mutate()}>
          Reprint sticker
        </button>
        {/* The map (ticket 22): only when the box it sits in HAS a shell. */}
        {p.container_id &&
          containersById.get(p.container_id)?.studio_project_id && (
            <Link
              className="button-like"
              to={`/warehouse/3d/${p.container_id}?pkg=${encodeURIComponent(p.serial)}`}
            >
              See it in 3D
            </Link>
          )}
        {/* Job-building glow (#16): only when this package is tagged to a
            window AND that job actually has a Studio model to show it on. */}
        {p.project_id &&
          (p.package_marks ?? []).length > 0 &&
          (studioJobModels.data ?? []).some((m) => m.project_id === p.project_id) && (
            <Link
              className="button-like"
              to={`/projects/${p.project_id}/model?pkg=${encodeURIComponent(p.serial)}`}
            >
              Show on the building
            </Link>
          )}
        {lead && p.status !== "blank" && p.project_id == null && (
          <button className="button-like" onClick={() => setAssigning((v) => !v)}>
            {assigning ? "Cancel assign" : "Assign to job…"}
          </button>
        )}
        {lead &&
          p.status !== "blank" &&
          p.project_id != null &&
          (p.package_marks ?? []).length <= 1 && (
            <button className="button-like" onClick={() => setSettingWindow((v) => !v)}>
              {settingWindow
                ? "Cancel"
                : (p.package_marks ?? []).length === 0
                  ? "Set the window…"
                  : "Change the window…"}
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
      {settingWindow && p.project_id != null && (
        <div className="detail-card" style={{ marginTop: 8 }}>
          <p style={{ margin: 0, fontWeight: 600 }}>
            {(p.package_marks ?? []).length === 0
              ? "Which window is this part of?"
              : `Move it off #${(p.package_marks ?? [])[0]?.mark_code}?`}
          </p>
          <p className="muted" style={{ margin: "4px 0 8px", fontSize: 13 }}>
            The part fields stay as they are — only the window link moves, and
            the history says so. The number has to be on this job&rsquo;s
            schedule; the tag screen can add one that isn&rsquo;t.
          </p>
          <div className="row-gap" style={{ alignItems: "center" }}>
            <input
              placeholder="e.g. 6"
              value={windowPick}
              onChange={(e) => setWindowPick(e.target.value)}
              list="sheet-window-options"
              style={{ width: 110, marginBottom: 0 }}
              aria-label="Which window"
            />
            <datalist id="sheet-window-options">
              {(jobMarks.data ?? [])
                .map((m) => m.mark_code)
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                .map((m) => (
                  <option key={m} value={m} />
                ))}
            </datalist>
            <button
              className="button-like active-pill"
              disabled={windowPick.trim() === "" || setWindow.isPending}
              onClick={() => setWindow.mutate()}
            >
              {setWindow.isPending ? "Saving…" : "Set it"}
            </button>
          </div>
        </div>
      )}

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

      {p.status !== "blank" && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>
            Fix the part number or label
          </summary>
          <div className="detail-card" style={{ marginTop: 6 }}>
            <p className="muted" style={{ margin: "0 0 6px", fontSize: 12 }}>
              The boxes&rsquo; own printed labels decide the order — set this
              one to match what&rsquo;s written on it.
            </p>
            <div className="row-gap" style={{ flexWrap: "wrap", alignItems: "center" }}>
              {p.piece_count == null && (
                <>
                  <label className="field-label" style={{ margin: 0 }}>Part</label>
                  <select
                    value={p.part_index ?? ""}
                    onChange={(e) =>
                      partEdit.mutate({
                        index: e.target.value ? Number(e.target.value) : null,
                        total: e.target.value ? (p.part_total ?? Number(e.target.value)) : null,
                        type: p.part_type ?? null,
                      })
                    }
                  >
                    <option value="">—</option>
                    {Array.from({ length: 20 }, (_, n) => (
                      <option key={n + 1} value={n + 1}>{n + 1}</option>
                    ))}
                  </select>
                  <span className="muted">of</span>
                  <select
                    value={p.part_total ?? ""}
                    onChange={(e) =>
                      partEdit.mutate({
                        index: e.target.value ? (p.part_index ?? 1) : null,
                        total: e.target.value ? Number(e.target.value) : null,
                        type: p.part_type ?? null,
                      })
                    }
                  >
                    <option value="">—</option>
                    {Array.from({ length: 20 }, (_, n) => (
                      <option key={n + 1} value={n + 1}>{n + 1}</option>
                    ))}
                  </select>
                </>
              )}
              <label className="field-label" style={{ margin: 0 }}>Label</label>
              <select
                value={p.part_type ?? ""}
                onChange={(e) =>
                  partEdit.mutate({
                    index: p.part_index ?? null,
                    total: p.part_total ?? null,
                    type: e.target.value || null,
                  })
                }
              >
                <option value="">—</option>
                {partChoices.map((t) => (
                  <option key={t} value={t}>
                    {PART_LABELS[t as PartType] ?? t}
                  </option>
                ))}
              </select>
              <input
                value={newPartType}
                onChange={(e) => setNewPartType(e.target.value)}
                placeholder="Add a label, e.g. door handle"
                style={{ width: 180 }}
              />
              <button
                className="button-like"
                disabled={!newPartType.trim() || addType.isPending}
                onClick={() => addType.mutate(newPartType.trim())}
              >
                Add
              </button>
            </div>
            {spreadOffer && (
              <div className="row-gap" style={{ marginTop: 6, alignItems: "center" }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  {spreadOffer.count} other identical box
                  {spreadOffer.count === 1 ? "" : "es"} sit in this same slot.
                </span>
                <button
                  className="button-like"
                  disabled={spread.isPending}
                  onClick={() => spread.mutate({ type: spreadOffer.type })}
                >
                  {spread.isPending
                    ? "Applying…"
                    : `Label ${spreadOffer.count === 1 ? "it" : "them all"} "${spreadOffer.type}" too`}
                </button>
              </div>
            )}
            {partWarn && <p className="warn-text" style={{ fontSize: 12 }}>{partWarn}</p>}
          </div>
        </details>
      )}

      {lead && p.status !== "blank" && !confirmDelete && (
        <button
          className="link"
          style={{ color: "#c0392b", marginTop: 8 }}
          onClick={() => setConfirmDelete(true)}
        >
          Delete this package…
        </button>
      )}
      {confirmDelete && (
        <div
          className="detail-card"
          style={{ borderLeft: "3px solid #c0392b", marginTop: 8 }}
        >
          <p style={{ margin: 0, fontSize: 14 }}>
            Permanently delete <strong>{p.serial}</strong>
            {(p.package_marks ?? [])[0]
              ? ` (${(p.package_marks ?? [])[0].mark_code})`
              : ""}
            ? Its whole history goes with it. This can&rsquo;t be undone.
          </p>
          <div className="row-gap" style={{ marginTop: 8 }}>
            <button
              className="button-like"
              style={{ background: "#c0392b", color: "white" }}
              disabled={deleteOne.isPending}
              onClick={() => deleteOne.mutate()}
            >
              {deleteOne.isPending ? "Deleting…" : "Delete it — no way back"}
            </button>
            <button className="button-like" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
          </div>
          {deleteWarn && <p className="error">{deleteWarn}</p>}
        </div>
      )}

      {p.status !== "blank" && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>
            The maker&rsquo;s label disagrees?
          </summary>
          <div className="row-gap" style={{ marginTop: 6, alignItems: "center" }}>
            <label className="field-label" style={{ margin: 0 }}>
              Their label says this window ships as
            </label>
            <input
              inputMode="numeric"
              style={{ width: 70 }}
              placeholder={p.mfr_part_total != null ? String(p.mfr_part_total) : "how many?"}
              value={makerCount}
              onChange={(e) => setMakerCount(e.target.value)}
              aria-label="What the maker's label says"
            />
            <button
              className="button-like"
              disabled={maker.isPending || makerCount.trim() === ""}
              onClick={() => maker.mutate(Number(makerCount))}
            >
              Record it
            </button>
            {p.mfr_part_total != null && (
              <button
                className="button-like"
                disabled={maker.isPending}
                onClick={() => maker.mutate(null)}
              >
                Clear — misread
              </button>
            )}
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
            The maker wins the argument. A foreman burns the wrong labels and
            mints the right count; recording it here is what raises the flag.
          </p>
        </details>
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
          {/* Six zones (owner call): optional extra precision on a box that
              travels, never forced — the plain three above are always
              enough on their own. Empty for the building, so this whole
              block is silent there. */}
          {areaZoneOptions(containersById.get(p.container_id)).length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 6,
                marginTop: 6,
              }}
            >
              {areaZoneOptions(containersById.get(p.container_id)).map((a) => (
                <button
                  key={a}
                  className={p.area === a ? "button-like active-pill" : "button-like"}
                  disabled={setArea.isPending}
                  style={{ fontSize: 12.5, padding: "6px 4px" }}
                  onClick={() => setArea.mutate(p.area === a ? null : a)}
                >
                  {areaLabel(a)}
                </button>
              ))}
            </div>
          )}
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
                  {/* Who did it (owner ask) — falls back to the raw actor id
                      when the name can't be resolved, same rule Supplies.tsx
                      follows, so "who" is never silently dropped. */}
                  {e.actor ? ` by ${e.actor_name ?? e.actor}` : ""}
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
