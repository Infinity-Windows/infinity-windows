// Everything about the paperwork behind the map, in one section that starts
// closed.
//
// These blocks — which planset is selected, which file is being viewed, what the
// last extraction found, the index of manufacturer detail sheets — used to stack
// above and below the drawing on every visit. They matter when you are setting a
// job up, and never again. An installer opening the map to find their next
// window should not have to scroll past a setup console to reach the plan.

import type { ExtractOutcomeSummary } from "../../lib/install/extract";
import type { CadDetailPage } from "../../lib/install/planDetails";
import type { Planset } from "../../lib/install/types";

export type DrawingView = "outline" | "building" | "details";

/** Filenames are how a lead recognises which upload they are looking at. */
function plansetLabel(ps: Planset): string {
  return ps.storage_path.split("/").pop() ?? ps.storage_path;
}

export interface PlansPanelProps {
  buildingPdfs: Planset[];
  specsPdfs: Planset[];
  buildingPdf: Planset | null;
  specsPdf: Planset | null;
  activePlanset: Planset | null;
  view: DrawingView;
  page: number;
  floorPages: number[];
  details: CadDetailPage[];
  extractNote: string | null;
  extractSummary: ExtractOutcomeSummary | null;
  /** Foreman+. Re-reading a planset rebuilds the job's whole mark list. */
  isLead: boolean;
  reextractPending: boolean;
  onReextract: () => void;
  onPickBuildingPlanset: (plansetId: string) => void;
  onPickSpecsPlanset: (plansetId: string) => void;
  onShowView: (view: DrawingView, page?: number) => void;
}

export function PlansPanel({
  buildingPdfs,
  specsPdfs,
  buildingPdf,
  specsPdf,
  activePlanset,
  view,
  page,
  floorPages,
  details,
  extractNote,
  extractSummary,
  isLead,
  reextractPending,
  onReextract,
  onPickBuildingPlanset,
  onPickSpecsPlanset,
  onShowView,
}: PlansPanelProps) {
  const detailCount = details.length;
  return (
    <details className="plans-panel">
      <summary className="plans-panel__summary">
        Plans
        <span className="muted">
          {activePlanset ? plansetLabel(activePlanset) : "loading…"}
          {detailCount > 0
            ? ` · ${detailCount} detail sheet${detailCount === 1 ? "" : "s"}`
            : ""}
        </span>
      </summary>

      <div className="plans-panel__body">
        <div className="planset-picker-row">
          {buildingPdfs.length > 0 && (
            <label className="planset-picker">
              <span>Building planset</span>
              <select
                value={buildingPdf?.id ?? ""}
                onChange={(e) => onPickBuildingPlanset(e.target.value)}
              >
                {buildingPdfs.map((ps) => (
                  <option key={ps.id} value={ps.id}>
                    {plansetLabel(ps)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {specsPdfs.length > 0 && (
            <label className="planset-picker">
              <span>Specs planset</span>
              <select
                value={specsPdf?.id ?? ""}
                onChange={(e) => onPickSpecsPlanset(e.target.value)}
              >
                {specsPdfs.map((ps) => (
                  <option key={ps.id} value={ps.id}>
                    {plansetLabel(ps)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {/* Re-reading a planset rebuilds the job's whole list of windows and
              doors — it deletes the superseded marks and inserts fresh ones — so
              it is foreman+, and the database says so too. Hidden rather than
              disabled: an installer has no reason to know this button exists.
              Either file is enough to re-read — the handler only refuses when
              both are missing — so requiring specs here stranded a lead who
              had uploaded just a building plan with no way to load marks. */}
          {isLead && (buildingPdf || specsPdf) && (
            <button
              type="button"
              className="button-like"
              disabled={reextractPending}
              onClick={onReextract}
            >
              {reextractPending ? "Loading marks…" : "Load marks from plans"}
            </button>
          )}
        </div>

        <p className="pdf-source-line">
          <strong>Viewing:</strong>{" "}
          {activePlanset ? plansetLabel(activePlanset) : "loading…"}
          {(view === "outline" || view === "building") && floorPages.length > 0
            ? ` · ${floorPages.length} numbered floor drawing${
                floorPages.length === 1 ? "" : "s"
              }`
            : ""}
          {view === "details" && detailCount > 0
            ? ` · ${detailCount} detail sheet${detailCount === 1 ? "" : "s"}`
            : ""}
        </p>
        {extractNote && <p className="muted">{extractNote}</p>}
        {extractSummary && (
          <div className="extract-summary">
            <p className="extract-summary-headline">{extractSummary.headline}</p>
            {extractSummary.notes.map((note) => (
              <p className="muted" key={note}>
                {note}
              </p>
            ))}
            {extractSummary.breakdown.length > 1 && (
              <details className="extract-summary-breakdown">
                <summary>
                  Show the mark-by-mark breakdown (
                  {extractSummary.breakdown.length})
                </summary>
                <ul>
                  {extractSummary.breakdown.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {detailCount > 0 && (
          <section className="cad-detail-index">
            <div className="row-between">
              <h2>PDF window &amp; door details</h2>
              {view !== "details" && (
                <button
                  type="button"
                  className="link"
                  onClick={() => onShowView("details")}
                >
                  Open detail sheets
                </button>
              )}
            </div>
            <p className="muted">
              Marks, product codes, glazing, and hardware below are read from the
              uploaded manufacturer PDF. No Smith demo types are mixed in.
            </p>
            <div className="cad-detail-grid">
              {details.map((detail) => (
                <button
                  key={detail.pageNumber}
                  type="button"
                  className={
                    view === "details" && page === detail.pageNumber
                      ? "cad-detail-card active"
                      : "cad-detail-card"
                  }
                  onClick={() => onShowView("details", detail.pageNumber)}
                >
                  <span className="field-label">
                    PDF page {detail.pageNumber}
                  </span>
                  <strong>
                    {detail.marks.length > 0
                      ? detail.marks.map((mark) => `#${mark}`).join(" · ")
                      : "Manufacturer detail"}
                  </strong>
                  {detail.productCodes.length > 0 && (
                    <span>{detail.productCodes.join(" · ")}</span>
                  )}
                  {detail.notes.length > 0 && (
                    <small>{detail.notes.join(" · ")}</small>
                  )}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </details>
  );
}
