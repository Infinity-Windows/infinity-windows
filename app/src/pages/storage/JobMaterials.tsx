// The materials ledger (owner-confirmed Q4, 2026-08-25; wave M rebuild
// 2026-08-28): pick a job — built or still waiting on one — see every
// mark's material split by stage — Expected · Arrived · Stored · On site —
// with the crate count up top, adjustable to match whatever reality showed
// up. "Installed" is deliberately absent: that is the install loop's truth
// and lives on the job's own pages.
//
// Wave M's owner ask: "I want this and the delivery log to almost be
// interchangeable. If I make an edit here, I make an edit there, period."
// So the ledger now covers WAITING jobs too (pending_job_name, no project
// row yet — the owner's whole live inventory is waiting-job material) and
// mounts the same set editor DeliveryDetail uses (#433), inline per mark.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BackChip } from "../../components/BackChip";
import { EmptyState } from "../../components/ui/States";
import { StageChip } from "../../components/warehouse/StageChip";
import { SetEditor, type AddPieceStrategy } from "../../components/warehouse/SetEditor";
import { jobTallies, tallyLine } from "../../lib/warehouse/jobTally";
import { LoadList } from "../../components/warehouse/LoadList";
import { listProjects } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import {
  addCrateSupplies,
  addJobCrate,
  deletePackages,
  listActivePackages,
  listContainers,
  listDeliveries,
  listPartTypeOptions,
  setPieceCount,
  PART_TYPES,
  type PartType,
} from "../../lib/storage";
import { groupPackagesByMark, truckLabel } from "../../lib/warehouse/jobMaterials";
import {
  groupDelivery,
  setForMark,
  type DeliveryPackageLite,
} from "../../lib/warehouse/deliveryReceiving";
import {
  distinctPendingJobNames,
  hasScope,
  matchesScope,
  scopeFromParams,
  scopeKey,
} from "../../lib/warehouse/materialsScope";
import {
  loadListStorageKey,
  parseTicked,
  serializeTicked,
} from "../../lib/warehouse/loadList";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isForemanPlus } from "../../lib/install/types";

type Stage = "all" | "minted" | "received" | "stored" | "checked_out";
const STAGE_LABELS: Record<Exclude<Stage, "all">, string> = {
  minted: "Expected",
  received: "Arrived",
  stored: "Stored",
  checked_out: "On site",
};

export function JobMaterials() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  // Wave M: the scope is a union — a real job by id (?job=) or a waiting
  // job by its typed name (?pending=), never both.
  const scope = scopeFromParams(params);
  const scoped = hasScope(scope);
  const scopeParams: Record<string, string> = scope.projectId
    ? { job: scope.projectId }
    : scope.pendingName
      ? { pending: scope.pendingName }
      : {};
  // Pick 27: same route, `?list=1` — a refresh or the back button while
  // standing at a truck keeps the page in load-list mode instead of
  // bouncing back to the ledger.
  const listMode = params.get("list") === "1";
  const [stage, setStage] = useState<Stage>("all");
  const [message, setMessage] = useState<string | null>(null);
  const [editMark, setEditMark] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(() =>
    scoped ? parseTicked(localStorage.getItem(loadListStorageKey(scopeKey(scope)))) : new Set(),
  );

  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const packages = useQuery({
    queryKey: ["storagePackages"],
    queryFn: listActivePackages,
  });
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const deliveries = useQuery({ queryKey: ["deliveries"], queryFn: listDeliveries });
  const partOptions = useQuery({
    queryKey: ["partTypeOptions"],
    queryFn: listPartTypeOptions,
  });
  const partChoices = [
    ...PART_TYPES,
    ...(partOptions.data ?? []).filter((t) => !PART_TYPES.includes(t as PartType)),
  ];

  const pendingJobNames = useMemo(
    () => distinctPendingJobNames(packages.data ?? []),
    [packages.data],
  );

  // A different job's load list can open without this component ever
  // unmounting (same route, only the scope changes) — re-read that job's
  // own ticks rather than carrying the previous job's along.
  const key = scopeKey(scope);
  useEffect(() => {
    setTicked(scoped ? parseTicked(localStorage.getItem(loadListStorageKey(key))) : new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scoped]);

  const toggleTick = (packageId: string) => {
    if (!scoped) return;
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(packageId)) next.delete(packageId);
      else next.add(packageId);
      localStorage.setItem(loadListStorageKey(key), serializeTicked(next));
      return next;
    });
  };
  const clearTicks = () => {
    if (!scoped) return;
    setTicked(new Set());
    localStorage.removeItem(loadListStorageKey(key));
  };

  const mine = useMemo(
    () => (packages.data ?? []).filter((p) => matchesScope(p, scope)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [packages.data, scope.projectId, scope.pendingName],
  );
  const crates = mine.filter((p) => p.part_type === "crate");
  const pool = mine.filter((p) => p.piece_count != null);
  const poolTotal = pool.reduce((s, p) => s + (p.piece_count ?? 0), 0);
  const boxes = mine.filter(
    (p) => p.part_type !== "crate" && p.piece_count == null,
  );

  const byMark = useMemo(() => groupPackagesByMark(boxes, pool), [boxes, pool]);

  const job = scope.projectId ? projects.data?.find((p) => p.id === scope.projectId) : undefined;
  // The load list is always one job at a time, so this only ever needs the
  // one entry — PackageRowText takes a map because every OTHER screen that
  // uses it shows several jobs at once. Empty for a waiting job: its
  // packages carry no project_id, so PackageRowText reads pending_job_name
  // directly rather than through this map.
  const jobCodeMap = useMemo(
    () => new Map(scope.projectId && job ? [[scope.projectId, job.job_code ?? job.name]] : []),
    [job, scope.projectId],
  );
  const scopeLabel = job?.job_code ?? (scope.pendingName ? `“${scope.pendingName}”` : "");

  // The same grouping DeliveryDetail's tailgate uses (setForMark-shaped),
  // reused rather than reinvented — the set editor mounts identically on
  // both screens off the same pure logic. jobCodeMap only ever has an entry
  // for a real job's own id, so a waiting scope's rows fall through to
  // their own pending_job_name, same as groupDelivery always does.
  const deliveryGroup = useMemo(
    () =>
      groupDelivery(
        mine as unknown as DeliveryPackageLite[],
        (pid) => jobCodeMap.get(pid) ?? null,
      )[0] ?? null,
    [mine, jobCodeMap],
  );
  const packagesById = useMemo(() => new Map(mine.map((p) => [p.id, p])), [mine]);
  const deliveryLabel = (deliveryId: string) =>
    deliveries.data?.find((d) => d.id === deliveryId)?.label ?? "a delivery";

  const [supplyOpen, setSupplyOpen] = useState(false);
  const [supplyForm, setSupplyForm] = useState({ name: "", pieces: "1" });
  const addSupply = useMutation({
    mutationFn: (args: { partType: string; pieces: number }) =>
      addCrateSupplies({
        projectId: scope.projectId,
        jobName: scope.pendingName,
        partType: args.partType,
        pieces: args.pieces,
      }),
    onSuccess: (_r, args) => {
      setMessage(
        `${args.pieces} × ${args.partType} logged into the crates.`,
      );
      setSupplyForm({ name: "", pieces: "1" });
      setSupplyOpen(false);
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  // add_job_crate needs a real job id (owner ask never asked for a waiting-
  // job crate count; the RPC has no name argument, unlike add_crate_supplies
  // above) — the button stays disabled on a waiting job rather than firing a
  // call built to fail.
  const addCrate = useMutation({
    mutationFn: () => {
      if (!scope.projectId) throw new Error("Pick a built job first.");
      return addJobCrate(scope.projectId);
    },
    onSuccess: () => {
      setMessage("One more crate on the job.");
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const removeCrate = useMutation({
    mutationFn: async () => {
      // Newest loose crate goes first; a stored crate is deleted from its
      // own screen, where its location is in front of you.
      const loose = crates.filter((c) => c.status === "received");
      if (loose.length === 0) {
        throw new Error(
          "Every crate here is stored or out — break one up from its own screen.",
        );
      }
      const r = await deletePackages([loose[loose.length - 1].id]);
      if (r.refused.length > 0) throw new Error(r.refused[0].reason);
    },
    onSuccess: () => {
      setMessage("Crate removed.");
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const stageCount = (counts: Record<string, number>, s: Exclude<Stage, "all">) =>
    counts[s] ?? 0;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Warehouse</p>
          <h1>Job materials</h1>
        </div>
        <BackChip fallback="/warehouse" label="Warehouse" />
      </header>

      {/* One picker, two groups (wave M): a built job by id, or a waiting
          job by the name it was typed at the truck. */}
      <select
        value={scope.projectId ?? (scope.pendingName ? `pending:${scope.pendingName}` : "")}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) {
            setParams({});
          } else if (v.startsWith("pending:")) {
            setParams({ pending: v.slice("pending:".length) });
          } else {
            setParams({ job: v });
          }
        }}
        aria-label="Which job"
        style={{ maxWidth: 360 }}
      >
        <option value="">— pick a job —</option>
        <optgroup label="Built jobs">
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.job_code ?? p.name}
            </option>
          ))}
        </optgroup>
        {pendingJobNames.length > 0 && (
          <optgroup label="Waiting jobs">
            {pendingJobNames.map((name) => (
              <option key={name} value={`pending:${name}`}>
                “{name}”
              </option>
            ))}
          </optgroup>
        )}
      </select>

      {message && <p className="scanner-hint">{message}</p>}

      {scoped && (
        <div className="wh-row" style={{ margin: "10px 0 0" }}>
          <button
            type="button"
            className="button-like active-pill"
            onClick={() =>
              setParams(listMode ? scopeParams : { ...scopeParams, list: "1" })
            }
          >
            {listMode ? "Back to materials" : "Make the load list"}
          </button>
        </div>
      )}

      {scoped && listMode && (
        <LoadList
          packages={mine}
          containers={containers.data ?? []}
          jobCode={jobCodeMap}
          ticked={ticked}
          onToggle={toggleTick}
          onClear={clearTicks}
        />
      )}

      {scoped && !listMode && (
        <>
          {/* The owner's exact ask (2026-08-26): "mad moose 20/22, 2
              remaining" — units logged vs the manifest, for THIS job. */}
          {(() => {
            const t = jobTallies(mine, jobCodeMap)[0];
            return t ? (
              <p style={{ margin: "6px 0 0" }}>
                <span className="wh-count">{tallyLine(t)}</span>{" "}
                <span className="wh-count-label">
                  unit{t.totalUnits === 1 ? "" : "s"} logged
                </span>
              </p>
            ) : null;
          })()}
          <div className="detail-card" style={{ margin: "10px 0" }}>
            <div className="wh-row">
              <span className="wh-count">{crates.length}</span>{" "}
              <span className="wh-count-label">
                crate{crates.length === 1 ? "" : "s"}
              </span>
              <span className="muted">
                — between them {poolTotal} piece{poolTotal === 1 ? "" : "s"} of
                crate glass
              </span>
              <button
                className="button-like"
                disabled={addCrate.isPending || !scope.projectId}
                title={
                  scope.projectId
                    ? undefined
                    : "Crates start on a delivery for waiting jobs — add one from the truck."
                }
                onClick={() => addCrate.mutate()}
              >
                + crate
              </button>
              <button
                className="button-like"
                disabled={removeCrate.isPending || crates.length === 0}
                onClick={() => {
                  if (
                    window.confirm(
                      "Remove one crate from this job? The pool numbers stay until you edit them.",
                    )
                  ) {
                    removeCrate.mutate();
                  }
                }}
              >
                − crate
              </button>
              <button
                className="button-like"
                onClick={() => setSupplyOpen((v) => !v)}
              >
                {supplyOpen ? "Close" : "Log supplies…"}
              </button>
            </div>
            {/* Supplies thrown in with the glass (owner ask, 2026-08-26):
                caulk in a crate becomes a pool row — "(in the crates)" —
                counted down as it gets used, deleted when gone. */}
            {supplyOpen && (
              <div className="wh-row" style={{ marginTop: 6 }}>
                <input
                  value={supplyForm.name}
                  onChange={(e) =>
                    setSupplyForm((prev) => ({ ...prev, name: e.target.value }))
                  }
                  placeholder="What is it? (caulk, foam…)"
                  aria-label="What supply rides in the crates"
                  maxLength={40}
                  style={{ width: 190 }}
                />
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={supplyForm.pieces}
                  onChange={(e) =>
                    setSupplyForm((prev) => ({ ...prev, pieces: e.target.value }))
                  }
                  aria-label="How many pieces"
                  style={{ width: 70 }}
                />
                <button
                  className="primary"
                  disabled={
                    addSupply.isPending ||
                    !supplyForm.name.trim() ||
                    !supplyForm.pieces.trim()
                  }
                  onClick={() =>
                    addSupply.mutate({
                      partType: supplyForm.name.trim().toLowerCase(),
                      pieces: Number(supplyForm.pieces),
                    })
                  }
                >
                  {addSupply.isPending ? "Logging…" : "Add to the crates"}
                </button>
              </div>
            )}
            {crates.length > 0 && (
              <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
                {crates.map((c, i) => (
                  <span key={c.id}>
                    {i > 0 ? " · " : ""}
                    <Link to={`/pkg/${c.serial}`} className="link">
                      {(c.mfr_mark ?? "Crate").toLowerCase().replace(/(^|\s)\S/g, (ch) => ch.toUpperCase())}
                    </Link>
                  </span>
                ))}
              </p>
            )}
          </div>

          <div className="wh-row" style={{ marginBottom: 8 }}>
            <button
              className={stage === "all" ? "button-like active-pill" : "button-like"}
              onClick={() => setStage("all")}
            >
              Everything
            </button>
            {(Object.keys(STAGE_LABELS) as Exclude<Stage, "all">[]).map((s) => (
              <button
                key={s}
                role="button"
                aria-pressed={stage === s}
                data-stage={s}
                className="stage-chip"
                onClick={() => setStage(s)}
              >
                {STAGE_LABELS[s]}
              </button>
            ))}
          </div>

          <ul className="unit-list">
            {byMark
              .filter(
                ([, row]) =>
                  stage === "all" || stageCount(row.counts, stage as Exclude<Stage, "all">) > 0,
              )
              .map(([mark, row]) => (
                <li key={mark} className="opening-review-row">
                  <div className="wh-row">
                    <strong>
                      {scopeLabel} #{mark}
                    </strong>
                    {/* Wave M: full access to editing every set, right on
                        the ledger — same editor DeliveryDetail's tailgate
                        uses. */}
                    <button
                      className="link"
                      onClick={() => setEditMark(mark)}
                      aria-label={`Edit set #${mark}`}
                    >
                      Edit…
                    </button>
                  </div>
                  <div className="row-gap">
                    {(Object.keys(STAGE_LABELS) as Exclude<Stage, "all">[])
                      .filter((s) => stageCount(row.counts, s) > 0)
                      .map((s) => (
                        // Count first, stage after (pick 2 + pick 1) — "3
                        // Expected" rather than "Expected 3".
                        <StageChip key={s} stage={s}>
                          {stageCount(row.counts, s)} {STAGE_LABELS[s]}
                        </StageChip>
                      ))}
                    {(Object.keys(STAGE_LABELS) as Exclude<Stage, "all">[]).every(
                      (s) => stageCount(row.counts, s) === 0,
                    ) && <span className="muted">nothing yet</span>}
                  </div>
                  {/* Wave M, "against what's coming in": a mark with minted
                      pieces links straight to whichever delivery(ies) still
                      owe it, instead of only naming the Expected count. */}
                  {row.mintedDeliveryIds.length > 0 && (
                    <p className="wh-row-sub" style={{ margin: "2px 0 0" }}>
                      {stageCount(row.counts, "minted")} still coming —{" "}
                      {row.mintedDeliveryIds.map((did, i) => (
                        <span key={did}>
                          {i > 0 ? ", " : ""}
                          <Link to={`/storage/d/${did}`} className="link">
                            {deliveryLabel(did)}
                          </Link>
                        </span>
                      ))}
                    </p>
                  )}
                  {row.poolRows.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {row.poolRows.map((pr) => (
                        <PoolRowEditor
                          key={pr.id}
                          packageId={pr.id}
                          pieceCount={pr.pieceCount}
                          // One row needs no qualifier; more than one — say
                          // which truck's worth this line is, so editing the
                          // right one doesn't mean guessing.
                          label={row.poolRows.length > 1 ? truckLabel(pr.boundAt) : null}
                          onSaved={() =>
                            void qc.invalidateQueries({ queryKey: ["storagePackages"] })
                          }
                        />
                      ))}
                    </div>
                  )}
                  {editMark === mark &&
                    deliveryGroup &&
                    (() => {
                      const set = setForMark(deliveryGroup, mark);
                      if (set.slots.length === 0) return null;
                      const addPieceStrategy: AddPieceStrategy = {
                        kind: "unavailable",
                        message: (
                          <>
                            Add pieces from a truck (
                            <Link to="/storage/log-delivery" className="link">
                              log a delivery
                            </Link>
                            ) or a conex check-in (pick a container in{" "}
                            <Link to="/warehouse#in-storage" className="link">
                              the warehouse
                            </Link>
                            ).
                          </>
                        ),
                      };
                      return (
                        <SetEditor
                          scope={scope}
                          set={set}
                          packagesById={packagesById}
                          partChoices={partChoices}
                          lead={lead}
                          onClose={() => setEditMark(null)}
                          onChanged={() =>
                            void qc.invalidateQueries({ queryKey: ["storagePackages"] })
                          }
                          onMessage={setMessage}
                          addPieceStrategy={addPieceStrategy}
                          deleteScopeLabel="this job's material"
                        />
                      );
                    })()}
                </li>
              ))}
          </ul>
          {byMark.length === 0 && (
            <EmptyState
              title="No material logged for this job yet."
              action={
                <Link className="button-like active-pill" to="/storage/log-delivery">
                  Log a delivery for this job
                </Link>
              }
            />
          )}
          <p className="wh-row-sub">
            Installed lives on the job&rsquo;s own pages —{" "}
            {scope.projectId ? (
              <Link to={`/projects/${scope.projectId}?tab=map`} className="link">
                open the map
              </Link>
            ) : (
              <span className="muted">available once the job is built</span>
            )}
            .
          </p>
        </>
      )}
    </div>
  );
}

/**
 * One pool row, editable inline (ticket 23) — same small-input-plus-Save
 * shape as the package screen's own pool editor (PackageSheet.tsx), which
 * stays as the backup path for editing one specific package directly.
 */
function PoolRowEditor({
  packageId,
  pieceCount,
  label,
  onSaved,
}: {
  packageId: string;
  pieceCount: number;
  label: string | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState("");
  const save = useMutation({
    mutationFn: (n: number) => setPieceCount(packageId, n),
    onSuccess: () => {
      setDraft("");
      onSaved();
    },
  });
  const shown = draft || String(pieceCount);
  const n = Number(shown);
  const invalid = shown.trim() === "" || !Number.isFinite(n) || n < 1;
  return (
    <div className="wh-row">
      <input
        type="number"
        min={1}
        max={99}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        style={{ width: 70 }}
        aria-label={label ? `Glass count, ${label}` : "Glass count"}
      />
      <span className="wh-row-sub">
        glass{label ? ` (${label})` : ""}
      </span>
      <button
        className="button-like"
        disabled={invalid || save.isPending}
        onClick={() => save.mutate(n)}
      >
        {save.isPending ? "Saving…" : "Save"}
      </button>
      {save.isError && (
        <span className="error" style={{ fontSize: 12 }}>
          {formatApiError(save.error)}
        </span>
      )}
    </div>
  );
}
