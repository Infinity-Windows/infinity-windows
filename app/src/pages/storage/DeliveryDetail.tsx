// Check the truck against the list (owner, 2026-08-25). A logged delivery
// is a standby list of EXPECTED packages; this screen is the tailgate:
// tap boxes in as they arrive, rapid-split identical twins across conexes
// by COUNT (they're interchangeable — nobody cares which twin goes where),
// and read what never came. Material for a job that isn't built yet is
// fully receivable and storable; a foreman files it onto the job later.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { BackChip } from "../../components/BackChip";
import { listProjects } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import {
  filePendingPackages,
  listContainers,
  listDeliveries,
  listDeliveryPackages,
  receivePackages,
  storePackages,
  unreceivePackages,
} from "../../lib/storage";
import {
  groupDelivery,
  missingSummary,
  pickToReceive,
  pickToStore,
  pickToUndo,
  type DeliveryPackageLite,
  type JobGroup,
  type SlotRow,
} from "../../lib/warehouse/deliveryReceiving";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isForemanPlus } from "../../lib/install/types";

export function DeliveryDetail() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  const [message, setMessage] = useState<string | null>(null);
  const [storeCounts, setStoreCounts] = useState<Record<string, number>>({});
  const [storeTargets, setStoreTargets] = useState<Record<string, string>>({});
  const [filePick, setFilePick] = useState<Record<string, string>>({});

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
      // Crate pieces were logged riding in their crate: arriving puts them
      // straight back into it, one tap, one truth.
      if (args.row.isCrate && args.row.crateContainerId) {
        await storePackages(ids, args.row.crateContainerId);
      }
      return ids.length;
    },
    onSuccess: (n) => {
      setMessage(`${n} box${n === 1 ? "" : "es"} checked in.`);
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

  const groups = groupDelivery(
    (packages.data ?? []) as unknown as DeliveryPackageLite[],
  );
  const summary = missingSummary(groups);
  const jobCode = new Map((projects.data ?? []).map((p) => [p.id, p.job_code ?? p.name]));
  const storables = (containers.data ?? []).filter((c) => c.active !== false);

  const rowControls = (row: SlotRow) => {
    const missing = row.expectedIds.length;
    const loose = Math.max(row.looseIds.length, 1);
    const count = Math.min(storeCounts[row.key] ?? loose, loose);
    const target = storeTargets[row.key] ?? "";
    return (
      <div className="row-gap" style={{ flexWrap: "wrap", alignItems: "center" }}>
        <span className={missing === 0 ? "ok" : "warn-text"}>
          {row.received} of {row.expected} arrived
          {row.stored > 0 ? ` · ${row.stored} put away` : ""}
        </span>
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

      {groups.map((g) => (
        <section key={g.key} style={{ marginBottom: 16 }}>
          <h2 style={{ marginBottom: 4 }}>
            {g.projectId
              ? (jobCode.get(g.projectId) ?? "Job")
              : `“${g.pendingJobName}”`}
          </h2>
          {!g.projectId && (
            <div className="row-gap" style={{ alignItems: "center", marginBottom: 6 }}>
              <span className="muted" style={{ fontSize: 13 }}>
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
                <strong>{row.label}</strong>
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
