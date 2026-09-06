// Jobs on the yard: one chip per job with material, in the job's own colour
// (the same hue the yard stripes its boxes with), a fill bar for units here
// versus expected, and a tap that lights up the boxes holding that job's
// material. The job code is a link to the materials ledger, as the old
// tally rows were.
import { Link } from "react-router-dom";
import type { JobChip } from "../../lib/warehouse/jobStrip";
import { scopeHref } from "../../lib/warehouse/materialsScope";

export function JobStrip({
  chips,
  selected,
  onSelect,
}: {
  chips: JobChip[];
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <section aria-label="Jobs with material">
      <h2 className="job-strip-title">Jobs with material</h2>
      <div className="job-strip" role="group" aria-label="Jobs with material">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`job-chip${selected === c.key ? " job-chip--on" : ""}${c.ready ? "" : " job-chip--waiting"}`}
            style={{ borderLeftColor: `oklch(0.62 0.15 ${c.hue})` }}
            onClick={() => onSelect(selected === c.key ? null : c.key)}
            aria-pressed={selected === c.key}
            title={selected === c.key ? "Tap again to stop highlighting" : "Tap to light up this job's boxes"}
          >
            <span className="job-chip-head">
              <Link
                to={scopeHref({ projectId: c.projectId, pendingName: c.pendingName })}
                onClick={(e) => e.stopPropagation()}
              >
                {c.projectId ? c.label : `“${c.label}”`}
              </Link>
              <span className={c.ready ? "ok" : ""}>{c.line}</span>
            </span>
            <span className="job-chip-bar" aria-hidden="true">
              <i style={{ width: `${c.total > 0 ? Math.round((c.here / c.total) * 100) : 0}%` }} />
            </span>
          </button>
        ))}
      </div>
      <p className="muted job-strip-hint">
        Units here of units expected. Tap a job to light up its boxes; tap the code for its materials.
      </p>
    </section>
  );
}
