// The per-job materials ledger (owner-confirmed Q4, 2026-08-25): pick a
// job, see every mark's material split by stage — Expected · Arrived ·
// Stored · On site — with the crate count up top, adjustable to match
// whatever reality showed up. "Installed" is deliberately absent: that is
// the install loop's truth and lives on the job's own pages.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BackChip } from "../../components/BackChip";
import { EmptyState } from "../../components/ui/States";
import { StageChip } from "../../components/warehouse/StageChip";
import { listProjects } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import {
  addJobCrate,
  deletePackages,
  listActivePackages,
  setPieceCount,
} from "../../lib/storage";
import { groupPackagesByMark, truckLabel } from "../../lib/warehouse/jobMaterials";

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
  const projectId = params.get("job") ?? "";
  const [stage, setStage] = useState<Stage>("all");
  const [message, setMessage] = useState<string | null>(null);

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const packages = useQuery({
    queryKey: ["storagePackages"],
    queryFn: listActivePackages,
  });

  const mine = useMemo(
    () => (packages.data ?? []).filter((p) => p.project_id === projectId),
    [packages.data, projectId],
  );
  const crates = mine.filter((p) => p.part_type === "crate");
  const pool = mine.filter((p) => p.piece_count != null);
  const poolTotal = pool.reduce((s, p) => s + (p.piece_count ?? 0), 0);
  const boxes = mine.filter(
    (p) => p.part_type !== "crate" && p.piece_count == null,
  );

  const byMark = useMemo(() => groupPackagesByMark(boxes, pool), [boxes, pool]);

  const addCrate = useMutation({
    mutationFn: () => addJobCrate(projectId),
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

  const job = projects.data?.find((p) => p.id === projectId);

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

      <select
        value={projectId}
        onChange={(e) => setParams(e.target.value ? { job: e.target.value } : {})}
        aria-label="Which job"
        style={{ maxWidth: 360 }}
      >
        <option value="">— pick a job —</option>
        {(projects.data ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.job_code ?? p.name}
          </option>
        ))}
      </select>

      {message && <p className="scanner-hint">{message}</p>}

      {projectId && (
        <>
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
                disabled={addCrate.isPending}
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
            </div>
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
                  <strong>
                    {job?.job_code ?? ""} #{mark}
                  </strong>
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
            <Link to={`/projects/${projectId}?tab=map`} className="link">
              open the map
            </Link>
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
