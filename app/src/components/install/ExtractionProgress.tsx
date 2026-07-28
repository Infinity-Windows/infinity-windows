// Progress bar for a specs-planset extraction.
//
// Extraction reads the sheet a page at a time in the browser, which can take
// minutes on a 14-page shop drawing. A spinner gave the crew no way to judge
// whether to wait, so this shows the real thing: how far through the pages we
// are, how many marks have landed, and which pages need another go.

import type { ExtractionProgress as Progress } from "../../lib/install/extractionProgress";
import { describeProgress } from "../../lib/install/extractionProgress";

interface Props {
  progress: Progress;
  /** Page currently being read, when a run is live in this tab. */
  activePage: number | null;
  /** Shown while a run is live so the crew can stop instead of navigating away. */
  onStop?: () => void;
  /** Offered for a run that stopped part-way through. */
  onResume?: () => void;
  resuming?: boolean;
  /** Extra line under the bar (e.g. why the last run stopped). */
  note?: string | null;
}

export function ExtractionProgress({
  progress,
  activePage,
  onStop,
  onResume,
  resuming = false,
  note,
}: Props) {
  const running = activePage != null;
  const { percent, total, attempted, failed } = progress;

  return (
    <div className="detail-card extraction-progress" style={{ marginTop: 12 }}>
      <div className="extraction-progress-head">
        <strong>{running ? "Reading the specs sheet" : "Specs extraction"}</strong>
        <span className="muted">{total > 0 ? `${percent}%` : ""}</span>
      </div>

      <div
        className="extraction-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total || 100}
        aria-valuenow={attempted}
        aria-valuetext={describeProgress(progress, activePage)}
      >
        <div
          className={`extraction-progress-fill${running ? " live" : ""}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <p className="muted" style={{ marginTop: 6 }}>
        {describeProgress(progress, activePage)}
      </p>

      {failed.length > 0 && (
        <p className="muted">
          {failed.length === 1 ? "Page" : "Pages"} {failed.join(", ")}{" "}
          {failed.length === 1 ? "needs" : "need"} another go — resuming retries{" "}
          {failed.length === 1 ? "it" : "them"}.
        </p>
      )}

      {note && <p className="muted">{note}</p>}

      {running && onStop && (
        <button type="button" className="action-btn" onClick={onStop}>
          Stop — keep what's done
        </button>
      )}

      {!running && onResume && (
        <button
          type="button"
          className="action-btn primary"
          disabled={resuming}
          onClick={onResume}
        >
          {resuming ? "Resuming…" : "Resume extraction"}
        </button>
      )}
    </div>
  );
}
