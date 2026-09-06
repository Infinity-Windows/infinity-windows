// The unit card: one window or door on one job, its pieces as tiles, and
// every fact on it a thing you tap to change (warehouse redesign wave 1,
// owner call 2026-09-06).
//
// Why it exists: the audit found the same edit living on four screens — a
// part label could be changed on the package sheet (behind two collapsed
// groups), on Rewrite-a-set, on the delivery's row select and in the
// container manifest — and the one edit a foreman most wants, "this box is
// tagged to the wrong job", refused outright by the server. When one fact has
// four homes none of them feels like the right one, and people learn that
// editing is scary. This is the one home.
//
// Rules the card keeps: warn, never block (a wrong-job move is allowed with
// a warning and a movement line); every write shows an Undo toast; nothing
// destructive is offered below foreman. The package sheet keeps photos and
// the full per-piece timeline and is linked from every tile.

import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listLocations, listProjects, listProjectsAnyStatus } from "../../lib/api";
import { getRealProfile } from "../../lib/install/api";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import { showUndoToast } from "../../lib/undoToast";
import { BackChip } from "../../components/BackChip";
import { ConfirmDanger } from "../../components/ConfirmDanger";
import { StageChip, type PackageStage } from "../../components/warehouse/StageChip";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isForemanPlus } from "../../lib/install/types";
import { placeWhere, toLocationsById } from "../../lib/warehouse/containment";
import { partsHeadline, unitParts } from "../../lib/warehouse/unitParts";
import { listScheduledMarks } from "../../lib/warehouse/warehouseCards";
import { rewriteSetHref, unitHref } from "../../lib/warehouse/materialsScope";
import { canUndo, lineText, undoneIds, type MovementLine } from "../../lib/warehouse/undo";
import { setPackageNoteOffline, writeToast } from "../../lib/warehouse/offlineWrites";
import {
  addPartTypeOption,
  burnPackages,
  copyUnit,
  deletePackages,
  listActivePackages,
  listContainers,
  listMovementsForPackages,
  listPartTypeOptions,
  mintMarkPackages,
  PART_LABELS,
  PART_TYPES,
  reassignPackage,
  setMarkKind,
  setMarkPartTotal,
  setPackagePart,
  undoMovement,
  type PartType,
  type StoragePackage,
} from "../../lib/storage";

/** A stable empty list, so a loading history is not a new array every render. */
const NO_LINES: MovementLine[] = [];

type Tone = "here" | "soon" | "out";
function toneOf(p: StoragePackage): Tone {
  if (p.status === "minted") return "soon";
  if (p.status === "checked_out") return "out";
  return "here";
}
function stageOf(p: StoragePackage): PackageStage {
  return (p.status === "blank" ? "minted" : p.status) as PackageStage;
}

type Editor =
  | { kind: "job"; pieceId?: string }
  | { kind: "mark"; pieceId?: string }
  | { kind: "count" }
  | { kind: "copy" }
  | null;

export function UnitCard() {
  const { projectId: rawProject = "", mark: rawMark = "" } = useParams();
  const [params] = useSearchParams();
  const pendingName = rawProject === "waiting" ? (params.get("pending") ?? "") : null;
  const projectId = pendingName == null ? rawProject : null;
  const mark = decodeURIComponent(rawMark).trim().toUpperCase();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const me = useQuery({ queryKey: ["myRealProfile"], queryFn: getRealProfile });

  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const locations = useQuery({ queryKey: ["locations"], queryFn: listLocations });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const projectsAll = useQuery({ queryKey: ["projectsAll"], queryFn: listProjectsAnyStatus });
  const partOptions = useQuery({ queryKey: ["partTypeOptions"], queryFn: listPartTypeOptions });
  // The unit's kind lives on its mark (ADR-0009): window or door, one fact
  // for the whole opening rather than a category on each piece.
  const marks = useQuery({
    queryKey: ["scheduledMarks", projectId ? [projectId] : []],
    queryFn: () => listScheduledMarks(projectId ? [projectId] : []),
    enabled: Boolean(projectId),
  });

  const report = useMemo(
    () => unitParts(packages.data ?? [], projectId ?? "", mark, pendingName ?? undefined),
    [packages.data, projectId, mark, pendingName],
  );
  const ids = report.rows.map((p) => p.id);
  const history = useQuery({
    queryKey: ["unitMovements", ids.join(",")],
    queryFn: () => listMovementsForPackages(ids),
    enabled: ids.length > 0,
  });

  const containersById = useMemo(
    () => new Map((containers.data ?? []).map((c) => [c.id, c])),
    [containers.data],
  );
  const locationsById = useMemo(() => toLocationsById(locations.data ?? []), [locations.data]);
  const jobCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projectsAll.data ?? []) m.set(p.id, p.job_code);
    return m;
  }, [projectsAll.data]);

  // `?piece=<id>` opens the card with that piece already selected — the scan
  // sheet's "Fix something on this piece" lands here (wave 2).
  const [selectedId, setSelectedId] = useState<string | null>(params.get("piece"));
  const selected = report.rows.find((p) => p.id === selectedId) ?? null;
  const [editor, setEditor] = useState<Editor>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    void qc.invalidateQueries({ queryKey: ["unitMovements"] });
    void qc.invalidateQueries({ queryKey: ["scheduledMarks"] });
  };

  const markRow = (marks.data ?? []).find((m) => m.mark_code === mark);
  const kind =
    markRow?.kind === "door" || (!markRow?.kind && report.rows.some((p) => p.category === "doors"))
      ? "Door"
      : "Window";

  const flipKind = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error("A waiting job has no schedule to mark.");
      await setMarkKind(projectId, mark, kind === "Door" ? "window" : "door");
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["scheduledMarks"] });
      pushToast(`${mark} is a ${kind === "Door" ? "window" : "door"} now.`);
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });
  const jobLabel = projectId ? (jobCode.get(projectId) ?? "…") : pendingName || "Boneyard";
  const headline = partsHeadline(report);
  const total = report.expectedTotal ?? report.rows.length;

  // --- moves: job, window, or both, for one piece or the whole unit --------
  const move = useMutation({
    mutationFn: async (input: {
      pieceIds: string[];
      projectId: string | null;
      markCode: string | null;
      reason: string;
    }) => {
      const moved: string[] = [];
      for (const id of input.pieceIds) {
        const mid = await reassignPackage({
          packageId: id,
          projectId: input.projectId,
          markCode: input.markCode,
          reason: input.reason || null,
        });
        if (mid) moved.push(mid);
      }
      return { moved, input };
    },
    onSuccess: ({ moved, input }) => {
      refresh();
      setEditor(null);
      const n = input.pieceIds.length;
      const where = input.projectId
        ? `${jobCode.get(input.projectId) ?? "the job"} window ${input.markCode}`
        : "the Boneyard";
      if (moved.length === 0) {
        pushToast("Nothing changed — it was already there.");
        return;
      }
      showUndoToast({
        message: `${n === 1 ? "Piece" : `${n} pieces`} moved to ${where}. History stays; the stickers still scan.`,
        undo: async () => {
          for (const mid of moved) await undoMovement(mid);
          refresh();
          navigate(unitHref({ projectId, pendingName }, mark), { replace: true });
        },
      });
      // The whole unit moved: follow it to its new address.
      if (n === report.rows.length && input.markCode) {
        navigate(unitHref({ projectId: input.projectId, pendingName: null }, input.markCode), {
          replace: true,
        });
      }
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  // --- piece count -----------------------------------------------------------
  const count = useMutation({
    mutationFn: async (next: number) => {
      if (!projectId) throw new Error("A waiting job's count is set on Rewrite a set.");
      const before = total;
      await setMarkPartTotal({ projectId, markCode: mark, total: next });
      if (next > before) {
        // Grow: every label now reads "of N"; mint the missing ones so the
        // new pieces exist as expected labels, not as a number nobody printed.
        await mintMarkPackages({ projectId, markCode: mark, total: next });
      }
      return { before, next };
    },
    onSuccess: ({ before, next }) => {
      refresh();
      setEditor(null);
      pushToast(
        next > before
          ? `${kind} ${mark} now arrives as ${next} pieces — ${next - before} new label${next - before === 1 ? "" : "s"} to print.`
          : `${kind} ${mark} now arrives as ${next} pieces.`,
      );
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  // --- copies (owner's ask): N more of this unit, with or without stickers --
  const copy = useMutation({
    mutationFn: async (input: { times: number; pooled: boolean }) => {
      if (!projectId) throw new Error("Copy a unit once its job is built.");
      const n = await copyUnit({ projectId, markCode: mark, times: input.times, pooled: input.pooled });
      return { ...input, n };
    },
    onSuccess: ({ times, pooled, n }) => {
      refresh();
      setEditor(null);
      pushToast(
        pooled
          ? `${times} ${times === 1 ? "copy" : "copies"} added — they ride on this unit's stickers (×${times + 1} on the label).`
          : `${times} ${times === 1 ? "copy" : "copies"} added — ${n} new expected label${n === 1 ? "" : "s"} to print.`,
      );
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  // --- a piece's label / part number ------------------------------------------
  const relabel = useMutation({
    mutationFn: async (input: { piece: StoragePackage; index: number | null; type: string | null }) => {
      await setPackagePart(input.piece.id, input.index, input.piece.part_total ?? null, input.type);
      return input;
    },
    onSuccess: ({ piece, index, type }) => {
      refresh();
      const was = { index: piece.part_index ?? null, type: piece.part_type ?? null };
      showUndoToast({
        message: `Piece ${index ?? "?"} of ${piece.part_total ?? "?"} is now ${type ? (PART_LABELS[type as PartType] ?? type) : "unlabelled"}.`,
        undo: async () => {
          await setPackagePart(piece.id, was.index, piece.part_total ?? null, was.type);
          refresh();
        },
      });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const [newLabel, setNewLabel] = useState("");
  const addLabel = useMutation({
    mutationFn: async (name: string) => {
      const saved = await addPartTypeOption(name);
      if (selected) await setPackagePart(selected.id, selected.part_index ?? null, selected.part_total ?? null, saved);
      return saved;
    },
    onSuccess: () => {
      setNewLabel("");
      void qc.invalidateQueries({ queryKey: ["partTypeOptions"] });
      refresh();
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  // --- note -------------------------------------------------------------------
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const note = useMutation({
    mutationFn: async (input: { piece: StoragePackage; text: string }) =>
      setPackageNoteOffline(input.piece.id, input.text.trim() || null),
    onSuccess: (r) => {
      setNoteDraft(null);
      refresh();
      pushToast(writeToast(r, "Note saved."));
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  // --- remove (foreman+) -----------------------------------------------------
  const [confirmRemove, setConfirmRemove] = useState(false);
  const remove = useMutation({
    mutationFn: async (piece: StoragePackage) => {
      if (piece.status === "minted") {
        await burnPackages([piece.id]);
        return "burned";
      }
      const r = await deletePackages([piece.id]);
      if (r.refused.length > 0) throw new Error(r.refused[0].reason);
      return "deleted";
    },
    onSuccess: (how) => {
      setConfirmRemove(false);
      setSelectedId(null);
      refresh();
      pushToast(how === "burned" ? "Label burned — destroy the paper." : "Piece deleted, history and all.");
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  // --- undo a history line ---------------------------------------------------
  const undo = useMutation({
    mutationFn: (id: string) => undoMovement(id),
    onSuccess: () => {
      refresh();
      pushToast("Undone.");
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const lines = history.data ?? NO_LINES;
  const undone = useMemo(() => undoneIds(lines), [lines]);
  const now = new Date();
  const meId = me.data?.id ?? null;

  if (packages.isLoading) {
    return (
      <div className="page">
        <BackChip fallback="/warehouse" />
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="page unit-card">
      <BackChip fallback="/warehouse" />
      <div className="page-header">
        <div>
          <div className="eyebrow">Unit</div>
          <h1>
            {kind} {mark}
          </h1>
        </div>
        <span className={`unit-headline unit-headline--${headline.tone}`}>{headline.text}</span>
      </div>

      {/* Every fact on the unit is a chip you tap to change. */}
      <div className="unit-chips" role="group" aria-label="Unit facts">
        <button
          type="button"
          className={`chip ${editor?.kind === "job" && !editor.pieceId ? "chip--on" : ""}`}
          onClick={() => setEditor(editor?.kind === "job" ? null : { kind: "job" })}
          title="Move every piece to another job"
        >
          {jobLabel} <span className="chip-pen">✎</span>
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => flipKind.mutate()}
          disabled={!projectId || flipKind.isPending}
          title="Window or door? Tap to flip"
        >
          {kind} <span className="chip-pen">⇄</span>
        </button>
        <button
          type="button"
          className={`chip ${editor?.kind === "mark" && !editor.pieceId ? "chip--on" : ""}`}
          onClick={() => setEditor(editor?.kind === "mark" ? null : { kind: "mark" })}
          title="Change the window number"
        >
          {kind.toLowerCase()} {mark} <span className="chip-pen">✎</span>
        </button>
        <button
          type="button"
          className={`chip ${editor?.kind === "count" ? "chip--on" : ""}`}
          onClick={() => setEditor(editor?.kind === "count" ? null : { kind: "count" })}
          title="Change how many pieces this unit arrives as"
          disabled={!projectId}
        >
          {report.expectedTotal == null ? `${report.rows.length} tagged, no count on labels` : `${total} piece${total === 1 ? "" : "s"}`}{" "}
          <span className="chip-pen">✎</span>
        </button>
        <button
          type="button"
          className={`chip ${editor?.kind === "copy" ? "chip--on" : ""}`}
          onClick={() => setEditor(editor?.kind === "copy" ? null : { kind: "copy" })}
          title="Add identical copies of this unit"
          disabled={!projectId || report.rows.length === 0}
        >
          Copy ×N
        </button>
      </div>

      {editor?.kind === "copy" ? (
        <CopyEditor busy={copy.isPending} onCancel={() => setEditor(null)} onApply={(v) => copy.mutate(v)} />
      ) : null}

      {editor?.kind === "job" || editor?.kind === "mark" ? (
        <MoveEditor
          key={`${editor.kind}-${editor.pieceId ?? "all"}`}
          mode={editor.kind}
          projectId={projectId}
          mark={mark}
          projects={projects.data ?? []}
          pieceCount={editor.pieceId ? 1 : report.rows.length}
          busy={move.isPending}
          onCancel={() => setEditor(null)}
          onApply={(next) =>
            move.mutate({
              pieceIds: editor.pieceId ? [editor.pieceId] : ids,
              projectId: next.projectId,
              markCode: next.projectId ? next.mark : null,
              reason: next.reason,
            })
          }
        />
      ) : null}

      {editor?.kind === "count" ? (
        <CountEditor
          total={total}
          maxIndex={Math.max(0, ...report.rows.map((p) => p.part_index ?? 0))}
          busy={count.isPending}
          onCancel={() => setEditor(null)}
          onApply={(n) => count.mutate(n)}
        />
      ) : null}

      {report.totalsDisagree ? (
        <p className="unit-warn">
          The labels on this unit disagree about how many pieces it has. Set the count above to settle it.
        </p>
      ) : null}

      <div className="unit-pieces" role="list" aria-label="Pieces">
        {report.rows.map((p) => {
          const tone = toneOf(p);
          const where =
            p.status === "minted"
              ? "expected"
              : p.status === "checked_out"
                ? "out on a job"
                : placeWhere(p, containersById, locationsById);
          return (
            <button
              key={p.id}
              type="button"
              role="listitem"
              className={`unit-piece unit-piece--${tone} ${selectedId === p.id ? "unit-piece--selected" : ""}`}
              onClick={() => {
                setSelectedId(selectedId === p.id ? null : p.id);
                setNoteDraft(null);
                setConfirmRemove(false);
              }}
              aria-pressed={selectedId === p.id}
            >
              <span className="unit-piece-i">
                {p.part_index ?? "?"}/{p.part_total ?? "?"}
              </span>
              <span className="unit-piece-t">
                {p.part_type ? (PART_LABELS[p.part_type as PartType] ?? p.part_type) : "what is it?"}
              </span>
              <span className="unit-piece-w">{where}</span>
            </button>
          );
        })}
        {report.missingIndexes.map((i) => (
          <button
            key={`ghost-${i}`}
            type="button"
            role="listitem"
            className="unit-piece unit-piece--ghost"
            onClick={() => setEditor({ kind: "count" })}
            title="No label claims this part number yet"
          >
            <span className="unit-piece-i">
              {i}/{total}
            </span>
            <span className="unit-piece-t">no label yet</span>
            <span className="unit-piece-w">tap to mint</span>
          </button>
        ))}
        {report.rows.length === 0 ? (
          <p className="muted">No packages carry this window number yet.</p>
        ) : null}
      </div>
      <p className="muted unit-hint">Tap a piece to edit it.</p>

      {selected ? (
        <section className="wh-card unit-piece-card" aria-label={`Piece ${selected.part_index ?? "?"}`}>
          <div className="wh-row">
            <div className="wh-row-main">
              <span className="wh-row-title">
                Piece {selected.part_index ?? "?"} of {selected.part_total ?? "?"}
                {" · "}
                <span className="mono">{selected.short_code ?? selected.serial}</span>
              </span>
              <span className="wh-row-sub">
                {selected.status === "minted"
                  ? "Expected — the label exists, the material has not arrived."
                  : selected.status === "checked_out"
                    ? "Checked out to a job."
                    : placeWhere(selected, containersById, locationsById)}
              </span>
            </div>
            <StageChip stage={stageOf(selected)}>
              {selected.status === "minted" ? "Expected" : selected.status === "checked_out" ? "Out" : selected.status === "stored" ? "Stored" : "Arrived"}
            </StageChip>
          </div>

          <div className="field-label">What it is</div>
          <div className="row-gap">
            {[...PART_TYPES, ...(partOptions.data ?? []).filter((o) => !(PART_TYPES as string[]).includes(o))].map((t) => (
              <button
                key={t}
                type="button"
                className={`chip ${selected.part_type === t ? "chip--on" : ""}`}
                disabled={relabel.isPending}
                onClick={() =>
                  relabel.mutate({ piece: selected, index: selected.part_index ?? null, type: t })
                }
              >
                {PART_LABELS[t as PartType] ?? t}
              </button>
            ))}
          </div>
          <form
            className="row-gap unit-inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (newLabel.trim()) addLabel.mutate(newLabel.trim());
            }}
          >
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Other label, e.g. door handle"
              aria-label="New part label"
              maxLength={40}
            />
            <button type="submit" className="button-like" disabled={!newLabel.trim() || addLabel.isPending}>
              Use it
            </button>
          </form>

          {selected.part_total ? (
            <>
              <div className="field-label">Part number</div>
              <div className="row-gap">
                {Array.from({ length: selected.part_total }, (_, k) => k + 1).map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`chip ${selected.part_index === n ? "chip--on" : ""}`}
                    disabled={relabel.isPending}
                    onClick={() => relabel.mutate({ piece: selected, index: n, type: selected.part_type ?? null })}
                  >
                    {n} of {selected.part_total}
                  </button>
                ))}
              </div>
            </>
          ) : null}

          <div className="field-label">Note</div>
          {noteDraft == null ? (
            <div className="wh-row">
              <span className="wh-row-main">{selected.note ?? <span className="muted">No note on this piece.</span>}</span>
              <button type="button" className="button-like" onClick={() => setNoteDraft(selected.note ?? "")}>
                {selected.note ? "Edit" : "Add a note"}
              </button>
            </div>
          ) : (
            <form
              className="unit-inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                note.mutate({ piece: selected, text: noteDraft });
              }}
            >
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                rows={2}
                aria-label="Note"
                placeholder="e.g. glass crate, fragile"
              />
              <div className="row-gap">
                <button type="submit" className="button-like button-like--primary" disabled={note.isPending}>
                  Save note
                </button>
                <button type="button" className="button-like" onClick={() => setNoteDraft(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          <div className="field-label">Move this piece</div>
          <div className="row-gap">
            <button
              type="button"
              className="button-like"
              onClick={() => setEditor({ kind: "mark", pieceId: selected.id })}
              disabled={!projectId}
            >
              To another window…
            </button>
            <button type="button" className="button-like" onClick={() => setEditor({ kind: "job", pieceId: selected.id })}>
              To another job…
            </button>
          </div>

          <div className="row-gap unit-links">
            <Link className="link" to={`/pkg/${selected.serial}`}>
              Photos &amp; full history
            </Link>
            {selected.container_id && containersById.get(selected.container_id) ? (
              <Link className="link" to={`/storage/c/${selected.container_id}?piece=${selected.id}`}>
                Open {containersById.get(selected.container_id)!.name}
              </Link>
            ) : null}
          </div>

          {lead ? (
            confirmRemove ? (
              <ConfirmDanger
                confirmText={remove.isPending ? "Removing…" : "Delete forever"}
                onConfirm={() => remove.mutate(selected)}
                onCancel={() => setConfirmRemove(false)}
                disabled={remove.isPending}
              >
                {selected.status === "minted"
                  ? "This label never lived: burning it kills the serial and frees the part slot. Destroy the paper — a burned sticker scans as nothing."
                  : "This piece has history. Deleting it removes the package and every line it ever wrote."}
              </ConfirmDanger>
            ) : (
              <button type="button" className="button-like danger-outline" onClick={() => setConfirmRemove(true)}>
                {selected.status === "minted" ? "Burn this label…" : "Delete this piece…"}
              </button>
            )
          ) : (
            <p className="muted" style={{ fontSize: 12.5 }}>
              A foreman can remove a piece — everything else here is yours to change.
            </p>
          )}
        </section>
      ) : null}

      <section className="unit-history" aria-label="History">
        <div className="field-label">History</div>
        {history.isLoading ? <p className="muted">Loading…</p> : null}
        {!history.isLoading && lines.length === 0 ? <p className="muted">Nothing has happened to this unit yet.</p> : null}
        <ul className="unit-list">
          {lines.map((l) => {
            const verdict = canUndo(l, { now, me: meId, foremanPlus: lead, undoneIds: undone });
            const piece = report.rows.find((p) => p.id === l.package_id);
            return (
              <li key={l.id} className={`unit-line ${undone.has(l.id) ? "unit-line--undone" : ""}`}>
                <div className="wh-row">
                  <div className="wh-row-main">
                    <span className="wh-row-title">{lineText(l)}</span>
                    <span className="wh-row-sub">
                      {piece ? `piece ${piece.part_index ?? "?"} · ` : ""}
                      {new Date(l.created_at).toLocaleString()}
                      {l.actor && l.actor === meId ? " · you" : ""}
                    </span>
                  </div>
                  {verdict.ok ? (
                    <button
                      type="button"
                      className="button-like"
                      disabled={undo.isPending}
                      onClick={() => undo.mutate(l.id)}
                    >
                      Undo
                    </button>
                  ) : (
                    <span className="muted unit-why" title={verdict.why}>
                      {undone.has(l.id) ? "undone" : ""}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <p className="muted unit-hint">
        Need to declare packages and crate pieces from scratch?{" "}
        <Link className="link" to={rewriteSetHref({ projectId, pendingName }, mark)}>
          Rewrite the whole set
        </Link>
        .
      </p>
    </div>
  );
}

function MoveEditor({
  mode,
  projectId,
  mark,
  projects,
  pieceCount,
  busy,
  onCancel,
  onApply,
}: {
  mode: "job" | "mark";
  projectId: string | null;
  mark: string;
  projects: { id: string; job_code: string; name: string }[];
  pieceCount: number;
  busy: boolean;
  onCancel: () => void;
  onApply: (next: { projectId: string | null; mark: string; reason: string }) => void;
}) {
  const [job, setJob] = useState<string>(mode === "job" ? "" : (projectId ?? ""));
  const [nextMark, setNextMark] = useState(mode === "job" ? mark : "");
  const [reason, setReason] = useState("");
  const toBoneyard = mode === "job" && job === "boneyard";
  const ready = toBoneyard || (job !== "" && nextMark.trim() !== "");
  const changesJob = mode === "job" && !toBoneyard && job !== "" && job !== projectId;
  return (
    <form
      className="wh-card unit-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onApply({
          projectId: toBoneyard ? null : job,
          mark: nextMark.trim().toUpperCase(),
          reason: reason.trim(),
        });
      }}
    >
      <div className="field-label">
        {mode === "job" ? "Move" : "Change the window number of"} {pieceCount === 1 ? "this piece" : `all ${pieceCount} pieces`}
      </div>
      {mode === "job" ? (
        <select value={job} onChange={(e) => setJob(e.target.value)} aria-label="Job">
          <option value="">Pick the job…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.job_code} — {p.name}
            </option>
          ))}
          <option value="boneyard">Boneyard (no job)</option>
        </select>
      ) : null}
      {!toBoneyard ? (
        <input
          value={nextMark}
          onChange={(e) => setNextMark(e.target.value)}
          placeholder="Window number, e.g. 16"
          aria-label="Window number"
          maxLength={12}
        />
      ) : null}
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why? (optional — e.g. wrong truck)"
        aria-label="Reason"
        maxLength={120}
      />
      {changesJob ? (
        <p className="unit-warn">
          Moving to a different job. History stays and the stickers still scan; a fresh label is offered on the package sheet, never required.
        </p>
      ) : null}
      {mode === "mark" ? (
        <p className="muted" style={{ fontSize: 12.5 }}>
          A window number not on the schedule yet is added at the same time.
        </p>
      ) : null}
      <div className="row-gap">
        <button type="submit" className="button-like button-like--primary" disabled={!ready || busy}>
          {busy ? "Moving…" : "Move"}
        </button>
        <button type="button" className="button-like" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CountEditor({
  total,
  maxIndex,
  busy,
  onCancel,
  onApply,
}: {
  total: number;
  maxIndex: number;
  busy: boolean;
  onCancel: () => void;
  onApply: (n: number) => void;
}) {
  const [n, setN] = useState(Math.max(1, total));
  const floor = Math.max(1, maxIndex);
  return (
    <form
      className="wh-card unit-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (n !== total) onApply(n);
      }}
    >
      <div className="field-label">How many pieces does this unit arrive as?</div>
      <div className="row-gap unit-stepper">
        <button type="button" className="button-like" onClick={() => setN((v) => Math.max(floor, v - 1))} aria-label="One fewer">
          −
        </button>
        <span className="unit-stepper-n" aria-live="polite">
          {n}
        </span>
        <button type="button" className="button-like" onClick={() => setN((v) => Math.min(20, v + 1))} aria-label="One more">
          +
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>
        {n > total
          ? `Every label will read "of ${n}" and ${n - total} new expected label${n - total === 1 ? "" : "s"} will be minted.`
          : n < total
            ? `Every label will read "of ${n}".${maxIndex > n ? ` A piece already numbered ${maxIndex} stops this — burn it first.` : ""}`
            : "No change."}
      </p>
      <div className="row-gap">
        <button type="submit" className="button-like button-like--primary" disabled={n === total || busy || (n < total && maxIndex > n)}>
          {busy ? "Saving…" : "Set the count"}
        </button>
        <button type="button" className="button-like" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CopyEditor({
  busy,
  onCancel,
  onApply,
}: {
  busy: boolean;
  onCancel: () => void;
  onApply: (v: { times: number; pooled: boolean }) => void;
}) {
  const [n, setN] = useState(1);
  const [pooled, setPooled] = useState(false);
  return (
    <form
      className="wh-card unit-editor"
      onSubmit={(e) => {
        e.preventDefault();
        onApply({ times: n, pooled });
      }}
    >
      <div className="field-label">How many more of this unit?</div>
      <div className="row-gap unit-stepper">
        <button type="button" className="button-like" onClick={() => setN((v) => Math.max(1, v - 1))} aria-label="One fewer">
          −
        </button>
        <span className="unit-stepper-n" aria-live="polite">
          {n}
        </span>
        <button type="button" className="button-like" onClick={() => setN((v) => Math.min(20, v + 1))} aria-label="One more">
          +
        </button>
      </div>
      <div className="field-label">Stickers</div>
      <div className="row-gap">
        <button type="button" className={`chip ${!pooled ? "chip--on" : ""}`} onClick={() => setPooled(false)} aria-pressed={!pooled}>
          Each copy gets its own sticker
        </button>
        <button type="button" className={`chip ${pooled ? "chip--on" : ""}`} onClick={() => setPooled(true)} aria-pressed={pooled}>
          No stickers — copies ride on the original
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>
        {pooled
          ? "The original's sticker prints ×N. Scanning it asks how many you are moving. Every copy still has its own ID, and any copy can be given its own sticker later."
          : "Every copy is expected as its own pieces with its own labels to print — the same as a clone set on a delivery."}
      </p>
      <div className="row-gap">
        <button type="submit" className="button-like button-like--primary" disabled={busy}>
          {busy ? "Copying…" : `Add ${n} ${n === 1 ? "copy" : "copies"}`}
        </button>
        <button type="button" className="button-like" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
