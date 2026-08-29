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
import { StationChip } from "../../components/warehouse/StationChip";
import { listProjects, listProjectsAnyStatus } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import { showUndoToast } from "../../lib/undoToast";
import {
  addDeliverySet,
  filePendingPackages,
  labelPackages,
  listContainers,
  listDeliveries,
  listDeliveryPackages,
  listPartTypeOptions,
  receivePackages,
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
  groupRowsByType,
  missingSummary,
  pickToReceive,
  pickToReceiveGroup,
  pickToStore,
  pickToUndo,
  pickToUnstore,
  type DeliveryPackageLite,
  type JobGroup,
  type SlotRow,
  type TypeGroup,
} from "../../lib/warehouse/deliveryReceiving";
import { rewriteSetHref, scopeHref } from "../../lib/warehouse/materialsScope";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isForemanPlus } from "../../lib/install/types";
import { useScanWedge } from "../../lib/warehouse/scanWedge";
import { STATION_COMING_IN } from "../../lib/warehouse/stations";

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
  // Wave R: "Edit set…" navigates to the Rewrite view now — one editor
  // reachable from both doors — instead of opening an inline editor here.
  // Wave R, ticket R3: which collapsed type-groups are expanded to their
  // individual slots. Keyed by TypeGroup.key, which already carries the
  // job group's mark/isCrate/type — no group-key prefix needed since a
  // group's key is unique across the whole delivery already (mark is
  // per-job-unique in practice, and colliding on it costs nothing worse
  // than one extra row staying expanded).
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleExpand = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
  // Finished jobs keep naming their material (owner ask, 2026-08-26): group
  // titles read every job; the file-onto-job picker stays active-only.
  const projectsAll = useQuery({ queryKey: ["projectsAll"], queryFn: listProjectsAnyStatus });

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

  // Wave R, ticket R3: the collapsed row's own Arrive 1 / Arrive all — same
  // shape as `arrive` above, over every member row's expected ids at once
  // instead of one row's. Individual per-slot undo stays reachable by
  // expanding the group; this one keeps the tap itself to one round trip.
  const arriveGroup = useMutation({
    mutationFn: async (args: { group: TypeGroup; n: number }) => {
      const ids = pickToReceiveGroup(args.group, args.n);
      await receivePackages(ids);
      const label = rowLabels[args.group.key];
      if (label && !args.group.isCrate) {
        await labelPackages(ids, label);
      }
      return ids.length;
    },
    onSuccess: (n) => {
      setMessage(`${n} box${n === 1 ? "" : "es"} checked in.`);
      refresh();
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

  const jobCode = new Map((projectsAll.data ?? []).map((p) => [p.id, p.job_code ?? p.name]));
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
      <StationChip station={STATION_COMING_IN} />

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
          <div className="wh-row" style={{ marginBottom: 4, alignItems: "baseline" }}>
            <h2 style={{ margin: 0 }}>
              {g.projectId
                ? (jobCode.get(g.projectId) ?? "Job")
                : `“${g.pendingJobName}”`}
            </h2>
            {/* Wave M: the ledger and the log cross-link both directions now
                — this group's own material, filtered to just this job. */}
            <Link
              to={scopeHref({ projectId: g.projectId, pendingName: g.pendingJobName })}
              className="link"
              style={{ fontSize: 13 }}
            >
              ledger
            </Link>
          </div>
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
            {groupRowsByType(g.rows).map((group) => {
              // Wave R, ticket R3: a mark with only one slot has nothing to
              // collapse — render it exactly as before rather than wrap one
              // row in summary chrome.
              if (group.rows.length === 1) {
                const row = group.rows[0];
                return (
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
                      <Link
                        to={rewriteSetHref(
                          { projectId: g.projectId, pendingName: g.pendingJobName },
                          row.mark,
                        )}
                        className="link"
                        aria-label={`Edit set #${row.mark}`}
                      >
                        Edit set…
                      </Link>
                    </div>
                    {rowControls(row)}
                  </li>
                );
              }
              const open = expandedGroups.has(group.key);
              const label = rowLabels[group.key] ?? "";
              return (
                <li key={group.key} className="opening-review-row">
                  <div className="wh-row">
                    <strong>{group.label}</strong>
                    <Link
                      to={rewriteSetHref(
                        { projectId: g.projectId, pendingName: g.pendingJobName },
                        group.mark,
                      )}
                      className="link"
                      aria-label={`Edit set #${group.mark}`}
                    >
                      Edit set…
                    </Link>
                  </div>
                  <div className="wh-row">
                    {group.missing > 0 && (
                      <span className="warn-text">
                        <span className="wh-count">{group.missing}</span> still coming
                      </span>
                    )}
                    {group.received > 0 && (
                      <span className="ok">
                        <span className="wh-count">{group.received}</span> arrived
                      </span>
                    )}
                    {group.missing > 0 && group.partType === null && (
                      <select
                        value={label}
                        onChange={(e) =>
                          setRowLabels((prev) => ({ ...prev, [group.key]: e.target.value }))
                        }
                        aria-label={`What is ${group.label}`}
                      >
                        <option value="">— what is it? —</option>
                        {partChoices.map((t) => (
                          <option key={t} value={t}>
                            {PART_LABELS[t as PartType] ?? t}
                          </option>
                        ))}
                      </select>
                    )}
                    {group.missing > 0 && (
                      <>
                        <button
                          className="button-like"
                          disabled={arriveGroup.isPending}
                          onClick={() => arriveGroup.mutate({ group, n: 1 })}
                        >
                          Arrive 1
                        </button>
                        <button
                          className="button-like"
                          disabled={arriveGroup.isPending}
                          onClick={() => arriveGroup.mutate({ group, n: group.missing })}
                        >
                          Arrive all {group.missing}
                        </button>
                      </>
                    )}
                    <button className="link" onClick={() => toggleExpand(group.key)}>
                      {open ? "Hide individual slots" : `Show ${group.rows.length} individually`}
                    </button>
                  </div>
                  {/* Slot-level actions stay reachable — nothing removed,
                      only grouped (R3). Bound marks/serials or differing
                      details are never in a multi-row group in the first
                      place; a tap here is always "I need one specific
                      slot," never a workaround for something hidden. */}
                  {open && (
                    <ul className="unit-list" style={{ marginTop: 4 }}>
                      {group.rows.map((row) => (
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
                          </div>
                          {rowControls(row)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
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
