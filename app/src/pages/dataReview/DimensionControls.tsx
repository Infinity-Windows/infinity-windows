import { useId, useRef, useState } from "react";
import { dimensionLabels, dimensionValue } from "./dataDimensions";
import { reorderDimension, type ReportDimension, type ReportFilters } from "./reportControls";
import { ReportingMultiSelect as MultiSelect } from "./ReportingMultiSelect";
import type { ActivityRow } from "./activityRows";

export function DimensionControls({ rows, order, enabled, filters, onFilters, onOrder, onEnabled, jobOptions }: {
  jobOptions?: { key: string; label: string }[];
  rows: ActivityRow[]; order: ReportDimension[]; enabled: ReportDimension[]; filters: ReportFilters;
  onFilters: (filters: ReportFilters) => void; onOrder: (order: ReportDimension[]) => void; onEnabled: (enabled: ReportDimension[]) => void;
}) {
  const helpId = useId();
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef<{ source: ReportDimension; target: ReportDimension } | null>(null);
  const [dropTarget, setDropTarget] = useState<ReportDimension | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const active = order.filter(dimension => enabled.includes(dimension));
  function commit(source: ReportDimension, target: ReportDimension) {
    const next = reorderDimension(order, source, target); onOrder(next);
    setAnnouncement(`${dimensionLabels[source]} moved to position ${next.indexOf(source) + 1}`);
  }
  return <section className="dimension-controls" aria-label="Comparison and table grouping">
    <div className="dimension-heading"><span>{active.length ? active.map(dimension => dimensionLabels[dimension]).join(" → ") : "None · totals"}</span></div>
    <span role="status" className="activity-sr-only">{announcement}</span>
    <div ref={strip} className="dimension-strip">{order.map((dimension, index) => {
      const options = dimension === "job" && jobOptions ? jobOptions : [...new Map(rows.map(row => { const value = dimensionValue(row, dimension); return [value.key, { key: value.key, label: value.label }]; })).values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
      return <div className="dimension-card" data-dimension={dimension} data-drop={dropTarget === dimension} key={dimension}>
        <div className="dimension-card-controls">
          <button type="button" className="dimension-grip" aria-label={`Reorder ${dimensionLabels[dimension]}`} aria-describedby={helpId} onKeyDown={event => {
            const target = event.key === "ArrowLeft" ? index - 1 : event.key === "ArrowRight" ? index + 1 : event.key === "Home" ? 0 : event.key === "End" ? order.length - 1 : -1;
            if (target >= 0 && target < order.length) { event.preventDefault(); commit(dimension, order[target]); }
          }} onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture?.(event.pointerId); drag.current = { source: dimension, target: dimension }; setDropTarget(dimension); }} onPointerMove={event => {
            if (!drag.current || !strip.current) return;
            const cards = [...strip.current.querySelectorAll<HTMLElement>("[data-dimension]")];
            const nearest = cards.reduce((best, card) => { const rect = card.getBoundingClientRect(); const current = best.getBoundingClientRect(); return Math.hypot(event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2)) < Math.hypot(event.clientX - (current.left + current.width / 2), event.clientY - (current.top + current.height / 2)) ? card : best; }, cards[0]);
            if (nearest) { drag.current.target = nearest.dataset.dimension as ReportDimension; setDropTarget(drag.current.target); }
          }} onPointerUp={event => { const current = drag.current; const bounds = strip.current?.getBoundingClientRect(); drag.current = null; setDropTarget(null); if (current && bounds && event.clientY >= bounds.top - 24 && event.clientY <= bounds.bottom + 24) commit(current.source, current.target); if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onLostPointerCapture={() => { drag.current = null; setDropTarget(null); }} onPointerCancel={() => { drag.current = null; setDropTarget(null); }}>⠿</button>
          <button type="button" className="dimension-group-toggle" role="switch" aria-checked={enabled.includes(dimension)} aria-label={`Group by ${dimensionLabels[dimension]}`} onClick={() => onEnabled(enabled.includes(dimension) ? enabled.filter(value => value !== dimension) : [...enabled, dimension])}><span aria-hidden="true">{enabled.includes(dimension) ? "●" : "○"}</span></button>
          <MultiSelect label={dimensionLabels[dimension]} options={options} value={filters[dimension]} color="#8b949e" onChange={value => onFilters({ ...filters, [dimension]: value })} />
        </div>
      </div>;
    })}</div>
    <span id={helpId} className="activity-sr-only">Drag the grip to reorder. With keyboard focus, use Left or Right, Home or End.</span>
  </section>;
}
