import { useEffect, useRef, useState, type CSSProperties } from "react";
import { TableSelection } from "./TableSelection";

export function ReportingMultiSelect({ label, options, value, onChange, showTags = true }: {
  showTags?: boolean; label: string; options: { key: string; label: string }[]; value: string[] | null;
  onChange: (value: string[] | null) => void; color?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  // All checked and all cleared are equivalent filters, but the bulk checkbox
  // can still visibly toggle between them.
  const [checkAll, setCheckAll] = useState(false);
  useEffect(() => { if (value?.length === 0) onChange(null); }, [value, onChange]);
  const explicit = value ?? [];
  const selected = explicit.length ? explicit : checkAll ? options.map(option => option.key) : [];
  const all = options.length > 0 && options.every(option => selected.includes(option.key));
  const narrowed = explicit.length > 0 && !all;
  const commit = (next: string[]) => {
    const complete = options.length > 0 && options.every(option => next.includes(option.key));
    setCheckAll(complete);
    onChange(!next.length || complete ? null : next);
  };
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) container.current?.querySelector("details")?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  return <div ref={container} className="report-multiselect report-select" style={{ "--facet-color": "#8b949e" } as CSSProperties} onKeyDown={event => {
    if (event.key === "Escape") { const details = container.current?.querySelector("details"); details?.removeAttribute("open"); details?.querySelector("summary")?.focus(); }
  }}>
    <details><summary aria-label={`Select ${label}`}>{label}<small>{narrowed ? explicit.length : "All"}</small><span aria-hidden="true">⌄</span></summary>
      <div className="report-multi-popover report-select-popover">
        <label className="report-select-all"><TableSelection label={`Select/deselect all ${label}`} checked={all} mixed={selected.length > 0 && !all} onChange={() => commit(all ? [] : options.map(option => option.key))} /><span>{label}</span></label>
        <div className="report-multi-options">{options.map(option => <label key={option.key}><input type="checkbox" checked={selected.includes(option.key)} onChange={event => commit(event.target.checked ? [...selected, option.key] : selected.filter(key => key !== option.key))} /><span>{option.label}</span></label>)}</div>
        {!options.length && <p className="report-muted">No available options.</p>}
      </div>
    </details>
    {showTags && narrowed && <div className="report-selection-tags">{explicit.map(key => <button type="button" key={key} aria-label={`Remove ${label} ${options.find(option => option.key === key)?.label ?? key}`} onClick={() => commit(explicit.filter(item => item !== key))}>{options.find(option => option.key === key)?.label ?? key}<span aria-hidden="true">×</span></button>)}</div>}
  </div>;
}
