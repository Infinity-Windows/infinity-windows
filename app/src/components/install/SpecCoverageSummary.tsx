// "22 of 24 marks complete · 1 missing drawing (18B) · 1 missing spec (7)".
//
// The gap this closes: a spec review screen with 24 rows on it LOOKS finished
// even when a mark lost its elevation drawing or came back blank. Comparing the
// marks the job's openings actually ask for against what was extracted is the
// only way a foreman finds out, and naming the marks is what makes it fixable.
//
// Deliberately quiet when everything is covered — one muted line, no card, no
// warning colour — so it never becomes noise on a healthy job.

import {
  computeSpecCoverage,
  describeSpecCoverage,
  isSpecCoverageComplete,
  type CoverageSpec,
} from "../../lib/install/specCoverage";

interface Props {
  /** Every opening code on the project ("14-18", "13A-1", …). */
  openingCodes: string[];
  /** Extracted/saved spec rows for the project. */
  specs: CoverageSpec[];
}

export function SpecCoverageSummary({ openingCodes, specs }: Props) {
  // Cheap enough to do inline — a few dozen marks, all string work.
  const coverage = computeSpecCoverage(openingCodes, specs);
  const line = describeSpecCoverage(coverage);
  if (!line) return null;

  if (isSpecCoverageComplete(coverage) && coverage.unexpected.length === 0) {
    return (
      <p className="muted" style={{ marginTop: 4 }}>
        {line} — every mark on this job has its specs and its drawing.
      </p>
    );
  }

  return (
    <div className="detail-card" style={{ marginTop: 8 }}>
      <strong>{line}</strong>
      <div style={{ display: "grid", gap: 2, marginTop: 6 }}>
        {coverage.missingSpec.length > 0 && (
          <p className="muted">
            No specs read for {listMarks(coverage.missingSpec)} — fill these in
            below, or re-read the specs sheet from the Plansets screen.
          </p>
        )}
        {coverage.missingDrawing.length > 0 && (
          <p className="muted">
            No elevation drawing for {listMarks(coverage.missingDrawing)} — the
            written specs are there, just not the picture.
          </p>
        )}
        {coverage.unexpected.length > 0 && (
          <p className="muted">
            {listMarks(coverage.unexpected)}{" "}
            {coverage.unexpected.length === 1 ? "was" : "were"} read off the
            specs sheet but no opening on this job uses{" "}
            {coverage.unexpected.length === 1 ? "it" : "them"} — usually a
            mis-read label.
          </p>
        )}
      </div>
    </div>
  );
}

/** "#18B" / "#7 and #18B" / "#7, #12 and #18B". */
function listMarks(marks: string[]): string {
  const labels = marks.map((m) => `#${m}`);
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
