import { useEffect, useRef, useState, type CSSProperties } from "react";

export type SelectOption = { key: string; label: string };
export function MultiSelect({ label, options, value, onChange, color, showTags = true, emptyIsAll = false }: {
  label: string; options: SelectOption[]; value: string[] | null; onChange: (value: string[] | null) => void; color: string; showTags?: boolean; emptyIsAll?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !container.current?.contains(event.target)) container.current?.querySelector("details")?.removeAttribute("open"); };
    document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const [query, setQuery] = useState("");
  const selected = value === null ? options.map(option => option.key) : value;
  return <div ref={container} className="report-multiselect" onKeyDown={event => { if (event.key === "Escape") { const details = container.current?.querySelector("details"); details?.removeAttribute("open"); details?.querySelector("summary")?.focus(); } }} style={{ "--facet-color": color } as CSSProperties}>
    <details><summary aria-label={`Select ${label}`}>{label}<small>{value === null || (emptyIsAll && value.length === 0) ? "All" : value.length ? value.length : "None"}</small><span aria-hidden="true">⌄</span></summary>
      <div className="report-multi-popover">
        <label>Find {label.toLowerCase()}<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="report-multi-actions"><button type="button" onClick={() => onChange(null)}>All</button><button type="button" onClick={() => onChange([])}>{emptyIsAll ? "Clear" : "None"}</button><button type="button" onClick={event => { const details = event.currentTarget.closest("details"); details?.removeAttribute("open"); details?.querySelector("summary")?.focus(); }}>Done</button></div>
        {emptyIsAll && <p className="activity-unit-note">Both selected or neither includes all activities.</p>}
        <div className="report-multi-options">{options.filter(option => option.label.toLowerCase().includes(query.toLowerCase())).map(option => <label key={option.key}><input type="checkbox" checked={selected.includes(option.key)} onChange={event => {
          const next = event.target.checked ? [...selected.filter(key => key !== option.key), option.key] : selected.filter(key => key !== option.key);
          onChange(options.length > 0 && options.every(item => next.includes(item.key)) ? null : next);
        }} /><span>{option.label}</span></label>)}</div>
      </div>
    </details>
    {showTags && value !== null && value.length > 0 && <div className="report-selection-tags">{value.map(key => <button type="button" key={key} aria-label={`Remove ${label} ${options.find(option => option.key === key)?.label ?? key}`} onClick={() => { const next = value.filter(item => item !== key); onChange(next.length ? next : null); }}>{options.find(option => option.key === key)?.label ?? key}<span aria-hidden="true">×</span></button>)}</div>}
  </div>;
}
