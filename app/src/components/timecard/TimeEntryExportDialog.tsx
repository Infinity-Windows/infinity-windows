import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sheet } from "../ui/Sheet";
import { listTeamShifts } from "../../lib/timeclock";
import { customTimeRange } from "../../lib/timeReportFilters";
import { buildTimeEntriesCsv, completedExportShifts, durationText, timeEntriesHtml, timeEntrySeconds } from "../../lib/timeEntryExport";
import { formatApiError } from "../../lib/errors";
import { useT } from "../../lib/i18n";

type Person = { id: string; display_name: string };
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const safeName = (name: string) => name.replace(/[^\p{L}\p{N}_.-]+/gu, "-").slice(0, 80) || "employee";

export function TimeEntryExportDialog({ fromDate, throughDate, people, person, onClose }: {
  fromDate: string; throughDate: string; people?: Person[]; person?: Person; onClose: () => void;
}) {
  const t = useT();
  const [from, setFrom] = useState(fromDate);
  const [through, setThrough] = useState(throughDate);
  const [selection, setSelection] = useState<string[] | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const range = useMemo(() => customTimeRange(from, through), [from, through]);
  const start = !range.error ? range.startIso : null;
  const end = !range.error ? range.endIso : null;
  const query = useQuery({
    queryKey: ["timeEntryExport", person?.id ?? "team", start, end],
    queryFn: () => listTeamShifts(start, end, person?.id), enabled: !range.error,
    staleTime: 0, refetchOnMount: "always",
  });
  const roster = useMemo(() => {
    const map = new Map((people ?? []).map(p => [p.id, p]));
    for (const row of query.data ?? []) if (!map.has(row.profile_id)) map.set(row.profile_id, { id: row.profile_id, display_name: row.profiles?.display_name ?? row.profile_id });
    return [...map.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
  }, [people, query.data]);
  const selected = (query.data ?? []).filter(s => selection === null || selection.includes(s.profile_id));
  const completed = completedExportShifts(selected);
  const unresolved = selected.filter(s => s.status !== "voided" && !s.clock_out_at).length;
  const total = completed.reduce((n, s) => n + timeEntrySeconds(s), 0);
  const blocked = Boolean(range.error || query.error || query.isFetching || query.isPending || !completed.length || busy);
  const fileStem = `TimeEntries(${from}-${through})`;
  function toggle(id: string) {
    const current = selection ?? roster.map(p => p.id);
    setSelection(current.includes(id) ? current.filter(p => p !== id) : [...current, id]);
  }
  async function separateFiles() {
    setBusy(true); setActionError(null);
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      for (const id of new Set(completed.map(s => s.profile_id))) {
        const rows = completed.filter(s => s.profile_id === id);
        const name = roster.find(p => p.id === id)?.display_name ?? person?.display_name ?? id;
        zip.file(`${safeName(name)}-${id}-${fileStem}.csv`, buildTimeEntriesCsv(rows, timeZone, name));
      }
      download(await zip.generateAsync({ type: "blob" }), `Forge-${fileStem}.zip`);
    } catch (error) { setActionError(error); } finally { setBusy(false); }
  }
  function print() {
    const w = window.open("", "_blank");
    if (!w) { setActionError(new Error(t("timeexport.popupBlocked"))); return; }
    w.document.write(timeEntriesHtml(completed, `${from} – ${through}`, timeZone, person?.display_name));
    w.document.close();
  }
  return <Sheet open onClose={onClose} label={t("timeexport.title")} className="time-entry-export">
    <div className="row-between"><h2>{t("timeexport.title")}</h2><button onClick={onClose}>{t("timecard.close")}</button></div>
    {person && <p><strong>{person.display_name}</strong></p>}
    <div className="job-hours-custom-range"><div className="job-hours-dates">
      <label>{t("timereport.fromDate")}<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>{t("timereport.throughDate")}<input type="date" value={through} onChange={e => setThrough(e.target.value)} /></label>
    </div></div>
    <p className="muted">{t("timeexport.dateHelp", { zone: timeZone })}</p>
    {range.error && <p role="alert">{t(`timereport.rangeError.${range.error}`)}</p>}
    {!person && <details className="time-export-people"><summary>{selection === null ? t("timeexport.allPeople") : t("timeexport.selectedPeople", { n: selection.length })}</summary>
      <label className="job-filter-search">{t("timeexport.searchPeople")}<input type="search" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className="row-gap"><button onClick={() => setSelection(null)}>{t("timeexport.allPeople")}</button><button onClick={() => setSelection([])}>{t("timereport.clearJobs")}</button></div>
      <div className="job-filter-options">{roster.filter(p => p.display_name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map(p => <label className="job-filter-option" key={p.id}>
        <input type="checkbox" checked={selection === null || selection.includes(p.id)} onChange={() => toggle(p.id)} /><span>{p.display_name}</span>
      </label>)}</div>
    </details>}
    {query.isFetching && <p role="status">{t("timeexport.loading")}</p>}
    {Boolean(query.error || actionError) && <p role="alert">{formatApiError(query.error ?? actionError, t("timereport.error"))}</p>}
    {!range.error && query.isSuccess && !query.isFetching && !query.error && <div className="detail-card">
      <strong>{durationText(total)}</strong><p>{t("timeexport.counts", { people: new Set(completed.map(s => s.profile_id)).size, entries: completed.length })}</p>
      {unresolved > 0 && <p role="status">{t("timeexport.unfinished", { n: unresolved })}</p>}
      {completed.some(s => s.status !== "approved") && <p>{t("timeexport.unapproved")}</p>}
    </div>}
    <p className="muted">{t("timeexport.contents")}</p>
    <div className="time-export-actions">
      <button className="primary" disabled={blocked} onClick={() => download(new Blob([buildTimeEntriesCsv(completed, timeZone, person?.display_name)], { type: "text/csv;charset=utf-8" }), `${safeName(person?.display_name ?? "Forge")}-${fileStem}.csv`)}>{t("timeexport.csv")}</button>
      {!person && <button disabled={blocked} onClick={() => void separateFiles()}>{t("timeexport.zip")}</button>}
      <button disabled={blocked} onClick={print}>{t("timeexport.pdf")}</button>
      <button disabled={query.isFetching || Boolean(range.error)} onClick={() => { setActionError(null); void query.refetch(); }}>{t("timereport.refresh")}</button>
    </div>
  </Sheet>;
}
