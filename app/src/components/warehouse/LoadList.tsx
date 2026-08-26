// "Make the load list" (owner pick 27): every stored package for a job,
// grouped by container and ordered for pulling — tick-tick-tick instead of
// memory. Ticks are working state, not data: they live in localStorage
// (JobMaterials owns the read/write; this component only renders what it is
// given and reports taps back up) so a refresh or a walk to the yard keeps
// the list, and "Clear ticks" starts over without touching anything real.
import { Link } from "react-router-dom";
import { EmptyState } from "../ui/States";
import { PackageRowText } from "./PackageRowText";
import { ContainerBadge } from "./ContainerBadge";
import { StageChip } from "./StageChip";
import type { StorageContainer, StoragePackage } from "../../lib/storage";
import { buildLoadList } from "../../lib/warehouse/loadList";

export function LoadList({
  packages,
  containers,
  jobCode,
  ticked,
  onToggle,
  onClear,
}: {
  /** The job's own packages, any status — this component does its own
   *  "stored" filtering so the caller never has to remember to. */
  packages: StoragePackage[];
  containers: StorageContainer[];
  jobCode: Map<string, string>;
  ticked: ReadonlySet<string>;
  onToggle: (packageId: string) => void;
  onClear: () => void;
}) {
  const stored = packages.filter((p) => p.status === "stored");
  const byId = new Map(stored.map((p) => [p.id, p]));
  const summary = buildLoadList(stored, containers, ticked);

  if (summary.totalCount === 0) {
    return (
      <EmptyState
        title="Nothing stored for this job yet."
        action={
          <Link className="button-like active-pill" to="/storage/deliveries">
            Deliveries
          </Link>
        }
      />
    );
  }

  return (
    <div className="load-list">
      <div className="wh-row" style={{ marginBottom: 4 }}>
        <span className="wh-count">
          {summary.pickedCount} of {summary.totalCount}
        </span>{" "}
        <span className="wh-count-label">picked</span>
        <button
          type="button"
          className="button-like"
          style={{ marginLeft: "auto" }}
          disabled={summary.pickedCount === 0}
          onClick={onClear}
        >
          Clear ticks
        </button>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: "0 0 12px" }}>
        Ticks are your working list — checking out still happens at{" "}
        <Link to="/storage/out" className="link">
          Set aside / check out
        </Link>
        .
      </p>

      {summary.groups.map((g) => (
        <section key={g.containerId || "none"} style={{ marginBottom: 14 }}>
          <div className="wh-row" style={{ marginBottom: 4 }}>
            {g.containerId && <ContainerBadge name={g.containerName} serial={g.containerSerial} />}
            <strong>{g.containerName}</strong>
            {g.address && <span className="wh-row-sub">{g.address}</span>}
            <span style={{ marginLeft: "auto" }}>
              {g.complete ? (
                <StageChip stage="stored">
                  {g.pickedCount} of {g.totalCount}
                </StageChip>
              ) : (
                <span className="wh-count">
                  {g.pickedCount} of {g.totalCount}
                </span>
              )}
            </span>
          </div>
          <ul className="unit-list">
            {g.rows.map((row) => {
              const p = byId.get(row.id);
              if (!p) return null;
              return (
                <li key={row.id} className="opening-review-row">
                  <label className="wh-row">
                    <input
                      type="checkbox"
                      checked={row.picked}
                      onChange={() => onToggle(row.id)}
                      aria-label={`Pick ${p.short_code ?? p.serial}`}
                    />
                    <PackageRowText
                      p={p}
                      jobCode={jobCode}
                      extra={
                        row.isPool
                          ? `${row.pieceCount} piece${row.pieceCount === 1 ? "" : "s"}`
                          : undefined
                      }
                    />
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
