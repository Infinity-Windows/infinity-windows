// "Mark 7: code 3672 decodes to 42" x 86" but the sheet prints 36" x 72"."
//
// The gap this closes: a 4-digit call size is decoded as feet+inches, which is
// right for this supplier and wrong for one that codes in inches. Decoded under
// the wrong convention a mark gets a size that is plainly wrong and looks
// perfectly normal on an installer's sheet. The dimensions printed on the
// drawing are the tie-breaker, and this is where a foreman is told they didn't
// agree.
//
// Same manners as SpecCoverageSummary: absent entirely when every mark checks
// out, so it only ever appears when there is something to do.

import {
  listSizeMismatches,
  type SizeCheckSpec,
} from "../../lib/install/printedSize";

interface Props {
  /** Extracted/saved spec rows for the project. */
  specs: SizeCheckSpec[];
}

export function SpecSizeWarnings({ specs }: Props) {
  const mismatches = listSizeMismatches(specs);
  if (mismatches.length === 0) return null;

  return (
    <div className="detail-card" style={{ marginTop: 8 }}>
      <strong className="warn-text">
        {mismatches.length === 1
          ? "1 mark's size code disagrees with the sheet"
          : `${mismatches.length} marks' size codes disagree with the sheet`}
      </strong>
      <p className="muted" style={{ marginTop: 4 }}>
        We're showing the dimensions printed on the drawing, not the ones the
        call size decodes to — check these before the crew orders or installs.
      </p>
      <ul
        className="muted"
        style={{ margin: "6px 0 0", paddingLeft: 16, display: "grid", gap: 2 }}
      >
        {mismatches.map((m) => (
          <li key={m.mark}>{m.message}</li>
        ))}
      </ul>
    </div>
  );
}
