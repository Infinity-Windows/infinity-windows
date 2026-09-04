// One container: the door poster's landing page. Manifest grouped by job
// with aging, the address + gate code at arm's reach, and CHECK IN — the
// no-camera multi-select the owner asked for: pick this container once,
// then tick packages as they're carried in.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listLocations, listProjects, listProjectsAnyStatus } from "../../lib/api";
import { Explain } from "../../components/ui/Explain";
import { EmptyState } from "../../components/ui/States";
import { containerTrailLine } from "../../lib/warehouse/containerTrail";
import { buildShellSerialized, shellDims, shellName } from "../../lib/modelstudio/shell";
import { saveStudioProject } from "../../lib/modelstudio/projects";
import { ContainerBadge } from "../../components/warehouse/ContainerBadge";
import { StationChip } from "../../components/warehouse/StationChip";
import { PackageRowText } from "../../components/warehouse/PackageRowText";
import { formatApiError } from "../../lib/errors";
import { isForemanPlus, isSupervisorPlus } from "../../lib/install/types";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { pushToast } from "../../lib/toast";
import { showUndoToast } from "../../lib/undoToast";
import { playErrorTone, playSuccessTone } from "../../lib/sound";
import { useScanWedge } from "../../lib/warehouse/scanWedge";
import { BackChip } from "../../components/BackChip";
import { containerPostersPdf, downloadPdf } from "../../lib/labels";
import { ContainerForm } from "../../components/warehouse/ContainerForm";
import {
  addPartTypeOption,
  customCheckin,
  listPartTypeOptions,
  PART_TYPES,
  PART_LABELS,
  type PartType,
  deletePackages,
  agingDays,
  groupByJob,
  listActivePackages,
  listContainers,
  listContainerMovements,
  posterAutoOpenPath,
  renamePackage,
  saveContainer,
  setContainerModel,
  setPackagePart,
  type StoragePackage,
  containerKind,
  unstorePackages,
} from "../../lib/storage";
import { canNest, ridesAlong } from "../../lib/warehouse/containment";
import { splitLinesOnStore } from "../../lib/warehouse/splitUnits";
import { STATION_PUT_AWAY } from "../../lib/warehouse/stations";
import {
  moveContainerOffline,
  storePackagesOffline,
  writeToast,
} from "../../lib/warehouse/offlineWrites";

/**
 * Why archiving is blocked, in words a foreman can act on — or null when the
 * container is genuinely empty and the button should work (ticket D5).
 *
 * Two rules, one message. Packages come first because they are the thing that
 * actually goes missing: the container list only reads active rows, so
 * archiving a full conex hides every package inside it from the grid, the
 * search and the posters at once. A container inside this one blocks too — an
 * empty crate is still something in the way, and archiving around it would
 * leave the crate naming a parent nobody can open.
 *
 * The container is named rather than called "this conex" on purpose: the same
 * page runs for conexes, crates and the warehouse itself.
 *
 * `packageCount` is null when the package list has not come back yet — still
 * loading, or the read failed. That is NOT the same as zero, and treating it
 * as zero is how a full conex gets archived: the page shows an empty manifest
 * either way, and archiving is the one action here the app cannot undo. An
 * unknown count blocks.
 */
export function archiveBlockMessage(
  containerName: string,
  packageCount: number | null,
  childNames: string[] = [],
): string | null {
  if (packageCount === null) {
    return `Still loading what is in ${containerName}. Wait for the list before you archive it.`;
  }
  if (packageCount > 0) {
    return packageCount === 1
      ? `1 package is still in ${containerName}. Move it out before you archive it.`
      : `${packageCount} packages are still in ${containerName}. Move them out before you archive it.`;
  }
  if (childNames.length > 0) {
    const list =
      childNames.length === 1
        ? childNames[0]
        : `${childNames.slice(0, -1).join(", ")} and ${childNames[childNames.length - 1]}`;
    return `${containerName} still holds ${list}. Move ${
      childNames.length === 1 ? "it" : "them"
    } out before you archive it.`;
  }
  return null;
}

/**
 * What the move button says afterwards.
 *
 * Named where it went rather than just "Moved", because a conex and three
 * crates all answer to that button and the person who tapped it is usually
 * looking at the packages, not the header. And it goes through `writeToast`
 * so a move made inside a conex with no bars says the one thing that is
 * different about it: the container is where they put it, and the record of
 * that is still on the phone.
 */
export function movedMessage(
  destName: string | null,
  riders: number,
  queued: boolean,
): string {
  const riding = `${riders} package${riders === 1 ? "" : "s"} rode along`;
  const where = destName ? `Moved into ${destName}` : "Out on its own";
  return writeToast({ count: riders, queued }, `${where}, ${riding}`);
}

export function ContainerDetail() {
  // Pick 30: a desk-mounted hardware scanner routes straight to the package
  // or container it reads, same as the camera flow.
  useScanWedge();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  // Foreman+ gates one thing on this page now: the sweep-delete below.
  // Registering, renaming and archiving a container is warehouse work and
  // belongs to whoever is standing in front of it (ADR-0007).
  const lead = isForemanPlus(effectiveRole);
  const [sweeping, setSweeping] = useState(false);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [customForm, setCustomForm] = useState({
    projectId: "",
    mark: "",
    partType: "",
    otherText: "",
    newLabel: "",
    note: "",
    count: 1,
  });
  // The pencil on a contents row (owner, 2026-08-26): the row's headline is
  // the package's real name now, and the crew fixes a wrong one right here —
  // waiting-job text, mark, piece numbers, what-is-it — without leaving the
  // container. Empty strings mean "clear it"; the form opens pre-filled.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameForm, setRenameForm] = useState({
    pending: "",
    mark: "",
    partIndex: "",
    partTotal: "",
    partType: "",
    otherText: "",
  });
  const partOptions = useQuery({
    queryKey: ["partTypeOptions"],
    queryFn: listPartTypeOptions,
  });
  const partChoices = [
    ...PART_TYPES,
    ...(partOptions.data ?? []).filter(
      (t) => !PART_TYPES.includes(t as PartType),
    ),
  ];
  const addLabel = useMutation({
    mutationFn: (name: string) => addPartTypeOption(name),
    onSuccess: (name) => {
      setCustomForm((prev) => ({ ...prev, partType: name, newLabel: "" }));
      void qc.invalidateQueries({ queryKey: ["partTypeOptions"] });
    },
  });

  const openRename = (p: StoragePackage) => {
    setRenaming(p.id);
    setRenameForm({
      pending: p.pending_job_name ?? "",
      mark: ((p.package_marks ?? [])[0]?.mark_code ?? p.mfr_mark) ?? "",
      partIndex: p.part_index != null ? String(p.part_index) : "",
      partTotal: p.part_total != null ? String(p.part_total) : "",
      partType: p.part_type ?? "",
      otherText: "",
    });
  };

  const saveRename = useMutation({
    mutationFn: async (p: StoragePackage) => {
      const boundMarks = (p.package_marks ?? []).length > 0;
      const prior = {
        pending: p.pending_job_name ?? null,
        mark: p.mfr_mark ?? null,
        partIndex: p.part_index ?? null,
        partTotal: p.part_total ?? null,
        partType: p.part_type ?? null,
      };
      const nextPending = p.project_id != null ? null : renameForm.pending.trim() || null;
      const nextMark = boundMarks ? (p.mfr_mark ?? null) : renameForm.mark.trim() || null;
      const idx = renameForm.partIndex.trim() === "" ? null : Number(renameForm.partIndex);
      const total = renameForm.partTotal.trim() === "" ? null : Number(renameForm.partTotal);
      const nextType =
        renameForm.partType === "other" && renameForm.otherText.trim()
          ? renameForm.otherText.trim().toLowerCase()
          : renameForm.partType || null;

      const nameChanged = nextPending !== prior.pending || nextMark !== prior.mark;
      // Pool rows keep their piece editor on the sheet — the fraction fields
      // are hidden for them, so parts only change on ordinary boxes.
      const partChanged =
        p.piece_count == null &&
        (idx !== prior.partIndex || total !== prior.partTotal || nextType !== prior.partType);

      if (nameChanged) await renamePackage(p.id, nextPending, nextMark);
      if (partChanged) {
        if (nextType && !partChoices.includes(nextType)) {
          // Teach the dropdown the new word, same as custom check-in does.
          await addPartTypeOption(nextType).catch(() => undefined);
        }
        await setPackagePart(p.id, idx, total, nextType, false);
      }
      return { p, prior, nameChanged, partChanged };
    },
    onSuccess: ({ p, prior, nameChanged, partChanged }) => {
      setRenaming(null);
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
      void qc.invalidateQueries({ queryKey: ["partTypeOptions"] });
      if (!nameChanged && !partChanged) return;
      showUndoToast({
        message: "Renamed.",
        undo: async () => {
          if (nameChanged) await renamePackage(p.id, prior.pending, prior.mark);
          if (partChanged) {
            await setPackagePart(p.id, prior.partIndex, prior.partTotal, prior.partType, false);
          }
          void qc.invalidateQueries({ queryKey: ["storagePackages"] });
        },
      });
    },
    onError: (e) => {
      playErrorTone();
      pushToast(formatApiError(e), "error");
    },
  });
  const doCheckin = useMutation({
    mutationFn: async () => {
      // Pick 25: custom_checkin returns only a count, never the rows it made
      // (no migration this wave may touch that). A before/after read of the
      // one thing that DOES carry ids stands in — a fresh read, not the
      // cache, so a package someone else stored here a moment ago is never
      // mistaken for one this tap just created.
      const before = new Set((await listActivePackages()).map((p) => p.id));
      const n = await customCheckin({
        containerId: id,
        projectId: customForm.projectId || null,
        mark: customForm.mark.trim() || null,
        partType:
          customForm.partType === "other" && customForm.otherText.trim()
            ? customForm.otherText.trim()
            : customForm.partType || null,
        note: customForm.note.trim() || null,
        count: customForm.count,
      });
      return { n, before };
    },
    onSuccess: async ({ n, before }) => {
      const doneMessage = `Checked ${n} in${customForm.mark.trim() ? ` on set #${customForm.mark.trim().replace(/^#/, "").toUpperCase()}` : ""}.`;
      setCheckinOpen(false);
      setCustomForm({ projectId: "", mark: "", partType: "", otherText: "", newLabel: "", note: "", count: 1 });
      void qc.invalidateQueries({ queryKey: ["storageContainers"] });
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
      const after = await listActivePackages();
      const createdIds = after
        .filter((p) => p.container_id === id && !before.has(p.id))
        .map((p) => p.id);
      if (createdIds.length > 0) {
        // The toast carries the confirmation AND the undo — a second, plain
        // copy of the same sentence sitting on the page behind it would just
        // be the scattered pattern pick 25 exists to replace.
        showUndoToast({
          message: doneMessage,
          undo: async () => {
            const r = await deletePackages(createdIds);
            void qc.invalidateQueries({ queryKey: ["storageContainers"] });
            void qc.invalidateQueries({ queryKey: ["storagePackages"] });
            if (r.refused.length > 0) {
              throw new Error(r.refused.map((x) => `${x.serial} (${x.reason})`).join("; "));
            }
            pushToast("Check-in undone.");
          },
        });
      } else {
        // No ids to undo (a genuine edge case — see the comment above on
        // `before`) — fall back to the plain confirmation so the tap still
        // says something.
        setSweepReport(doneMessage);
      }
    },
    onError: (e) => setSweepReport(formatApiError(e)),
  });
  const [swept, setSwept] = useState<Set<string>>(new Set());
  const [sweepReport, setSweepReport] = useState<string | null>(null);
  const sweepDelete = useMutation({
    mutationFn: (ids: string[]) => deletePackages(ids),
    onSuccess: (r) => {
      setSweeping(false);
      setSwept(new Set());
      setSweepReport(
        r.refused.length === 0
          ? `Deleted ${r.deleted} package${r.deleted === 1 ? "" : "s"} for good.`
          : `Deleted ${r.deleted}. Couldn't delete ${r.refused
              .map((x) => `${x.serial} (${x.reason})`)
              .join("; ")}`,
      );
      void qc.invalidateQueries({ queryKey: ["storageContainers"] });
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => setSweepReport(formatApiError(e)),
  });
  const canModel = isSupervisorPlus(effectiveRole);
  // The 3D shell (ticket 22, first slice): dims form state, prefilled from
  // the row or the standard box the moment the panel opens.
  const [modeling, setModeling] = useState(false);
  const [shellDimsText, setShellDimsText] = useState({ l: "", w: "", h: "" });
  const makeShell = useMutation({
    mutationFn: async () => {
      const c = container!;
      const dims = {
        lengthCm: Number(shellDimsText.l),
        widthCm: Number(shellDimsText.w),
        heightCm: Number(shellDimsText.h),
      };
      if (
        !Number.isFinite(dims.lengthCm) || dims.lengthCm <= 0 ||
        !Number.isFinite(dims.widthCm) || dims.widthCm <= 0 ||
        !Number.isFinite(dims.heightCm) || dims.heightCm <= 0
      ) {
        throw new Error("A shell needs all three measurements, in centimeters.");
      }
      // The container learns its measurements the moment somebody types them
      // — the record should not stay dumber than the drawing.
      await saveContainer({
        id: c.id,
        name: c.name,
        address: c.address,
        accessCode: c.access_code,
        notes: c.notes,
        active: c.active,
        lengthCm: dims.lengthCm,
        widthCm: dims.widthCm,
        heightCm: dims.heightCm,
        weightKg: c.weight_kg ?? null,
      });
      const project = await saveStudioProject({
        name: shellName(c),
        model: {
          serialized: buildShellSerialized(dims),
          savedAt: new Date().toISOString(),
        },
      });
      await setContainerModel(c.id, project.id);
      return project.id;
    },
    onSuccess: (studioId) => {
      pushToast("Shell created — opening it in the Studio.");
      void qc.invalidateQueries({ queryKey: ["storageContainers"] });
      navigate(`/studio/p/${studioId}`);
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  // Finished jobs keep naming their material (owner ask, 2026-08-26): the
  // NAME map reads every job; the custom check-in picker stays active-only.
  const projectsAll = useQuery({ queryKey: ["projectsAll"], queryFn: listProjectsAnyStatus });
  // Where this box has been (ticket 13). Its own key per container, so opening
  // Conex 7 never shows Conex 3's travels out of a shared cache entry.
  const trail = useQuery({
    queryKey: ["containerMovements", id],
    queryFn: () => listContainerMovements(id),
  });
  const locations = useQuery({ queryKey: ["locations"], queryFn: listLocations });
  const [checkin, setCheckin] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const container = (containers.data ?? []).find((c) => c.id === id) ?? null;

  // Pick 31: a poster scan (Scan.tsx tags the landing `?from=poster`) skips
  // straight to the 3D shell once the container is in hand, when it has one.
  // Runs once per landing, not on every container edit — a shell created
  // mid-visit should not yank a foreman out of the page they are looking at.
  useEffect(() => {
    const path = posterAutoOpenPath(container, searchParams.get("from"));
    if (path) navigate(path, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container?.id, container?.studio_project_id]);

  const jobCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projectsAll.data ?? []) m.set(p.id, p.job_code);
    return m;
  }, [projectsAll.data]);
  // Shared by the trail below and the store-time split warning — one build,
  // not two copies of the same lookup drifting apart.
  const containersById = useMemo(
    () => new Map((containers.data ?? []).map((c) => [c.id, c])),
    [containers.data],
  );
  const locationsById = useMemo(
    () => new Map((locations.data ?? []).map((l) => [l.id, l])),
    [locations.data],
  );

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
  // The store-time half of ticket 19 (owner call): warn, never block, the
  // same way checkout already does — just read from the other direction.
  const storeSplits = useMemo(
    () => splitLinesOnStore(picked, packages.data ?? [], id, containersById, locationsById),
    [picked, packages.data, id, containersById, locationsById],
  );

  const store = useMutation({
    // The ROWS, not the ids. Each one carries what this screen believed about
    // the package when it was ticked, and that note rides with the write so a
    // check-in that waits out a dead conex cannot land on top of something
    // newer (warehouse audit F2). Picked ids with no row left are dropped
    // rather than sent noteless — the list they came from is the same query.
    mutationFn: async () => {
      const rows = candidates.filter((p) => picked.has(p.id));
      // Ticks whose package left the candidate list between picking and
      // pressing — stored by someone else, checked back out, whatever moved
      // under us. Dropped from the write (their note would be stale), but
      // SAID, never skipped silently (owner report, 2026-08-26).
      const dropped = picked.size - rows.length;
      return { r: await storePackagesOffline(rows, id), rows, dropped };
    },
    onSuccess: ({ r, rows, dropped }) => {
      playSuccessTone();
      // Pick 25: the ids this tap picked — same rows the write itself used.
      const ids = rows.map((p) => p.id);
      setPicked(new Set());
      setCheckin(false);
      setSweepReport(
        dropped > 0
          ? `${dropped} tick${dropped === 1 ? "" : "s"} changed since you picked ${dropped === 1 ? "it" : "them"} — checked in the other ${r.count}. Look the list over again.`
          : null,
      );
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
      // A queued write hasn't reached the server yet — there is nothing
      // there for unstore to undo until it does, so it keeps the plain
      // toast; the toast below carries BOTH the confirmation and the undo
      // for the ordinary online case, rather than showing the same line
      // twice.
      if (r.queued) {
        pushToast(
          writeToast(r, `${r.count} package${r.count === 1 ? "" : "s"} checked in`),
        );
        return;
      }
      showUndoToast({
        message: `${r.count} package${r.count === 1 ? "" : "s"} checked in`,
        undo: async () => {
          await unstorePackages(ids);
          void qc.invalidateQueries({ queryKey: ["storagePackages"] });
        },
      });
    },
    onError: (e) => {
      playErrorTone();
      pushToast(formatApiError(e), "error");
    },
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
      moveContainerOffline({ containerId: id, parentContainerId }),
    onSuccess: (r, dest) => {
      const destName =
        (containers.data ?? []).find((c) => c.id === dest)?.name ?? null;
      pushToast(movedMessage(destName, riders.length, r.queued));
      setMoving(false);
      void qc.invalidateQueries({ queryKey: ["storageContainers"] });
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  // What stands between this container and the archive, if anything. Uses the
  // same `riders` count the Move button shows, so "what's inside" means one
  // thing on this page rather than two — and passes null, not 0, until that
  // list has actually arrived, so a slow or failed read cannot read as empty.
  const archiveBlock = container
    ? archiveBlockMessage(
        container.name,
        packages.data ? riders.length : null,
        children.map((c) => c.name),
      )
    : null;

  const archive = useMutation({
    mutationFn: async () => {
      if (!container) return;
      // The rule lives here, not only on the button: a hidden button is a
      // habit, a refused write is a rule.
      if (archiveBlock) throw new Error(archiveBlock);
      // save_storage_container overwrites the whole row, so the untouched
      // fields go back exactly as they came — sending only `active` would
      // wipe the address and the gate code.
      await saveContainer({
        id: container.id,
        name: container.name,
        address: container.address,
        accessCode: container.access_code,
        notes: container.notes,
        active: false,
      });
    },
    onSuccess: () => {
      pushToast(`${container?.name ?? "Container"} archived.`);
      void qc.invalidateQueries({ queryKey: ["storageContainers"] });
      // The list only reads active containers, so this page has nothing left
      // to show — staying here would flash "Container not found."
      navigate("/warehouse");
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
    <PackageRowText p={p} jobCode={jobCode} extra={extra} />
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <BackChip />
          <p className="home-greeting">{container.serial}</p>
          <h1 className="row-gap" style={{ alignItems: "center" }}>
            <ContainerBadge name={container.name} serial={container.serial} />
            {container.name}
          </h1>
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
      <StationChip station={STATION_PUT_AWAY} />

      <div className="row-gap">
        <button
          className={checkin ? "button-like" : "button-like active-pill"}
          onClick={() => setCheckin((v) => !v)}
        >
          {checkin ? "Done checking in" : "Check in packages"}
        </button>
        <button className="button-like" onClick={() => poster.mutate()}>
          Print poster
        </button>
        {/* The building never moves — no button, matching the server's refusal. */}
        {containerKind(container) !== "building" && (
          <button className="button-like" onClick={() => setMoving((v) => !v)}>
            {moving ? "Cancel move" : "Move"}
          </button>
        )}
        <button className="button-like" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button className="button-like" onClick={() => setArchiving((v) => !v)}>
          {archiving ? "Cancel archive" : "Archive container"}
        </button>
      </div>

      {archiving && (
        <>
          <h2>Archive {container.name}</h2>
          {archiveBlock ? (
            <p className="error" style={{ margin: "0 0 8px" }}>
              {archiveBlock}
            </p>
          ) : (
            <>
              <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
                It comes off the container grid and out of the poster and
                sticker lists. Nothing that happened here is deleted — every
                package keeps its history. Bringing it back is not something
                this screen can do, so archive it when it is done for good.
              </p>
              <button
                className="button-like active-pill"
                disabled={archive.isPending}
                onClick={() => archive.mutate()}
              >
                {archive.isPending ? "Archiving…" : `Archive ${container.name}`}
              </button>
            </>
          )}
        </>
      )}

      {moving && (
        <>
          <h2>Move {container.name}</h2>
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
            Everything inside moves with it — {riders.length} package
            {riders.length === 1 ? "" : "s"}
            {children.length > 0
              ? ` (including what's in ${children.map((c) => c.name).join(", ")})`
              : ""}{" "}
            in one action. One level only, and the box's kind sets the rules: a
            crate rides in a conex or on a truck, a conex only rides on a truck,
            and nothing goes inside a crate.
          </p>
          <div className="row-gap">
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
              <p className="wh-row-sub">
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
          {/* Store-time half of the split warning (ticket 19, owner call):
              same heads-up checkout gives, read the other direction. Shown
              while the picks can still change, never blocking the button
              below — splitting a unit is sometimes the job. */}
          {storeSplits.length > 0 && (
            <div className="detail-card wh-card">
              {storeSplits.map((line) => (
                <p key={line} style={{ margin: "4px 0", fontSize: 13.5 }}>
                  {line}
                </p>
              ))}
              <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
                Sometimes that&rsquo;s the job — this is a heads-up, not a stop.
              </p>
            </div>
          )}
          <button
            className="button-like active-pill"
            disabled={picked.size === 0 || store.isPending}
            onClick={() => store.mutate()}
          >
            {store.isPending ? "Storing…" : `Store ${picked.size} here`}
          </button>
        </>
      )}

      <div className="row-between">
        <h2 style={{ marginBottom: 0 }}>Inside now ({stored.length})</h2>
        <button className="link" onClick={() => setCheckinOpen((v) => !v)}>
          {checkinOpen ? "Close check-in" : "Custom check-in…"}
        </button>
        {lead && stored.length > 0 && (
          <button
            className="link"
            onClick={() => {
              setSweeping((v) => !v);
              setSwept(new Set());
              setSweepReport(null);
            }}
          >
            {sweeping ? "Cancel" : "Delete several…"}
          </button>
        )}
      </div>
      {sweeping && (
        <div className="wh-row" style={{ margin: "6px 0" }}>
          <button
            className="link"
            onClick={() => setSwept(new Set(stored.map((p) => p.id)))}
          >
            Select all
          </button>
          <button
            className="button-like"
            style={{ background: "var(--danger)", color: "var(--ink)" }}
            disabled={swept.size === 0 || sweepDelete.isPending}
            onClick={() => {
              const ok = window.confirm(
                `Permanently delete ${swept.size} package${swept.size === 1 ? "" : "s"} from ${container.name}? Their history goes with them. This can't be undone.`,
              );
              if (ok) sweepDelete.mutate([...swept]);
            }}
          >
            {sweepDelete.isPending ? "Deleting…" : `Delete ${swept.size} selected`}
          </button>
        </div>
      )}
      {checkinOpen && (
        <div className="detail-card" style={{ margin: "6px 0" }}>
          <p className="muted" style={{ margin: "0 0 6px", fontSize: 13 }}>
            Something in hand that no list predicted? Check it in right here —
            job optional, any label, and a mark attaches it to a set wherever
            that set&rsquo;s other pieces sit.
          </p>
          <div className="wh-row">
            <select
              value={customForm.count}
              onChange={(e) =>
                setCustomForm((prev) => ({ ...prev, count: Number(e.target.value) }))
              }
              aria-label="How many to check in"
            >
              {Array.from({ length: 20 }, (_, n) => (
                <option key={n + 1} value={n + 1}>
                  {n + 1}
                </option>
              ))}
            </select>
            <select
              value={customForm.projectId}
              onChange={(e) =>
                setCustomForm((prev) => ({ ...prev, projectId: e.target.value }))
              }
              aria-label="Which job"
            >
              <option value="">No job</option>
              {(projects.data ?? []).map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.job_code ?? pr.name}
                </option>
              ))}
            </select>
            <input
              value={customForm.mark}
              onChange={(e) => setCustomForm((prev) => ({ ...prev, mark: e.target.value }))}
              placeholder="Set mark, e.g. 16 (optional)"
              aria-label="Attach to set"
              style={{ width: 180 }}
            />
            <select
              value={customForm.partType}
              onChange={(e) =>
                setCustomForm((prev) => ({ ...prev, partType: e.target.value }))
              }
              aria-label="What is it"
            >
              <option value="">— what is it? —</option>
              {partChoices.map((t) => (
                <option key={t} value={t}>
                  {PART_LABELS[t as PartType] ?? t}
                </option>
              ))}
            </select>
            {customForm.partType === "other" && (
              <input
                value={customForm.otherText}
                onChange={(e) =>
                  setCustomForm((prev) => ({ ...prev, otherText: e.target.value }))
                }
                placeholder="Type what it is"
                aria-label="Describe what it is"
                style={{ width: 180 }}
              />
            )}
            <input
              value={customForm.newLabel}
              onChange={(e) =>
                setCustomForm((prev) => ({ ...prev, newLabel: e.target.value }))
              }
              placeholder="Add a label…"
              aria-label="Add a label"
              style={{ width: 130 }}
            />
            <button
              className="button-like"
              disabled={!customForm.newLabel.trim() || addLabel.isPending}
              onClick={() => addLabel.mutate(customForm.newLabel.trim())}
            >
              Add
            </button>
            <input
              value={customForm.note}
              onChange={(e) => setCustomForm((prev) => ({ ...prev, note: e.target.value }))}
              placeholder="Note (optional)"
              aria-label="Check-in note"
              style={{ width: 200 }}
            />
            <button
              className="primary"
              disabled={doCheckin.isPending}
              onClick={() => doCheckin.mutate()}
            >
              {doCheckin.isPending
                ? "Checking in…"
                : `Check ${customForm.count} in here`}
            </button>
          </div>
        </div>
      )}
      {sweepReport && <p className="error">{sweepReport}</p>}
      {groupByJob(stored).map((g) => (
        <div key={g.projectId ?? "none"} style={{ marginBottom: 10 }}>
          <p className="tcx-label" style={{ margin: "6px 0 4px" }}>
            {g.projectId
              ? (jobCode.get(g.projectId) ?? "Job")
              : (() => {
                  const waiting = [
                    ...new Set(
                      g.packages
                        .map((p) => p.pending_job_name)
                        .filter((n): n is string => !!n),
                    ),
                  ];
                  return waiting.length > 0
                    ? `Waiting for ${waiting.join(", ")}`
                    : "No job";
                })()}{" "}
            · {g.packages.length}
          </p>
          <div className="home-projects">
            {g.packages.map((p) => {
              const days = agingDays(p.bound_at, new Date());
              if (sweeping) {
                return (
                  <label
                    key={p.id}
                    className="project-card home-project wh-row"
                  >
                    <input
                      type="checkbox"
                      checked={swept.has(p.id)}
                      onChange={() =>
                        setSwept((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.id)) next.delete(p.id);
                          else next.add(p.id);
                          return next;
                        })
                      }
                      aria-label={`Select ${p.serial}`}
                    />
                    <div className="home-project-head" style={{ flex: 1 }}>
                      {row(p, days != null ? `${days}d in storage` : undefined)}
                    </div>
                  </label>
                );
              }
              if (renaming === p.id) {
                const boundMarks = (p.package_marks ?? []).length > 0;
                return (
                  <div key={p.id} className="detail-card">
                    <div className="wh-row">
                      {p.project_id == null ? (
                        <input
                          value={renameForm.pending}
                          onChange={(e) =>
                            setRenameForm((prev) => ({ ...prev, pending: e.target.value }))
                          }
                          placeholder="Waiting-job name (blank = Boneyard)"
                          aria-label="Waiting-job name"
                          maxLength={120}
                          style={{ flex: 1, minWidth: 200 }}
                        />
                      ) : (
                        <span className="muted">{jobCode.get(p.project_id) ?? "?"}</span>
                      )}
                      <input
                        value={renameForm.mark}
                        onChange={(e) =>
                          setRenameForm((prev) => ({ ...prev, mark: e.target.value }))
                        }
                        placeholder="Mark"
                        aria-label="Mark"
                        maxLength={40}
                        disabled={boundMarks}
                        title={
                          boundMarks
                            ? "Tied to a real window — reassign instead of renaming"
                            : undefined
                        }
                        style={{ width: 110 }}
                      />
                    </div>
                    {boundMarks && (
                      <p className="muted" style={{ margin: "2px 0 0", fontSize: 12 }}>
                        The mark comes from the window this piece is tied to.
                      </p>
                    )}
                    {p.piece_count == null && (
                      <div className="wh-row" style={{ marginTop: 6 }}>
                        <input
                          type="number"
                          min={1}
                          max={99}
                          value={renameForm.partIndex}
                          onChange={(e) =>
                            setRenameForm((prev) => ({ ...prev, partIndex: e.target.value }))
                          }
                          aria-label="Piece number"
                          placeholder="1"
                          style={{ width: 70 }}
                        />
                        <span className="muted">of</span>
                        <input
                          type="number"
                          min={1}
                          max={99}
                          value={renameForm.partTotal}
                          onChange={(e) =>
                            setRenameForm((prev) => ({ ...prev, partTotal: e.target.value }))
                          }
                          aria-label="Piece total"
                          placeholder="2"
                          style={{ width: 70 }}
                        />
                        <select
                          value={renameForm.partType}
                          onChange={(e) =>
                            setRenameForm((prev) => ({ ...prev, partType: e.target.value }))
                          }
                          aria-label="What is it"
                          style={{ width: 150 }}
                        >
                          <option value="">— what is it? —</option>
                          {partChoices.map((t) => (
                            <option key={t} value={t}>
                              {PART_LABELS[t as PartType] ?? t}
                            </option>
                          ))}
                        </select>
                        {renameForm.partType === "other" && (
                          <input
                            value={renameForm.otherText}
                            onChange={(e) =>
                              setRenameForm((prev) => ({ ...prev, otherText: e.target.value }))
                            }
                            placeholder="Type what it is"
                            aria-label="Describe what it is"
                            style={{ width: 160 }}
                          />
                        )}
                      </div>
                    )}
                    <div className="wh-row" style={{ marginTop: 6 }}>
                      <button
                        className="primary"
                        disabled={saveRename.isPending}
                        onClick={() => saveRename.mutate(p)}
                      >
                        {saveRename.isPending ? "Saving…" : "Save name"}
                      </button>
                      <button className="button-like" onClick={() => setRenaming(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <Link key={p.id} to={`/pkg/${p.serial}`} className="project-card home-project">
                  <div className="home-project-head">
                    {row(p, days != null ? `${days}d in storage` : undefined)}
                    <button
                      className="button-like"
                      aria-label={`Rename ${p.serial}`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openRename(p);
                      }}
                    >
                      ✎
                    </button>
                    <span className="muted">›</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
      {stored.length === 0 && (
        <EmptyState
          title="Empty."
          action={
            <button className="button-like active-pill" onClick={() => setCheckin(true)}>
              Check material in
            </button>
          }
        />
      )}

      {canModel && (
        <div className="detail-card" style={{ marginTop: 12 }}>
          <div className="row-between">
            <h2 style={{ margin: 0, fontSize: 18 }}>3D shell</h2>
            {container.studio_project_id ? (
              <div className="row-gap">
                <Link className="button-like" to={`/warehouse/3d/${container.id}`}>
                  View in 3D
                </Link>
                <Link
                  className="button-like"
                  to={`/studio/p/${container.studio_project_id}`}
                >
                  Open in Studio
                </Link>
              </div>
            ) : (
              <button
                className="button-like"
                onClick={() => {
                  const d = shellDims(container);
                  setShellDimsText({
                    l: d ? String(d.lengthCm) : "",
                    w: d ? String(d.widthCm) : "",
                    h: d ? String(d.heightCm) : "",
                  });
                  setModeling((v) => !v);
                }}
              >
                {modeling ? "Cancel" : "Create the shell…"}
              </button>
            )}
          </div>
          {!container.studio_project_id && !modeling && (
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
              A true-size 3D box of this container in the Studio — the floor
              the warehouse map is built on. Shelves go in next.
            </p>
          )}
          {modeling && !container.studio_project_id && (
            <>
              <p className="muted" style={{ margin: "6px 0 8px", fontSize: 13 }}>
                Its real measurements, in centimeters.
                {containerKind(container) === "conex"
                  ? " Prefilled with the standard 20-foot box — fix them if this one differs."
                  : " Nobody has measured this one yet."}
              </p>
              <div className="row-gap">
                {(
                  [
                    ["l", "Length"],
                    ["w", "Width"],
                    ["h", "Height"],
                  ] as const
                ).map(([k, label]) => (
                  <div key={k} style={{ flex: 1 }}>
                    <label className="field-label">{label} (cm)</label>
                    <input
                      inputMode="decimal"
                      value={shellDimsText[k]}
                      onChange={(e) =>
                        setShellDimsText({ ...shellDimsText, [k]: e.target.value })
                      }
                    />
                  </div>
                ))}
              </div>
              <button
                className="button-like active-pill"
                style={{ marginTop: 8 }}
                disabled={makeShell.isPending}
                onClick={() => makeShell.mutate()}
              >
                {makeShell.isPending ? "Building…" : "Create the shell"}
              </button>
            </>
          )}
        </div>
      )}

      {trail.isSuccess && trail.data.length > 0 && (
        <>
          <h2 style={{ marginTop: 18 }}>Where it&rsquo;s been</h2>
          <Explain id="wh-container-trail">
            Every move and every address change, newest first. Nothing here is
            typed — each line was written the moment somebody moved the box or
            changed where it sits.
          </Explain>
          <div className="detail-card" style={{ padding: "6px 14px" }}>
            {trail.data.slice(0, 10).map((m) => {
              const line = containerTrailLine(m, containersById, locationsById);
              return (
                <p key={line.id} style={{ margin: "8px 0", fontSize: 13.5 }}>
                  <span className="wh-row-sub">
                    {new Date(line.when).toLocaleDateString()} ·{" "}
                  </span>
                  {line.text}
                </p>
              );
            })}
          </div>
        </>
      )}

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
