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
import {
  filePendingPackages,
  labelPackages,
  listContainers,
  listDeliveries,
  listDeliveryPackages,
  listPartTypeOptions,
  receivePackages,
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
    onSuccess: (n) => {
      setMessage(`Stored ${n}.`);
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const bundleStore = useMutation({
    mutationFn: async (args: { ids: string[]; container: string }) => {
      await storePackages(args.ids, args.container);
      return args.ids.length;
    },
    onSuccess: (n) => {
      setMessage(`Stored ${n} together.`);
      setBundle(new Set());
      setBundleMode(false);
      setConfirmMix(false);
      setBundleTarget("");
      refresh();
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

  // The bundle: rows ticked across ANY jobs — they came on the same truck.
  const allRows = new Map(groups.flatMap((g) => g.rows.map((r) => [r.key, r])));
  const rowJob = new Map(
    groups.flatMap((g) => g.rows.map((r) => [r.key, g.key])),
  );
  const bundleRows = [...bundle]
    .map((k) => allRows.get(k))
    .filter((r): r is SlotRow => !!r && r.looseIds.length > 0);
  const bundleIds = bundleRows.flatMap((r) => r.looseIds);
  const bundleJobs = new Set(bundleRows.map((r) => rowJob.get(r.key)));
  const bundleTargetContainer = storables.find((c) => c.id === bundleTarget) ?? null;
  const toggleBundle = (key: string) =>
    setBundle((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const fireBundle = () => {
    if (bundleJobs.size > 1 && !confirmMix) {
      setConfirmMix(true);
      return;
    }
    bundleStore.mutate({ ids: bundleIds, container: bundleTarget });
  };

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
                      checked={bundle.has(row.key)}
                      disabled={row.looseIds.length === 0}
                      onChange={() => toggleBundle(row.key)}
                      aria-label={`Select ${row.label}`}
                    />
                  )}
                  <strong>{row.label}</strong>
                </div>
                {rowControls(row)}
              </li>
            ))}
          </ul>
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
