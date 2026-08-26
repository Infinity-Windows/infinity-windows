// Check the truck against the list (owner, 2026-08-25). A logged delivery
// is a standby list of EXPECTED packages; this screen is the tailgate:
// tap boxes in as they arrive, rapid-split identical twins across conexes
// by COUNT (they're interchangeable — nobody cares which twin goes where),
// and read what never came. Material for a job that isn't built yet is
// fully receivable and storable; a foreman files it onto the job later.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ScanLine } from "lucide-react";
import { BackChip } from "../../components/BackChip";
import { ContainerBadge } from "../../components/warehouse/ContainerBadge";
import { StageChip } from "../../components/warehouse/StageChip";
import { listProjects } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import { showUndoToast } from "../../lib/undoToast";
import {
  addDeliverySet,
  deletePackages,
  filePendingPackages,
  labelPackages,
  listContainers,
  listDeliveries,
  listDeliveryPackages,
  listPartTypeOptions,
  receivePackages,
  renamePackage,
  setPackagePart,
  storePackages,
  unreceivePackages,
  unstorePackages,
  PART_TYPES,
  PART_LABELS,
  type PartType,
} from "../../lib/storage";
import {
  groupDelivery,
  missingSummary,
  pickToReceive,
  pickToStore,
  pickToUndo,
  pickToUnstore,
  setForMark,
  type DeliveryPackageLite,
  type JobGroup,
  type SlotRow,
} from "../../lib/warehouse/deliveryReceiving";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isForemanPlus } from "../../lib/install/types";
import { useScanWedge } from "../../lib/warehouse/scanWedge";

export function DeliveryDetail() {
  // Pick 30: a desk-mounted hardware scanner routes straight to the package
  // or container it reads, same as the camera flow.
  useScanWedge();
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const [message, setMessage] = useState<string | null>(null);
  const [storeCounts, setStoreCounts] = useState<Record<string, number>>({});
  const [storeTargets, setStoreTargets] = useState<Record<string, string>>({});
  const [filePick, setFilePick] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [bundleMode, setBundleMode] = useState(false);
  const [bundle, setBundle] = useState<Set<string>>(new Set());
  const [bundleTarget, setBundleTarget] = useState("");
  const [confirmMix, setConfirmMix] = useState(false);
  const [rowLabels, setRowLabels] = useState<Record<string, string>>({});
  // The set editor (owner, 2026-08-26): one mark's every piece in one place —
  // rename the set, fix a piece, add one, or delete. Keyed by group so two
  // jobs' identical marks never share an editor.
  const [editSet, setEditSet] = useState<{ groupKey: string; mark: string } | null>(null);
  const [setName, setSetName] = useState({ pending: "", mark: "" });
  const [pieceDraft, setPieceDraft] = useState<
    Record<string, { index: string; total: string; type: string }>
  >({});
  const [addDraft, setAddDraft] = useState<
    Record<string, { mark: string; count: string; kind: "window" | "door" }>
  >({});
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

  const deliveries = useQuery({ queryKey: ["deliveries"], queryFn: listDeliveries });
  const delivery = deliveries.data?.find((d) => d.id === id);
  const packages = useQuery({
    queryKey: ["deliveryPackages", id],
    queryFn: () => listDeliveryPackages(id),
    enabled: !!id,
  });
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["deliveryPackages", id] });
    void qc.invalidateQueries({ queryKey: ["storagePackages"] });
  };

  const arrive = useMutation({
    mutationFn: async (args: { row: SlotRow; n: number }) => {
      const ids = pickToReceive(args.row, args.n);
      await receivePackages(ids);
      // "What is it?" answered right here: the boxes are finally being
      // read, so the picked label rides the same tap onto every twin.
      const label = rowLabels[args.row.key];
      if (label && !args.row.isCrate) {
        await labelPackages(ids, label);
      }
      // Pool pieces ride in the job's sealed crates — arriving is all
      // there is; the crates themselves store like any other box.
      return ids.length;
    },
    onSuccess: (n, vars) => {
      const message = `${n} box${n === 1 ? "" : "es"} checked in.`;
      // The undo toast below carries this line now — showing it twice (here
      // and in the toast) is exactly the "scattered" pattern pick 25 exists
      // to replace, and left a stale hint sitting behind a live toast.
      setMessage(null);
      refresh();
      // Pick 25: undo re-flips to expected and, if a label rode along on
      // this same tap, puts back exactly what each package carried before —
      // captured from the still-unrefreshed cache, not re-typed here.
      const ids = pickToReceive(vars.row, vars.n);
      const label = rowLabels[vars.row.key];
      const applied = label && !vars.row.isCrate ? label : null;
      const priorById = new Map(
        ids.map((pid) => {
          const p = (packages.data ?? []).find((x) => x.id === pid);
          return [
            pid,
            {
              partIndex: p?.part_index ?? null,
              partTotal: p?.part_total ?? null,
              partType: p?.part_type ?? null,
            },
          ] as const;
        }),
      );
      showUndoToast({
        message,
        undo: async () => {
          await unreceivePackages(ids);
          if (applied) {
            await Promise.all(
              ids.map((pid) => {
                const prior = priorById.get(pid);
                return setPackagePart(
                  pid,
                  prior?.partIndex ?? null,
                  prior?.partTotal ?? null,
                  prior?.partType ?? null,
                );
              }),
            );
          }
          refresh();
        },
      });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const unputaway = useMutation({
    mutationFn: async (row: SlotRow) => unstorePackages(pickToUnstore(row, 1)),
    onSuccess: (n) => {
      setMessage(n > 0 ? "Put-away undone — back to loose." : "Nothing to pull back.");
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const undoArrive = useMutation({
    mutationFn: async (row: SlotRow) => unreceivePackages(pickToUndo(row, 1)),
    onSuccess: (n) => {
      setMessage(n > 0 ? "Arrival undone — back to expected." : "Nothing to undo.");
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const store = useMutation({
    mutationFn: async (args: { row: SlotRow; n: number; container: string }) => {
      const ids = pickToStore(args.row, args.n);
      if (ids.length === 0) throw new Error("Nothing arrived and loose to store yet.");
      await storePackages(ids, args.container);
      return ids.length;
    },
    onSuccess: (n, vars) => {
      const message = `Stored ${n}.`;
      // Same reasoning as arrive's onSuccess above: the toast carries this
      // line now, not a second copy sitting on the page behind it.
      setMessage(null);
      refresh();
      const ids = pickToStore(vars.row, vars.n);
      showUndoToast({
        message,
        undo: async () => {
          await unstorePackages(ids);
          refresh();
        },
      });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const bundleStore = useMutation({
    mutationFn: async (args: { ids: string[]; container: string; dropped: number }) => {
      await storePackages(args.ids, args.container);
      return args.ids.length;
    },
    onSuccess: (n, vars) => {
      const message = `Stored ${n} together.`;
      // The toast carries the success line; the page line is reserved for
      // the one thing worth keeping on screen — ticks that drifted out from
      // under the selection (a box stored by someone else, an undone
      // arrival, a relabel). Never skipped silently (owner report,
      // 2026-08-26).
      setMessage(
        vars.dropped > 0
          ? `${vars.dropped} ticked piece${vars.dropped === 1 ? "" : "s"} changed since you picked ${vars.dropped === 1 ? "it" : "them"} — stored the other ${n}. Check the list for the rest.`
          : null,
      );
      setBundle(new Set());
      setBundleMode(false);
      setConfirmMix(false);
      setBundleTarget("");
      refresh();
      showUndoToast({
        message,
        undo: async () => {
          await unstorePackages(vars.ids);
          refresh();
        },
      });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const fileOnto = useMutation({
    mutationFn: (args: { group: JobGroup; projectId: string }) =>
      filePendingPackages(args.group.unfiledIds, args.projectId),
    onSuccess: (n) => {
      setMessage(`Filed ${n} package${n === 1 ? "" : "s"} onto the job.`);
      refresh();
      void qc.invalidateQueries({ queryKey: ["issues"] });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const jobCode = new Map((projects.data ?? []).map((p) => [p.id, p.job_code ?? p.name]));
  const groups = groupDelivery(
    (packages.data ?? []) as unknown as DeliveryPackageLite[],
    (projectId) => jobCode.get(projectId) ?? null,
  );
  const summary = missingSummary(groups);
  const storables = (containers.data ?? []).filter((c) => c.active !== false);

  const q = search.trim().toLowerCase();
  const visibleGroups = q
    ? groups
        .map((g) => ({
          ...g,
          rows: g.rows.filter((r) => r.label.toLowerCase().includes(q)),
        }))
        .filter((g) => g.rows.length > 0)
    : groups;

  // The bundle: PACKAGE IDS, not row keys (owner report, 2026-08-26: rows
  // re-key when a box gets labeled — its part_type is part of the slot key —
  // so ticks pinned to keys silently died and selected boxes got skipped).
  // Ids survive relabeling; a tick means those physical boxes, whatever
  // slot they show under by the time the button is pressed.
  const looseNow = new Map(
    groups.flatMap((g) => g.rows.flatMap((r) => r.looseIds.map((pid) => [pid, g.key] as const))),
  );
  const bundleIds = [...bundle].filter((pid) => looseNow.has(pid));
  /** Ticked but no longer loose — stored by someone else, un-arrived, or
   *  re-labeled out from under the tick. Said out loud, never skipped
   *  silently. */
  const bundleDropped = bundle.size - bundleIds.length;
  const bundleJobs = new Set(bundleIds.map((pid) => looseNow.get(pid)));
  const bundleTargetContainer = storables.find((c) => c.id === bundleTarget) ?? null;
  const rowTicked = (r: SlotRow) =>
    r.looseIds.length > 0 && r.looseIds.every((pid) => bundle.has(pid));
  const toggleBundle = (r: SlotRow) =>
    setBundle((prev) => {
      const next = new Set(prev);
      if (rowTicked(r)) for (const pid of r.looseIds) next.delete(pid);
      else for (const pid of r.looseIds) next.add(pid);
      return next;
    });
  const fireBundle = () => {
    if (bundleJobs.size > 1 && !confirmMix) {
      setConfirmMix(true);
      return;
    }
    bundleStore.mutate({
      ids: bundleIds,
      container: bundleTarget,
      dropped: bundleDropped,
    });
  };

  const refreshPackages = () => refresh();

  const openSetEditor = (g: JobGroup, mark: string) => {
    setEditSet({ groupKey: g.key, mark });
    setSetName({ pending: g.pendingJobName ?? "", mark });
    setPieceDraft({});
  };

  // Rename the whole set: every piece, whatever its state, or the old name
  // survives on stragglers. Metadata only; the undo toast puts it all back.
  const saveSetName = useMutation({
    mutationFn: async (args: { g: JobGroup; mark: string }) => {
      const set = setForMark(args.g, args.mark);
      const prior = { pending: args.g.pendingJobName, mark: args.mark };
      const nextPending =
        args.g.projectId != null ? null : setName.pending.trim() || null;
      const nextMark = setName.mark.trim();
      if (!nextMark) throw new Error("Every set needs a mark, like 16 or 13A.");
      for (const pid of set.allIds) {
        await renamePackage(pid, nextPending, nextMark);
      }
      return { ids: set.allIds, prior };
    },
    onSuccess: ({ ids, prior }) => {
      setEditSet(null);
      refreshPackages();
      showUndoToast({
        message: "Set renamed.",
        undo: async () => {
          for (const pid of ids) {
            await renamePackage(pid, prior.pending, prior.mark);
          }
          refreshPackages();
        },
      });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const savePiece = useMutation({
    mutationFn: async (args: { row: SlotRow; index: number | null; total: number | null; type: string | null }) => {
      for (const pid of args.row.allIds) {
        await setPackagePart(pid, args.index, args.total, args.type);
      }
    },
    onSuccess: () => {
      setMessage("Piece updated.");
      refreshPackages();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const deletePieces = useMutation({
    mutationFn: async (ids: string[]) => deletePackages(ids),
    onSuccess: (r) => {
      setMessage(
        r.refused.length > 0
          ? `Deleted ${r.deleted}. Refused: ${r.refused.map((x) => `${x.serial} (${x.reason})`).join("; ")}`
          : `Deleted ${r.deleted}.`,
      );
      setEditSet(null);
      refreshPackages();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const addSet = useMutation({
    mutationFn: (args: {
      g: JobGroup;
      mark: string;
      count: number;
      kind: "window" | "door";
    }) =>
      addDeliverySet({
        deliveryId: id,
        projectId: args.g.projectId,
        jobName: args.g.pendingJobName,
        mark: args.mark,
        kind: args.kind,
        packageCount: args.count,
      }),
    onSuccess: (n, args) => {
      setMessage(`Added #${args.mark.toUpperCase()} — ${n} expected piece${n === 1 ? "" : "s"}.`);
      setAddDraft((prev) => ({ ...prev, [args.g.key]: { mark: "", count: "2", kind: args.kind } }));
      refreshPackages();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const addPiece = useMutation({
    mutationFn: (args: { g: JobGroup; mark: string; kind: "window" | "door" }) =>
      addDeliverySet({
        deliveryId: id,
        projectId: args.g.projectId,
        jobName: args.g.pendingJobName,
        mark: args.mark,
        kind: args.kind,
        packageCount: 1,
      }),
    onSuccess: () => {
      setMessage("One more expected piece on the set — label it when it shows.");
      refreshPackages();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const rowControls = (row: SlotRow) => {
    const missing = row.expectedIds.length;
    const loose = Math.max(row.looseIds.length, 1);
    const count = Math.min(storeCounts[row.key] ?? loose, loose);
    const target = storeTargets[row.key] ?? "";
    const targetContainer = storables.find((c) => c.id === target) ?? null;
    return (
      <div className="wh-row">
        <span className={missing === 0 ? "ok" : "warn-text"}>
          <span className="wh-count">
            {row.received} of {row.expected}
          </span>{" "}
          <StageChip stage="received">arrived</StageChip>
          {row.stored > 0 ? ` · ${row.stored} put away` : ""}
        </span>
        {missing > 0 && !row.isCrate && (
          <select
            value={rowLabels[row.key] ?? ""}
            onChange={(e) =>
              setRowLabels((prev) => ({ ...prev, [row.key]: e.target.value }))
            }
            aria-label={`What is ${row.label}`}
          >
            <option value="">— what is it? —</option>
            {partChoices.map((t) => (
              <option key={t} value={t}>
                {PART_LABELS[t as PartType] ?? t}
              </option>
            ))}
          </select>
        )}
        {missing > 0 && (
          <>
            <button
              className="button-like"
              disabled={arrive.isPending}
              onClick={() => arrive.mutate({ row, n: 1 })}
            >
              ✓ 1 arrived
            </button>
            {missing > 1 && (
              <button
                className="button-like"
                disabled={arrive.isPending}
                onClick={() => arrive.mutate({ row, n: missing })}
              >
                ✓ all {missing}
              </button>
            )}
          </>
        )}
        {row.storedIds.length > 0 && (
          <button
            className="link"
            disabled={unputaway.isPending}
            onClick={() => unputaway.mutate(row)}
            aria-label={`Un-put-away one of ${row.label}`}
          >
            un-put-away
          </button>
        )}
        {row.undoableIds.length > 0 && (
          <button
            className="link"
            disabled={undoArrive.isPending}
            onClick={() => undoArrive.mutate(row)}
            aria-label={`Undo an arrival of ${row.label}`}
          >
            undo
          </button>
        )}
        {!row.isCrate && row.looseIds.length > 0 && (
          <>
            <select
              value={count}
              onChange={(e) =>
                setStoreCounts((prev) => ({ ...prev, [row.key]: Number(e.target.value) }))
              }
              aria-label={`How many of ${row.label} to store`}
            >
              {Array.from({ length: row.looseIds.length }, (_, n) => (
                <option key={n + 1} value={n + 1}>
                  {n + 1}
                </option>
              ))}
            </select>
            <select
              value={target}
              onChange={(e) =>
                setStoreTargets((prev) => ({ ...prev, [row.key]: e.target.value }))
              }
              aria-label={`Where to store ${row.label}`}
            >
              <option value="">— where to? —</option>
              {storables.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {/* Pick 5: a native <select> can't color its own options, so the
                badge for the chosen container shows just outside it — same
                color everywhere that container's name appears. */}
            {target && targetContainer && (
              <ContainerBadge name={targetContainer.name} serial={targetContainer.serial} />
            )}
            <button
              className="button-like"
              disabled={!target || store.isPending}
              onClick={() => store.mutate({ row, n: count, container: target })}
            >
              Store {count}
            </button>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Delivery</p>
          <h1>{delivery?.label ?? "Delivery"}</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {summary.received} of {summary.expected} expected boxes arrived
            {summary.missing > 0 ? ` · ${summary.missing} still missing` : " · all here"}
          </p>
        </div>
        <BackChip fallback="/warehouse" label="Warehouse" />
      </header>

      {message && <p className="scanner-hint">{message}</p>}

      <div className="wh-row">
        {/* Pick 10: a phone-camera scan sits inside the field's own frame —
            the keyboard-wedge path (pick 30) already works anywhere on the
            page via useScanWedge, this is the door in for a bare camera. */}
        <div className="locate-search" style={{ marginBottom: 0, flex: "1 1 220px" }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search marks or jobs…"
            aria-label="Search this delivery"
          />
          <Link to="/scan" className="locate-go" aria-label="Scan a sticker">
            <ScanLine size={20} />
          </Link>
        </div>
        <button
          className={bundleMode ? "button-like active-pill" : "button-like"}
          onClick={() => {
            setBundleMode((v) => !v);
            setBundle(new Set());
            setConfirmMix(false);
          }}
        >
          {bundleMode ? "Done selecting" : "Select several…"}
        </button>
      </div>

      {bundleMode && (
        <div className="wh-row" style={{ margin: "8px 0" }}>
          <span className="muted">
            {bundleIds.length} piece{bundleIds.length === 1 ? "" : "s"} from{" "}
            {bundleJobs.size} job{bundleJobs.size === 1 ? "" : "s"} selected
          </span>
          <select
            value={bundleTarget}
            onChange={(e) => {
              setBundleTarget(e.target.value);
              setConfirmMix(false);
            }}
            aria-label="Where to store the selected pieces"
          >
            <option value="">— where to? —</option>
            {storables.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {bundleTarget && bundleTargetContainer && (
            <ContainerBadge
              name={bundleTargetContainer.name}
              serial={bundleTargetContainer.serial}
            />
          )}
          <button
            className="primary"
            disabled={bundleIds.length === 0 || !bundleTarget || bundleStore.isPending}
            onClick={fireBundle}
          >
            {bundleStore.isPending
              ? "Storing…"
              : `Store ${bundleIds.length} together`}
          </button>
          {confirmMix && (
            <span className="wh-row">
              <span className="warn-text">
                These pieces belong to {bundleJobs.size} different jobs — they'll
                share one container.
              </span>
              <button className="button-like" onClick={fireBundle}>
                I Understand — store them
              </button>
            </span>
          )}
        </div>
      )}

      {visibleGroups.map((g) => (
        <section key={g.key} style={{ marginBottom: 16 }}>
          <h2 style={{ marginBottom: 4 }}>
            {g.projectId
              ? (jobCode.get(g.projectId) ?? "Job")
              : `“${g.pendingJobName}”`}
          </h2>
          {!g.projectId && (
            <div className="wh-row" style={{ marginBottom: 6 }}>
              <span className="wh-row-sub">
                Job not built yet — everything still works; file it once it exists.
              </span>
              {lead && g.unfiledIds.length > 0 && (
                <>
                  <select
                    value={filePick[g.key] ?? ""}
                    onChange={(e) =>
                      setFilePick((prev) => ({ ...prev, [g.key]: e.target.value }))
                    }
                    aria-label={`File ${g.pendingJobName} onto job`}
                  >
                    <option value="">— pick the built job —</option>
                    {(projects.data ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.job_code ?? p.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="button-like"
                    disabled={!filePick[g.key] || fileOnto.isPending}
                    onClick={() =>
                      fileOnto.mutate({ group: g, projectId: filePick[g.key] })
                    }
                  >
                    File {g.unfiledIds.length} onto it
                  </button>
                </>
              )}
            </div>
          )}
          <ul className="unit-list">
            {g.rows.map((row) => (
              <li key={row.key} className="opening-review-row">
                <div className="wh-row">
                  {bundleMode && (
                    <input
                      type="checkbox"
                      checked={rowTicked(row)}
                      disabled={row.looseIds.length === 0}
                      onChange={() => toggleBundle(row)}
                      aria-label={`Select ${row.label}`}
                    />
                  )}
                  <strong>{row.label}</strong>
                  <button
                    className="link"
                    onClick={() => openSetEditor(g, row.mark)}
                    aria-label={`Edit set #${row.mark}`}
                  >
                    Edit set…
                  </button>
                </div>
                {rowControls(row)}
              </li>
            ))}
          </ul>
          {editSet?.groupKey === g.key &&
            (() => {
              const set = setForMark(g, editSet.mark);
              if (set.slots.length === 0) return null;
              const byId = new Map((packages.data ?? []).map((p) => [p.id, p]));
              const kindOf: "window" | "door" =
                byId.get(set.allIds[0] ?? "")?.category === "doors" ? "door" : "window";
              const boundMarks = g.projectId != null;
              const missing = set.expected - set.arrived;
              return (
                <div className="detail-card" style={{ marginBottom: 8 }}>
                  <div className="wh-row">
                    <strong>Edit #{set.mark}</strong>
                    <span className="wh-row-sub">
                      {set.expected} expected · {set.arrived} arrived · {set.stored} put away
                    </span>
                    <button className="button-like" onClick={() => setEditSet(null)}>
                      Close
                    </button>
                  </div>
                  {/* Renaming is for unbound sets only: a bound set's mark
                      comes from the job's own window, and rename_package
                      refuses it by design — so no field is offered at all. */}
                  {!boundMarks && (
                    <div className="wh-row" style={{ marginTop: 6 }}>
                      <input
                        value={setName.pending}
                        onChange={(e) =>
                          setSetName((prev) => ({ ...prev, pending: e.target.value }))
                        }
                        placeholder="Waiting-job name"
                        aria-label="Waiting-job name"
                        maxLength={120}
                        style={{ flex: 1, minWidth: 180 }}
                      />
                      <input
                        value={setName.mark}
                        onChange={(e) =>
                          setSetName((prev) => ({ ...prev, mark: e.target.value }))
                        }
                        aria-label="Mark"
                        maxLength={40}
                        style={{ width: 100 }}
                      />
                      <button
                        className="primary"
                        disabled={saveSetName.isPending}
                        onClick={() => saveSetName.mutate({ g, mark: set.mark })}
                      >
                        {saveSetName.isPending ? "Saving…" : "Save name"}
                      </button>
                    </div>
                  )}
                  {boundMarks && (
                    <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
                      This set is tied to a built job — its mark comes from the job&rsquo;s
                      own window, so only the pieces are editable here.
                    </p>
                  )}
                  <ul className="unit-list" style={{ marginTop: 6 }}>
                    {set.slots.map((row) => {
                      const first = byId.get(row.allIds[0] ?? "");
                      const d = pieceDraft[row.key] ?? {
                        index: first?.part_index != null ? String(first.part_index) : "",
                        total: first?.part_total != null ? String(first.part_total) : "",
                        type: first?.part_type ?? "",
                      };
                      const setD = (patch: Partial<typeof d>) =>
                        setPieceDraft((prev) => ({ ...prev, [row.key]: { ...d, ...patch } }));
                      return (
                        <li key={row.key} className="opening-review-row">
                          <div className="wh-row">
                            <span className="wh-row-sub" style={{ flex: 1, minWidth: 140 }}>
                              {row.label}
                            </span>
                            {!row.isCrate && (
                              <>
                                <input
                                  type="number"
                                  min={1}
                                  max={99}
                                  value={d.index}
                                  onChange={(e) => setD({ index: e.target.value })}
                                  aria-label={`Piece number for ${row.label}`}
                                  style={{ width: 64 }}
                                />
                                <span className="muted">of</span>
                                <input
                                  type="number"
                                  min={1}
                                  max={99}
                                  value={d.total}
                                  onChange={(e) => setD({ total: e.target.value })}
                                  aria-label={`Piece total for ${row.label}`}
                                  style={{ width: 64 }}
                                />
                                <select
                                  value={d.type}
                                  onChange={(e) => setD({ type: e.target.value })}
                                  aria-label={`What is ${row.label}`}
                                >
                                  <option value="">— what is it? —</option>
                                  {partChoices.map((t) => (
                                    <option key={t} value={t}>
                                      {PART_LABELS[t as PartType] ?? t}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  className="button-like"
                                  disabled={savePiece.isPending}
                                  onClick={() =>
                                    savePiece.mutate({
                                      row,
                                      index: d.index.trim() === "" ? null : Number(d.index),
                                      total: d.total.trim() === "" ? null : Number(d.total),
                                      type: d.type || null,
                                    })
                                  }
                                >
                                  Save
                                </button>
                              </>
                            )}
                            {lead && (
                              <button
                                className="link"
                                style={{ color: "var(--danger)" }}
                                disabled={deletePieces.isPending}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `Delete ${row.label}? ${row.received} of its ${row.expected} already arrived — arrived pieces are real material. This can't be undone.`,
                                    )
                                  ) {
                                    deletePieces.mutate(row.allIds);
                                  }
                                }}
                              >
                                delete
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {lead && (
                    <div className="wh-row" style={{ marginTop: 6 }}>
                      <button
                        className="button-like"
                        disabled={addPiece.isPending}
                        onClick={() => addPiece.mutate({ g, mark: set.mark, kind: kindOf })}
                      >
                        + one more piece
                      </button>
                      <button
                        className="button-like"
                        style={{ color: "var(--danger)" }}
                        disabled={deletePieces.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete ALL of #${set.mark} from this delivery? ${missing} still-expected die with it, and ${set.arrived} arrived piece${set.arrived === 1 ? "" : "s"} — real material — get deleted too. This can't be undone.`,
                            )
                          ) {
                            deletePieces.mutate(set.allIds);
                          }
                        }}
                      >
                        Delete this set…
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}
          {lead && (
            <div className="wh-row" style={{ marginTop: 4 }}>
              <input
                value={addDraft[g.key]?.mark ?? ""}
                onChange={(e) =>
                  setAddDraft((prev) => ({
                    ...prev,
                    [g.key]: {
                      mark: e.target.value,
                      count: prev[g.key]?.count ?? "2",
                      kind: prev[g.key]?.kind ?? "window",
                    },
                  }))
                }
                placeholder="Add a mark…"
                aria-label={`New mark for ${g.projectId ? (jobCode.get(g.projectId) ?? "job") : (g.pendingJobName ?? "job")}`}
                maxLength={40}
                style={{ width: 120 }}
              />
              {(addDraft[g.key]?.mark ?? "").trim() !== "" && (
                <>
                  <select
                    value={addDraft[g.key]?.count ?? "2"}
                    onChange={(e) =>
                      setAddDraft((prev) => ({
                        ...prev,
                        [g.key]: { ...prev[g.key]!, count: e.target.value },
                      }))
                    }
                    aria-label="How many packages"
                  >
                    {Array.from({ length: 20 }, (_, n) => (
                      <option key={n + 1} value={String(n + 1)}>
                        {n + 1} package{n === 0 ? "" : "s"}
                      </option>
                    ))}
                  </select>
                  <select
                    value={addDraft[g.key]?.kind ?? "window"}
                    onChange={(e) =>
                      setAddDraft((prev) => ({
                        ...prev,
                        [g.key]: {
                          ...prev[g.key]!,
                          kind: e.target.value as "window" | "door",
                        },
                      }))
                    }
                    aria-label="Window or door"
                  >
                    <option value="window">Window</option>
                    <option value="door">Door</option>
                  </select>
                  <button
                    className="button-like"
                    disabled={addSet.isPending}
                    onClick={() =>
                      addSet.mutate({
                        g,
                        mark: addDraft[g.key]!.mark.trim(),
                        count: Number(addDraft[g.key]!.count ?? "2"),
                        kind: addDraft[g.key]?.kind ?? "window",
                      })
                    }
                  >
                    {addSet.isPending ? "Adding…" : "Add mark"}
                  </button>
                </>
              )}
            </div>
          )}
        </section>
      ))}

      {summary.lines.length > 0 && (
        <section>
          <h2>Still missing</h2>
          <ul className="unit-list">
            {summary.lines.map((l) => (
              <li key={l} className="warn-text">
                {l}
              </li>
            ))}
          </ul>
        </section>
      )}
      {packages.data && packages.data.length === 0 && (
        <p className="muted">Nothing was logged on this delivery.</p>
      )}
    </div>
  );
}
