// One package: what it is, where it sits, and every touch it ever had —
// the license plate's full life. Scanning a sticker lands here.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listLocations, listProjects } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { formatApiError } from "../../lib/errors";
import { BackChip } from "../../components/BackChip";
import { ConfirmDanger } from "../../components/ConfirmDanger";
import { ContainerBadge } from "../../components/warehouse/ContainerBadge";
import { StageChip } from "../../components/warehouse/StageChip";
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
import { enqueueUpload, subscribeSynced } from "../../lib/offline/outbox";
import {
  setPieceCount,
  type PartType,
  addPartTypeOption,
  deletePackages,
  listPackagePhotos,
  listPartTypeOptions,
  packagePhotoPath,
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
  // Photos (pick 28): snapped at check-in or any time from here on out.
  const photos = useQuery({
    queryKey: ["packagePhotos", pkg.data?.id],
    queryFn: () => listPackagePhotos(pkg.data!.id),
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
  const [poolPieces, setPoolPieces] = useState("");
  const cratePool = useQuery({
    queryKey: ["cratePool", pkg.data?.project_id ?? pkg.data?.pending_job_name ?? ""],
    enabled: pkg.data?.part_type === "crate",
    queryFn: async () => {
      let q = supabase
        .from("packages")
        .select("id, piece_count, part_type, mfr_mark")
        .not("piece_count", "is", null)
        .neq("status", "blank");
      q = pkg.data?.project_id
        ? q.eq("project_id", pkg.data.project_id)
        : q.eq("pending_job_name", pkg.data?.pending_job_name ?? "");
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((r) => ({
        id: r.id as string,
        piece_count: r.piece_count as number,
        part_type: r.part_type as string | null,
        mark: (r.mfr_mark as string | null) ?? null,
      }));
    },
  });
  const crateCountQ = useQuery({
    queryKey: ["crateCount", pkg.data?.project_id ?? pkg.data?.pending_job_name ?? ""],
    enabled: pkg.data?.part_type === "crate",
    queryFn: async () => {
      let q = supabase
        .from("packages")
        .select("id", { count: "exact", head: true })
        .eq("part_type", "crate")
        .neq("status", "blank");
      q = pkg.data?.project_id
        ? q.eq("project_id", pkg.data.project_id)
        : q.eq("pending_job_name", pkg.data?.pending_job_name ?? "");
      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
  });
  const crateCount = crateCountQ.data ?? 1;
  const poolTotal = (cratePool.data ?? []).reduce((s, r) => s + r.piece_count, 0);
  const pieceEdit = useMutation({
    mutationFn: (n: number) => setPieceCount(pkg.data?.id ?? "", n),
    onSuccess: () => {
      setPartWarn(null);
      void qc.invalidateQueries({ queryKey: ["storagePackage", serial] });
    },
    onError: (e) => setPartWarn(formatApiError(e)),
  });
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

  // Photos (pick 28): queued through the same outbox op job photos use
  // (photo_upload) — "Add a photo" has no already-happening online call to
  // ride along with, so both the row and the bytes need to survive a dead
  // conex wall together. See lib/storage.ts's package-photos section.
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [viewerPhoto, setViewerPhoto] = useState<{ signedUrl: string | null; createdAt: string } | null>(
    null,
  );

  useEffect(() => {
    return subscribeSynced(() => {
      void qc.invalidateQueries({ queryKey: ["packagePhotos"] });
    });
  }, [qc]);

  const addPhotos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
    e.target.value = "";
    const packageId = pkg.data?.id;
    if (files.length === 0 || !packageId) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const createdBy = (await supabase.auth.getUser()).data.user?.email ?? null;
      for (const file of files) {
        const rand = Math.random().toString(16).slice(2, 8);
        await enqueueUpload({
          kind: "photo",
          bucket: "install-media",
          path: packagePhotoPath(packageId, Date.now(), rand),
          contentType: file.type || "image/jpeg",
          packageId,
          createdBy,
          blob: file,
        });
      }
      pushToast(
        `${files.length} photo${files.length === 1 ? "" : "s"} saved — syncing in the background.`,
      );
      void qc.invalidateQueries({ queryKey: ["packagePhotos", packageId] });
    } catch (err) {
      // Same voice as the ticket-11 damage photo path: a failed enqueue
      // (storage quota, a file too large) says so rather than vanishing.
      setPhotoError(formatApiError(err));
    } finally {
      setPhotoBusy(false);
    }
  };

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
          {/* The name the crew saved, not the serial (owner, 2026-08-25):
              "Don Timpson Res #1: 1/2". The serial stays on the line below —
              it is still the scannable identity. */}
          <h1>
            {(() => {
              const jobLine = p.project_id
                ? (jobCode.get(p.project_id) ?? null)
                : (p.pending_job_name ?? null);
              const mark =
                (p.package_marks ?? [])[0]?.mark_code ?? p.mfr_mark ?? null;
              if (!mark) return p.serial;
              const part =
                p.piece_count != null
                  ? `${p.piece_count} pc ${p.part_type ?? "glass"}`
                  : p.part_index != null && p.part_total != null
                    ? `${p.part_index}/${p.part_total}`
                    : null;
              return `${jobLine ? `${jobLine} ` : ""}#${mark}${part ? `: ${part}` : ""}`;
            })()}
          </h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {p.serial} ·{" "}
            {/* Pick 1: the "on the way" line gets the Expected color — same
                words, no other status line names a literal stage word. */}
            {p.status === "minted" ? (
              <StageChip stage="minted">{statusLine}</StageChip>
            ) : (
              statusLine
            )}
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

      {/* Photos (pick 28): condition on arrival, where it sits, anything
          worth a picture. A blank sticker has no life yet, so no photos. */}
      {p.status !== "blank" && (
        <div className="detail-card wh-card">
          <div className="wh-row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>Photos</h2>
            <label className="action-btn primary photos-add" style={{ cursor: "pointer" }}>
              {photoBusy ? "Saving…" : "Add a photo"}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                disabled={photoBusy}
                style={{ display: "none" }}
                onChange={(e) => void addPhotos(e)}
              />
            </label>
          </div>
          {photoError && <p className="error" style={{ fontSize: 12.5 }}>{photoError}</p>}
          {(photos.data ?? []).length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
              No photos on this piece yet.
            </p>
          ) : (
            <div className="photos-grid" style={{ marginTop: 6 }}>
              {(photos.data ?? []).map((ph) => (
                <button
                  key={ph.id}
                  type="button"
                  className="photo-card"
                  onClick={() => setViewerPhoto({ signedUrl: ph.signedUrl, createdAt: ph.createdAt })}
                >
                  {ph.signedUrl ? (
                    <img src={ph.signedUrl} alt="Package photo" loading="lazy" />
                  ) : (
                    <div className="photo-card-missing muted">Unavailable offline</div>
                  )}
                  <span className="photo-card-meta">
                    <span className="photo-card-time">
                      {new Date(ph.createdAt).toLocaleDateString()}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <PackageGroup id="what" title="What it is" defaultOpen>
        {p.status !== "blank" && (
          <div className="detail-card wh-card">
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
                <div className="wh-row" style={{ marginTop: 6 }}>
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

        {p.status !== "blank" && p.piece_count != null && (
          <div className="detail-card wh-card">
            <label className="field-label" htmlFor="pool-pieces">
              Pieces of {p.part_type ?? "glass"} still in the crates for this set
            </label>
            <div className="wh-row">
              <input
                id="pool-pieces"
                type="number"
                min={1}
                max={99}
                value={poolPieces || String(p.piece_count ?? "")}
                onChange={(e) => setPoolPieces(e.target.value)}
                style={{ width: 90 }}
              />
              <button
                className="button-like"
                disabled={pieceEdit.isPending || !poolPieces.trim()}
                onClick={() => pieceEdit.mutate(Number(poolPieces))}
              >
                {pieceEdit.isPending ? "Saving…" : "Save"}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                Edit down as the glass gets used. All used up? Delete this row.
              </span>
            </div>
          </div>
        )}

        {p.part_type === "crate" && (
          <div className="detail-card wh-card">
            <h2 style={{ marginTop: 0, fontSize: 16 }}>
              Sealed crate — nothing goes in or out
            </h2>
            {cratePool.isLoading ? (
              <p className="muted">Reading the job&rsquo;s crate pool…</p>
            ) : (cratePool.data ?? []).length === 0 ? (
              <p className="muted">No crate glass listed for this job.</p>
            ) : (
              <>
                <p className="muted" style={{ margin: "0 0 4px", fontSize: 13 }}>
                  Between this job&rsquo;s {crateCount} crate{crateCount === 1 ? "" : "s"}:{" "}
                  {poolTotal} piece{poolTotal === 1 ? "" : "s"} in all. Which piece
                  rides in which crate isn&rsquo;t tracked — the crates share one pool.
                </p>
                <ul className="unit-list">
                  {(cratePool.data ?? []).map((r) => (
                    <li key={r.id}>
                      #{r.mark ?? "?"} — {r.piece_count} {r.part_type ?? "glass"}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </PackageGroup>

      <PackageGroup id="where" title="Where it is" defaultOpen>
        <div className="row-gap">
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
        </div>

        {/* Where in the box (ticket 14, ADR-0006). Foreman+, and only while the
            package is actually IN a box — the options come from what kind of box
            it is, so a re-parkable conex never offers a compass. */}
        {lead && p.status === "stored" && p.container_id && (
          <div style={{ marginTop: 10 }}>
            <label className="field-label row-gap" style={{ alignItems: "center" }}>
              {/* Pick 5: the container's own badge, not a new lookup — same
                  color this container wears on the hub tile and its own
                  header. */}
              {containersById.get(p.container_id) && (
                <ContainerBadge
                  name={containersById.get(p.container_id)!.name}
                  serial={containersById.get(p.container_id)!.serial}
                />
              )}
              Where in {containersById.get(p.container_id)?.name ?? "the box"}
            </label>
            <div className="row-gap">
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
      </PackageGroup>

      <PackageGroup id="fix" title="Fix things" defaultOpen={false}>
        <div className="row-gap">
          <button className="button-like" onClick={() => reprint.mutate()}>
            Reprint sticker
          </button>
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
        </div>
        {settingWindow && p.project_id != null && (
          <div className="detail-card wh-card">
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
            <div className="wh-row">
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
          <div className="detail-card wh-card">
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
            <div className="wh-row" style={{ marginTop: 8 }}>
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

        {p.status !== "blank" && p.part_type !== "crate" && p.piece_count == null && (
          <details style={{ marginTop: 8 }}>
            <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>
              Fix the part number or label
            </summary>
            <div className="detail-card wh-card">
              <p className="muted" style={{ margin: "0 0 6px", fontSize: 12 }}>
                The boxes&rsquo; own printed labels decide the order — set this
                one to match what&rsquo;s written on it.
              </p>
              <div className="wh-row">
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
                <div className="wh-row" style={{ marginTop: 6 }}>
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

        {p.status !== "blank" && (
          <details style={{ marginTop: 8 }}>
            <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>
              The maker&rsquo;s label disagrees?
            </summary>
            <div className="wh-row" style={{ marginTop: 6 }}>
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
      </PackageGroup>

      <PackageGroup id="danger" title="Danger" defaultOpen={false}>
        {/* Burn: minted only — the server refuses anything with a life behind
            it, and this button does not even offer. Foreman+, two taps. */}
        {lead && p.status === "minted" && !confirmBurn && (
          <button className="button-like" onClick={() => setConfirmBurn(true)}>
            Burn this label…
          </button>
        )}
        {confirmBurn && p.status === "minted" && (
          <ConfirmDanger
            confirmText={burn.isPending ? "Burning…" : "Delete forever"}
            disabled={burn.isPending}
            onConfirm={() => burn.mutate()}
            onCancel={() => setConfirmBurn(false)}
          >
            This burns away label{" "}
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
          </ConfirmDanger>
        )}

        {lead && p.status !== "blank" && !confirmDelete && (
          <button
            className="link"
            style={{ color: "var(--danger)", marginTop: 8 }}
            onClick={() => setConfirmDelete(true)}
          >
            Delete this package…
          </button>
        )}
        {confirmDelete && (
          <ConfirmDanger
            confirmText={deleteOne.isPending ? "Deleting…" : "Delete forever"}
            disabled={deleteOne.isPending}
            onConfirm={() => deleteOne.mutate()}
            onCancel={() => setConfirmDelete(false)}
            footer={deleteWarn && <p className="error">{deleteWarn}</p>}
          >
            {p.part_type === "crate"
              ? "Breaking up this crate throws it away for good — it stops existing. The job's pool numbers stay until you edit or delete them as the glass gets used. "
              : ""}
            Permanently delete <strong>{p.serial}</strong>
            {(p.package_marks ?? [])[0]
              ? ` (${(p.package_marks ?? [])[0].mark_code})`
              : ""}
            ? Its whole history goes with it. This can&rsquo;t be undone.
          </ConfirmDanger>
        )}
      </PackageGroup>

      <h2>History</h2>
      {events.isError && <p className="error">{formatApiError(events.error)}</p>}
      <div className="home-projects">
        {(events.data ?? []).map((e) => (
          <div key={e.id} className="project-card home-project">
            <div className="home-project-head">
              <div className="wh-row-main">
                <div className="wh-row-title">
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
                <div className="wh-row-sub">
                  {new Date(e.created_at).toLocaleString()}
                  {e.reason ? ` · ${e.reason}` : ""}
                </div>
              </div>
            </div>
          </div>
        ))}
        {(events.data ?? []).length === 0 && <p className="muted">No history yet.</p>}
      </div>
      {viewerPhoto && (
        <div
          className="photo-viewer-backdrop overlay-enter"
          role="dialog"
          aria-modal="true"
          onClick={() => setViewerPhoto(null)}
        >
          <div className="photo-viewer" onClick={(e) => e.stopPropagation()}>
            {viewerPhoto.signedUrl ? (
              <img src={viewerPhoto.signedUrl} alt="Package photo, full size" />
            ) : (
              <div className="photo-card-missing muted">Image unavailable offline.</div>
            )}
            <div className="photo-viewer-info">
              <p className="muted">
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(viewerPhoto.createdAt))}
              </p>
            </div>
            <button
              type="button"
              className="action-btn photo-viewer-close"
              onClick={() => setViewerPhoto(null)}
            >
              Close
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

const GROUP_KEY_PREFIX = "pkg-sheet-group:";

/** Same safe-localStorage shape as Explain's readOpen (components/ui/Explain.tsx)
 * — a private-mode/storage-disabled phone still gets a working fold, it just
 * won't remember which way you left it. */
function readGroupOpen(id: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(GROUP_KEY_PREFIX + id);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

/**
 * One of the sheet's four rooms (ticket 21 — "~8 stacked sections" folded
 * into What it is / Where it is / Fix things / Danger). Existing JSX moved
 * into these bodies unchanged; nothing about a control's logic, test id, or
 * aria-label changed, only which room it stands in.
 */
function PackageGroup({
  id,
  title,
  defaultOpen,
  children,
}: {
  id: string;
  title: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readGroupOpen(id, defaultOpen));
  return (
    <details
      className="pkg-sheet-group"
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        try {
          localStorage.setItem(GROUP_KEY_PREFIX + id, next ? "1" : "0");
        } catch {
          // Private mode / storage disabled — the room still works, it just
          // won't be remembered next visit.
        }
      }}
    >
      <summary>{title}</summary>
      <div className="pkg-sheet-group-body">{children}</div>
    </details>
  );
}
