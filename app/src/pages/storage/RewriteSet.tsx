// Wave R — "Rewrite this set" (owner grill 2026-08-28, the Mad Moose
// story): the manifest said mark #8 was 16 packages; the truck actually had
// 12 pieces of glass in one crate plus 4 frame packages. Fixing that used
// to mean editing fifteen slot cards by hand. This screen replaces that:
// declare the set as it actually is — a short list of composition lines —
// and ONE button, "Make it match," diffs the declaration against reality
// and applies it atomically (supabase/migrations/20260958000000_rewrite_set.sql).
//
// No RequireRole wrapper — same pattern the other storage pages use: the
// view stays open, the server (and `lead` here) gate the write.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { BackChip } from "../../components/BackChip";
import { SetEditor, type AddPieceStrategy } from "../../components/warehouse/SetEditor";
import { StationChip } from "../../components/warehouse/StationChip";
import { STATION_FIX_MISTAKE } from "../../lib/warehouse/stations";
import { listProjects } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import {
  addPartTypeOption,
  deletePackages,
  listActivePackages,
  listPartTypeOptions,
  packageTitle,
  rewriteSet,
  PART_TYPES,
  PART_LABELS,
  type PartType,
} from "../../lib/storage";
import {
  groupDelivery,
  setForMark,
  type DeliveryPackageLite,
} from "../../lib/warehouse/deliveryReceiving";
import { markOf } from "../../lib/warehouse/jobMaterials";
import {
  matchesScope,
  scopeFromParams,
  scopeHref,
} from "../../lib/warehouse/materialsScope";
import {
  groupExistingPackages,
  planRewrite,
  realityLine,
  type Packaging,
  type RewriteLine,
} from "../../lib/warehouse/rewriteSet";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { useT } from "../../lib/i18n";
import { isForemanPlus } from "../../lib/install/types";

const ARRIVED_STATUSES = new Set(["received", "stored", "checked_out"]);

export function RewriteSet() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const scope = scopeFromParams(params);
  const mark = (params.get("mark") ?? "").trim();
  const t = useT();
  const { effectiveRole } = useEffectiveRole();
  // ADR-0007: rewriting a set is the fix a person makes with the truck in
  // front of them, so every control below is open to any crew member.
  // `lead` now guards one thing — "Start this set over", which is
  // delete_packages, and delete stays foreman+.
  const lead = isForemanPlus(effectiveRole);

  const [message, setMessage] = useState<string | null>(null);
  const [showPieces, setShowPieces] = useState(false);
  const [newPartType, setNewPartType] = useState("");

  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const partOptions = useQuery({ queryKey: ["partTypeOptions"], queryFn: listPartTypeOptions });
  const partChoices = [
    ...PART_TYPES,
    ...(partOptions.data ?? []).filter((t) => !PART_TYPES.includes(t as PartType)),
  ];

  const job = scope.projectId ? projects.data?.find((p) => p.id === scope.projectId) : undefined;
  const jobCodeById = useMemo(
    () => new Map(job ? [[job.id, job.job_code ?? job.name]] : []),
    [job],
  );

  const mine = useMemo(
    () =>
      (packages.data ?? []).filter(
        (p) => mark !== "" && matchesScope(p, scope) && markOf(p) === mark,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [packages.data, scope.projectId, scope.pendingName, mark],
  );
  const existingGroups = useMemo(() => groupExistingPackages(mine), [mine]);
  const kindOf: "windows" | "doors" = mine[0]?.category === "doors" ? "doors" : "windows";
  const arrivedRowCount = mine.filter((p) => ARRIVED_STATUSES.has(p.status)).length;

  // Seed the declaration from reality exactly once, the first time packages
  // load — never again, so a background refetch (or an apply's own
  // invalidation) can't silently overwrite an edit in progress. "Start this
  // set over" sets `lines` to [] directly and leaves this seed alone.
  const seeded = useRef(false);
  const [lines, setLines] = useState<RewriteLine[]>([]);
  useEffect(() => {
    if (seeded.current || !packages.data) return;
    seeded.current = true;
    setLines(
      [...existingGroups.values()].map((g) => ({
        partType: g.partType,
        packaging: g.packaging,
        count: g.arrived + g.expected,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packages.data]);

  const updateLine = (i: number, patch: Partial<RewriteLine>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const removeLine = (i: number) => setLines((prev) => prev.filter((_, idx) => idx !== i));
  const addLine = () =>
    setLines((prev) => [...prev, { partType: null, packaging: "package", count: 1 }]);

  const addType = useMutation({
    mutationFn: (name: string) => addPartTypeOption(name),
    onSuccess: () => {
      setNewPartType("");
      void qc.invalidateQueries({ queryKey: ["partTypeOptions"] });
    },
  });

  const apply = useMutation({
    mutationFn: () =>
      rewriteSet({
        projectId: scope.projectId,
        pendingJobName: scope.pendingName,
        mark,
        lines,
        kind: kindOf === "doors" ? "door" : "window",
      }),
    onSuccess: (r) => {
      setMessage(`Matched: ${r.minted} minted, ${r.deleted} released.`);
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const makeItMatch = () => {
    // The client's own copy of the diff, checked FIRST: a bad plan reads
    // back instantly, offline-friendly, in the server's exact words — the
    // RPC re-derives and re-checks everything itself regardless, so this is
    // a courtesy, never the gate.
    const plan = planRewrite(existingGroups, lines);
    if (!plan.ok) {
      setMessage(plan.reason);
      return;
    }
    apply.mutate();
  };

  const startOver = useMutation({
    mutationFn: () => deletePackages(mine.map((p) => p.id)),
    onSuccess: (r) => {
      setMessage(
        r.refused.length > 0
          ? `Deleted ${r.deleted}. Refused: ${r.refused.map((x) => `${x.serial} (${x.reason})`).join("; ")}`
          : `Deleted ${r.deleted}. Declare the set from scratch below.`,
      );
      setLines([]);
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  // The "piece by piece" fallback (kept alive, collapsed): the exact set
  // editor DeliveryDetail and JobMaterials used to mount inline.
  const jobTitleFn = (pid: string) => jobCodeById.get(pid) ?? null;
  const deliveryGroup = useMemo(
    () => groupDelivery(mine as unknown as DeliveryPackageLite[], jobTitleFn)[0] ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mine],
  );
  const packagesById = useMemo(() => new Map(mine.map((p) => [p.id, p])), [mine]);

  if (mark === "") {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Rewrite this set</h1>
          <BackChip fallback="/warehouse" label="Warehouse" />
        </header>
        <p className="muted">No mark was given to rewrite — go back and pick a set to edit.</p>
      </div>
    );
  }

  const headerTitle = packageTitle(
    {
      project_id: scope.projectId,
      pending_job_name: scope.pendingName,
      mfr_mark: mark,
      part_index: null,
      part_total: null,
      part_type: null,
      piece_count: null,
      serial: mark,
    },
    jobCodeById,
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">{kindOf === "doors" ? "Door" : "Window"}</p>
          <h1>{headerTitle}</h1>
        </div>
        <BackChip fallback={scopeHref(scope)} label="Back" />
      </header>
      <StationChip station={STATION_FIX_MISTAKE} />

      {message && <p className="scanner-hint">{message}</p>}

      <div className="detail-card">
        <h2 style={{ marginTop: 0 }}>The set, declared</h2>
        <ul className="unit-list">
          {lines.map((line, i) => {
            const reality = realityLine(line, existingGroups);
            return (
              <li key={i} className="opening-review-row">
                <div className="wh-row">
                  <button
                    className="button-like"
                    disabled={line.count <= 0}
                    onClick={() => updateLine(i, { count: Math.max(0, line.count - 1) })}
                    aria-label={`Fewer on line ${i + 1}`}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min={0}
                    max={line.packaging === "crate_pool" ? 99 : 20}
                    value={line.count}
                    onChange={(e) => updateLine(i, { count: Math.max(0, Number(e.target.value) || 0) })}
                    aria-label={`How many on line ${i + 1}`}
                    style={{ width: 60 }}
                  />
                  <button
                    className="button-like"
                    onClick={() =>
                      updateLine(i, {
                        count: Math.min(
                          line.packaging === "crate_pool" ? 99 : 20,
                          line.count + 1,
                        ),
                      })
                    }
                    aria-label={`More on line ${i + 1}`}
                  >
                    +
                  </button>
                  <select
                    value={line.partType ?? ""}
                    onChange={(e) => updateLine(i, { partType: e.target.value || null })}
                    aria-label={`What is line ${i + 1}`}
                  >
                    <option value="">— what is it? —</option>
                    {partChoices.map((t) => (
                      <option key={t} value={t}>
                        {PART_LABELS[t as PartType] ?? t}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={line.packaging === "package" ? "button-like active-pill" : "button-like"}
                    aria-pressed={line.packaging === "package"}
                    aria-label={`Packages, line ${i + 1}`}
                    onClick={() => updateLine(i, { packaging: "package" as Packaging })}
                  >
                    packages
                  </button>
                  <button
                    type="button"
                    className={
                      line.packaging === "crate_pool" ? "button-like active-pill" : "button-like"
                    }
                    aria-pressed={line.packaging === "crate_pool"}
                    aria-label={`Pieces in a crate, line ${i + 1}`}
                    onClick={() => updateLine(i, { packaging: "crate_pool" as Packaging })}
                  >
                    pieces in a crate
                  </button>
                  {/* Removing a LINE only changes the declaration — the
                      apply below still refuses to delete arrived material,
                      so this is not a delete door (ADR-0007). */}
                  <button
                    className="link"
                    style={{ color: "var(--danger)" }}
                    onClick={() => removeLine(i)}
                    aria-label={`Remove line ${i + 1}`}
                  >
                    remove
                  </button>
                </div>
                <p className="wh-row-sub" style={{ margin: "2px 0 0" }}>
                  {reality.label} — {reality.arrived} of {reality.count} arrived
                </p>
              </li>
            );
          })}
        </ul>
        <div className="wh-row" style={{ marginTop: 6 }}>
          <button className="button-like" onClick={addLine}>
            + add line
          </button>
          <input
            value={newPartType}
            onChange={(e) => setNewPartType(e.target.value)}
            placeholder="Add a label, e.g. door handle"
            aria-label="Add a new part label"
            maxLength={40}
            style={{ width: 180 }}
          />
          <button
            className="button-like"
            disabled={!newPartType.trim() || addType.isPending}
            onClick={() => addType.mutate(newPartType.trim())}
          >
            Add label
          </button>
        </div>
        <div className="wh-row" style={{ marginTop: 10 }}>
          <button className="primary" disabled={apply.isPending} onClick={makeItMatch}>
            {apply.isPending ? "Matching…" : "Make it match"}
          </button>
        </div>
      </div>

      {/* The one door on this page that is still a rank: starting over is
          delete_packages, and delete stays foreman+ (ADR-0007). Say so
          plainly where the card would be, rather than showing nothing. */}
      {!lead && (
        <p className="muted" style={{ fontSize: 13 }}>
          {t("rewriteSet.startOverIsLeadOnly")}
        </p>
      )}
      {lead && (
        <div className="detail-card" style={{ borderColor: "var(--danger)" }}>
          <h2 style={{ marginTop: 0 }}>Start this set over</h2>
          <p className="muted" style={{ fontSize: 13 }}>
            Deletes every package in this set, including anything already arrived. The
            declaration above goes blank and you build it back up from nothing.
          </p>
          <button
            className="button-like"
            style={{ color: "var(--danger)" }}
            disabled={mine.length === 0 || startOver.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `Delete all ${mine.length}, including ${arrivedRowCount} already arrived?`,
                )
              ) {
                startOver.mutate();
              }
            }}
          >
            Delete all {mine.length}…
          </button>
        </div>
      )}

      <div className="wh-row" style={{ marginTop: 10 }}>
        <button className="link" onClick={() => setShowPieces((v) => !v)}>
          {showPieces ? "Hide piece by piece" : "Piece by piece (advanced)"}
        </button>
      </div>
      {showPieces &&
        (() => {
          if (!deliveryGroup) return <p className="muted">Nothing to show piece by piece yet.</p>;
          const set = setForMark(deliveryGroup, mark);
          if (set.slots.length === 0) {
            return <p className="muted">Nothing to show piece by piece yet.</p>;
          }
          const addPieceStrategy: AddPieceStrategy = {
            kind: "unavailable",
            message: "Add pieces through the declaration above, then Make it match.",
          };
          return (
            <SetEditor
              scope={scope}
              set={set}
              packagesById={packagesById}
              partChoices={partChoices}
              lead={lead}
              onClose={() => setShowPieces(false)}
              onChanged={() => void qc.invalidateQueries({ queryKey: ["storagePackages"] })}
              onMessage={setMessage}
              addPieceStrategy={addPieceStrategy}
              deleteScopeLabel="this set"
            />
          );
        })()}
    </div>
  );
}
