import { useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { useT } from "../lib/i18n";
import "./jobSearchSelect.css";

export interface JobOption { id: string; job_code: string; name?: string | null }

/** Searches only the caller's allowed jobs; typing never changes the saved job. */
export function JobSearchSelect({ jobs, value, onChange, label, loading = false }: {
  jobs: JobOption[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
  loading?: boolean;
}) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const options = useMemo(() => [...jobs].sort((a, b) =>
    a.job_code.localeCompare(b.job_code, undefined, { sensitivity: "base", numeric: true }) ||
    (a.name ?? "").localeCompare(b.name ?? "", undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id),
  ), [jobs]);
  const visible = options.filter(p => `${p.job_code} ${p.name ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = jobs.find(p => p.id === value);
  const jobLabel = (p: JobOption) => p.name ? `${p.job_code} · ${p.name}` : p.job_code;
  function close() { setOpen(false); setQuery(""); setActive(-1); }
  function pick(p: JobOption) { onChange(p.id); close(); input.current?.blur(); }
  function move(next: number) {
    setActive(next);
    document.getElementById(`${id}-option-${next}`)?.scrollIntoView({ block: "nearest" });
  }
  return <div className="job-search-select" onBlur={e => {
    if (!e.currentTarget.contains(e.relatedTarget)) close();
  }}>
    <label className="field-label" htmlFor={id}>{label ?? t("timereport.searchJobs")}</label>
    <div className="job-search-control">
      <Search size={18} aria-hidden="true" />
      <input ref={input} id={id} role="combobox" type="text" autoComplete="off"
        placeholder={t("timereport.searchJobs")} value={open ? query : selected ? jobLabel(selected) : ""}
        aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list"
        aria-activedescendant={open && visible[active] ? `${id}-option-${active}` : undefined}
        onFocus={() => { setOpen(true); setQuery(""); setActive(-1); }}
        onClick={() => { if (!open) { setOpen(true); setQuery(""); setActive(-1); } }}
        onChange={e => { setQuery(e.target.value); setOpen(true); setActive(-1); }}
        onKeyDown={e => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault(); setOpen(true);
            if (visible.length) move(e.key === "ArrowDown" ? Math.min(active + 1, visible.length - 1) : active < 0 ? visible.length - 1 : Math.max(0, active - 1));
          } else if (e.key === "Enter" && open) {
            e.preventDefault(); const choice = visible[active] ?? (visible.length === 1 ? visible[0] : undefined); if (choice) pick(choice);
          } else if (e.key === "Escape") { e.preventDefault(); close(); }
        }} />
      <button type="button" aria-label={t("supplies.pickTheJob")} aria-expanded={open} aria-controls={`${id}-list`}
        onMouseDown={e => e.preventDefault()} onClick={() => {
          if (open) { close(); input.current?.blur(); }
          else { setOpen(true); setQuery(""); setActive(-1); input.current?.focus(); }
        }}><ChevronDown size={20} aria-hidden="true" /></button>
    </div>
    {open && <div className="job-search-dropdown">
      <ul id={`${id}-list`} role="listbox" aria-label={label ?? t("timereport.searchJobs")} aria-busy={loading}>
        {visible.map((p, i) => <li role="presentation" key={p.id}>
          <button type="button" role="option" id={`${id}-option-${i}`} tabIndex={-1}
            aria-selected={value === p.id} className={active === i ? "is-active" : undefined}
            onMouseDown={e => e.preventDefault()} onClick={() => pick(p)}>
            <strong>{p.job_code}</strong>{p.name && <span>{p.name}</span>}
          </button>
        </li>)}
      </ul>
      {!visible.length && <p role="status" className="muted">{loading ? t("billtoList.loading") : t("timereport.noMatchingJobs")}</p>}
    </div>}
  </div>;
}
