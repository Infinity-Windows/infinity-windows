import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Share2, X } from "lucide-react";
import { Sheet } from "../ui/Sheet";
import { JobSearchSelect } from "../JobSearchSelect";
import { listProjectsAnyStatus } from "../../lib/api";
import { useLanguage } from "../../lib/i18n";
import { signedMedia } from "../../lib/photos";
import { formatApiError } from "../../lib/errors";
import { canShareMediaFiles, downloadMediaBlob, listMediaExportItems, mediaExportName, mediaExportRangeError, mediaExportZip, prepareMediaExport, shareMediaFiles, MediaExportDataError, isMediaShareCancel, type MediaExportItem, type MediaExportKind, type PreparedMediaExport } from "../../lib/mediaExport";
import { canSharePhotoPart, createPhotoExportSession, downloadPhotoPart, listGroupedPhotoExportItems, sharePhotoPart, type PhotoExportSession, type PreparedPhotoPart, type PhotoPartDownload } from "../../lib/groupedPhotoExport";
import { signInMark, stillSignedInAs, subscribeSignedIn } from "../../lib/signedIn";
import type { ReceiptFilter } from "../../lib/receipts";
import "./mediaExport.css";

const PAGE_SIZE = 50;
const EMPTY_ITEMS: MediaExportItem[] = [];
let thumbnailActive = 0;
const thumbnailQueue: Array<() => void> = [];
function thumbnailSlot(): Promise<() => void> {
  return new Promise(resolve => {
    const enter = () => {
      thumbnailActive++;
      resolve(() => {
        thumbnailActive--;
        thumbnailQueue.shift()?.();
      });
    };
    if (thumbnailActive < 3) enter(); else thumbnailQueue.push(enter);
  });
}
function PhotoThumbnail({ path, label, epoch, isCurrent }: { path: string; label: string; epoch: number; isCurrent: (epoch: number) => boolean }) {
  const holder = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const node = holder.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: "0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (visible) void (async () => {
      const release = await thumbnailSlot();
      try {
        if (!alive || !isCurrent(epoch)) return;
        const signed = await signedMedia(path);
        if (alive && isCurrent(epoch) && signed) setUrl(signed);
      } catch { /* A missing thumbnail does not block the original export. */ }
      finally { release(); }
    })();
    return () => { alive = false; };
  }, [path, epoch, isCurrent, visible]);
  return <span ref={holder} className="media-export-thumb" aria-label={label}>{visible && url ? <img src={url} alt="" loading="lazy" /> : null}</span>;
}

type Group = { key: string; label: string; items: MediaExportItem[]; days: { day: string; items: MediaExportItem[] }[] };

export default function MediaExportDialog({ kind, projectId, fromDate = "", throughDate = "", receiptFilter, onClose }: { kind: MediaExportKind; projectId: string | null; fromDate?: string; throughDate?: string; receiptFilter?: ReceiptFilter; onClose: () => void }) {
  const { lang } = useLanguage();
  const say = (en: string, es: string) => lang === "es" ? es : en;
  const [activeKind, setActiveKind] = useState<MediaExportKind>(kind);
  const [job, setJob] = useState(projectId ?? "");
  const [from, setFrom] = useState(fromDate);
  const [through, setThrough] = useState(throughDate);
  const [custom, setCustom] = useState(Boolean(fromDate && throughDate));
  const [selection, setSelection] = useState<Set<string> | null>(null);
  const [prepared, setPrepared] = useState<PreparedMediaExport | null>(null);
  const [photoPart, setPhotoPart] = useState<PreparedPhotoPart | null>(null);
  const [photoSummary, setPhotoSummary] = useState<ReturnType<PhotoExportSession["summary"]> | null>(null);
  const [partStarted, setPartStarted] = useState(false);
  const [photoNeedsResume, setPhotoNeedsResume] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set());
  const [visible, setVisible] = useState<Record<string, number>>({});
  const prepareController = useRef<AbortController | null>(null);
  const listingControllers = useRef(new Set<AbortController>());
  const photoSession = useRef<PhotoExportSession | null>(null);
  const photoPartRef = useRef<PreparedPhotoPart | null>(null);
  const revokeDownload = useRef<PhotoPartDownload | null>(null);
  const operationEpoch = useRef(0);
  const operationLock = useRef(false);
  const [viewer] = useState(signInMark);
  const active = useRef(true);
  const [invalid, setInvalid] = useState(false);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  const currentViewer = useCallback(() => active.current && viewer.userId !== null && stillSignedInAs(viewer, viewer.userId), [viewer]);
  const releasePhoto = useCallback(() => {
    revokeDownload.current?.revoke(); revokeDownload.current = null;
    photoSession.current?.cancel(); photoSession.current = null;
    photoPartRef.current = null; setPhotoPart(null); setPhotoSummary(null); setPartStarted(false); setPhotoNeedsResume(false);
  }, []);
  const reset = useCallback(() => {
    operationEpoch.current++;
    prepareController.current?.abort();
    for (const ctl of listingControllers.current) ctl.abort();
    releasePhoto(); operationLock.current = false;
    setPreview(null); setPreviewBusy(false); setPrepared(null); setSelection(null);
    setExpanded(new Set()); setCollapsedDays(new Set()); setVisible({}); setError(null); setNotice(null); setProgress(""); setBusy(false);
  }, [releasePhoto]);
  const invalidate = useCallback(() => {
    if (!active.current) return;
    active.current = false; operationEpoch.current++;
    prepareController.current?.abort();
    for (const ctl of listingControllers.current) ctl.abort();
    releasePhoto(); setPrepared(null); setPreview(null); setInvalid(true);
    closeRef.current();
  }, [releasePhoto]);
  useEffect(() => {
    active.current = true;
    const stop = subscribeSignedIn(() => { if (!currentViewer()) invalidate(); });
    if (!currentViewer()) invalidate();
    const cleanup = () => {
      active.current = false; operationEpoch.current++;
      prepareController.current?.abort();
      for (const ctl of listingControllers.current) ctl.abort();
      revokeDownload.current?.revoke(); photoSession.current?.cancel();
      stop();
    };
    return cleanup;
  }, [currentViewer, invalidate]);
  const scopedRead = useCallback(async <T,>(read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> => {
    if (!currentViewer()) throw new DOMException("Export canceled", "AbortError");
    const epoch = operationEpoch.current;
    const ctl = new AbortController(); listingControllers.current.add(ctl);
    const cancel = () => ctl.abort();
    signal.addEventListener("abort", cancel, { once: true });
    let rejectAbort!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new DOMException("Export canceled", "AbortError")); });
    ctl.signal.addEventListener("abort", rejectAbort, { once: true });
    if (signal.aborted) ctl.abort();
    try {
      const result = await Promise.race([Promise.resolve().then(() => {
        if (!currentViewer() || ctl.signal.aborted || epoch !== operationEpoch.current) throw new DOMException("Export canceled", "AbortError");
        return read(ctl.signal);
      }), stopped]);
      if (!currentViewer() || ctl.signal.aborted || epoch !== operationEpoch.current) throw new DOMException("Export canceled", "AbortError");
      return result;
    } finally {
      signal.removeEventListener("abort", cancel); ctl.signal.removeEventListener("abort", rejectAbort); listingControllers.current.delete(ctl);
    }
  }, [currentViewer]);
  const rangeError = custom ? ((!from || !through) ? "Both dates are required" : mediaExportRangeError(from, through)) : null;
  const projects = useQuery({ queryKey: ["media-export-jobs", viewer.userId, viewer.generation], queryFn: ({ signal }) => scopedRead(() => listProjectsAnyStatus(), signal), enabled: !invalid && currentViewer(), retry: false, gcTime: 0 });
  const activeReceiptFilter = activeKind === "receipt" ? receiptFilter : undefined;
  const filter = useMemo(() => ({ kind: activeKind, projectId: job || null, fromDate: custom ? from : "", throughDate: custom ? through : "", receiptFilter: activeReceiptFilter }), [activeKind, job, custom, from, through, activeReceiptFilter]);
  const query = useQuery({ queryKey: ["media-export", viewer.userId, viewer.generation, filter], queryFn: ({ signal }) => scopedRead(ownedSignal => activeKind === "photo" ? listGroupedPhotoExportItems(filter, undefined, ownedSignal) : listMediaExportItems(filter, undefined, ownedSignal), signal), enabled: !invalid && currentViewer() && !rangeError, staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: false, retry: false, gcTime: 0 });
  const items = query.data ?? EMPTY_ITEMS;
  const jobLabels = useMemo(() => new Map((projects.data ?? []).map(p => [p.id, [p.job_code, p.name].filter(Boolean).join(" · ")])), [projects.data]);
  const jobCodeById = useMemo(() => new Map((projects.data ?? []).map(p => [p.id, p.job_code])), [projects.data]);
  const projectLabel = useCallback((id: string | null) => id === null ? (lang === "es" ? "Sin asignar" : "Unassigned") : jobLabels.get(id) || `${lang === "es" ? "Trabajo" : "Job"}-${id}`, [jobLabels, lang]);
  const groups = useMemo<Group[]>(() => {
    const byJob = new Map<string, MediaExportItem[]>();
    for (const item of items) { const key = item.projectId ?? "__unassigned__"; const rows = byJob.get(key) ?? []; rows.push(item); byJob.set(key, rows); }
    return [...byJob].map(([key, rows]) => {
      const byDay = new Map<string, MediaExportItem[]>();
      for (const item of rows) { const day = item.date || "Unknown date"; const dayRows = byDay.get(day) ?? []; dayRows.push(item); byDay.set(day, dayRows); }
      return { key, label: projectLabel(key === "__unassigned__" ? null : key), items: rows, days: [...byDay].sort(([a], [b]) => b.localeCompare(a)).map(([day, dayItems]) => ({ day, items: dayItems })) };
    }).sort((a, b) => a.label.localeCompare(b.label, lang, { sensitivity: "base" }) || a.key.localeCompare(b.key));
  }, [items, projectLabel, lang]);
  const selected = useMemo(() => items.filter(item => selection === null || selection.has(item.id)).map(item => ({ ...item, jobCode: item.jobCode ?? jobCodeById.get(item.projectId ?? "") ?? item.projectId })), [items, selection, jobCodeById]);
  const selectedJobs = useMemo(() => new Set(selected.map(item => item.projectId ?? "__unassigned__")).size, [selected]);
  const ready = currentViewer() && query.isSuccess && !query.isFetching && !rangeError && !busy && !projects.isFetching && (projects.isSuccess || projects.isError) && selected.length > 0;
  const title = activeKind === "photo" ? say("Export photos", "Exportar fotos") : say("Export receipts", "Exportar recibos");
  const jobLabel = jobCodeById.get(job) ?? (job || "all-jobs");
  const filename = mediaExportName(activeKind, jobLabel, filter.fromDate, filter.throughDate);
  function changeSelection(next: Set<string>) {
    operationEpoch.current++; releasePhoto(); setSelection(next); setPrepared(null); setPreview(null); setNotice(null); setError(null);
  }
  function readError(e: unknown) {
    if (e instanceof MediaExportDataError) return e.code === "too_many" ? say("Too many files to load at once. Choose one job or a smaller date range.", "Hay demasiados archivos. Elige un trabajo o un rango de fechas menor.") : say("Photo export is unavailable right now. Please try again later.", "La exportación de fotos no está disponible. Inténtalo más tarde.");
    return lang === "es" ? "No se pudieron cargar los archivos. Reintenta con conexión." : formatApiError(e);
  }
  function failureMessage(reason: string) {
    const pdf = reason.startsWith("pdf_"); const code = pdf ? reason.slice(4) : reason;
    const detail = code === "too_large" ? say("This file exceeds the 50 MB limit.", "Este archivo supera el límite de 50 MB.") : code === "zip_failed" ? say("This ZIP part could not be built.", "No se pudo crear esta parte ZIP.") : code === "aborted" ? say("Preparation was canceled.", "Se canceló la preparación.") : say("This saved file could not be downloaded. Try again.", "No se pudo descargar este archivo. Reintenta.");
    return pdf ? `${say("Original PDF", "PDF original")}: ${detail}` : detail;
  }
  async function showPreview(id: string, path: string) {
    if (!currentViewer()) return;
    if (preview?.id === id) { setPreview(null); return; }
    const epoch = operationEpoch.current; setPreviewBusy(true); setError(null);
    try { const url = await signedMedia(path); if (!url) throw new Error("unavailable"); if (currentViewer() && epoch === operationEpoch.current) setPreview({ id, url }); }
    catch { if (currentViewer() && epoch === operationEpoch.current) setError(say("The photo preview is unavailable. You can still try preparing the export.", "La vista previa no está disponible. Puedes intentar preparar la exportación.")); }
    finally { if (currentViewer() && epoch === operationEpoch.current) setPreviewBusy(false); }
  }
  async function prepare() {
    if (!currentViewer() || !ready || operationLock.current) return;
    operationLock.current = true;
    releasePhoto(); setBusy(true); setError(null); setNotice(null); setPrepared(null);
    const ctl = new AbortController(); prepareController.current = ctl;
    const epoch = operationEpoch.current;
    const isCurrent = () => currentViewer() && epoch === operationEpoch.current && !ctl.signal.aborted;
    try {
      if (activeKind === "photo") {
        const session = createPhotoExportSession([...selected], { signal: ctl.signal, isCurrent, projectLabels: jobLabels, archiveBaseName: filename.replace(/\.zip$/i, ""), onProgress: progress => { if (isCurrent()) setProgress(`${progress.processed} / ${progress.selected}`); } });
        photoSession.current = session;
        const part = await session.nextPart();
        if (!isCurrent()) { session.cancel(); return; }
        photoPartRef.current = part; setPhotoPart(part); setPhotoSummary(session.summary()); setPhotoNeedsResume(false);
        if (!part && session.summary().failed.length) setError(say("No selected photos could be prepared.", "No se pudo preparar ninguna foto seleccionada."));
      } else {
        const result = await prepareMediaExport(selected, (done, total) => { if (isCurrent()) setProgress(`${done} / ${total}`); }, { signal: ctl.signal });
        if (isCurrent()) setPrepared(result);
      }
    } catch (e) { if (isCurrent()) setError(formatApiError(e)); }
    finally { if (prepareController.current === ctl) prepareController.current = null; if (epoch === operationEpoch.current) { operationLock.current = false; if (currentViewer()) setBusy(false); } }
  }
  async function nextPhotoPart() {
    const session = photoSession.current; const previous = photoPart;
    const canAdvance = previous
      ? photoPartRef.current?.token === previous.token && partStarted && !previous.last
      : photoNeedsResume && photoPartRef.current === null && (photoSummary?.remaining ?? 0) > 0;
    if (!session || !canAdvance || !currentViewer() || operationLock.current) return;
    operationLock.current = true; const epoch = operationEpoch.current;
    const ctl = new AbortController(); prepareController.current = ctl;
    setBusy(true); setError(null); setNotice(null); setProgress(""); setPhotoNeedsResume(false);
    try {
      if (previous) {
        revokeDownload.current?.revoke(); revokeDownload.current = null;
        session.releasePart(previous.token); photoPartRef.current = null; setPhotoPart(null); setPartStarted(false);
      }
      const part = await session.nextPart();
      if (!currentViewer() || epoch !== operationEpoch.current) return;
      photoPartRef.current = part; setPhotoPart(part); setPhotoSummary(session.summary());
    } catch (e) {
      if (currentViewer() && epoch === operationEpoch.current) {
        const summary = session.summary();
        setPhotoSummary(summary);
        const archiveFailed = summary.failed.some(f => f.reason === "zip_failed");
        setError(archiveFailed ? say("A ZIP part could not be prepared. The affected photos are listed below. You can prepare the remaining photos.", "No se pudo preparar una parte ZIP. Las fotos afectadas aparecen abajo. Puedes preparar las fotos restantes.") : formatApiError(e));
        setPhotoNeedsResume(summary.remaining > 0 && photoPartRef.current === null && !(e instanceof DOMException && e.name === "AbortError"));
      }
    } finally { if (prepareController.current === ctl) prepareController.current = null; if (epoch === operationEpoch.current) { operationLock.current = false; if (currentViewer()) setBusy(false); } }
  }
  function downloadPhoto() {
    if (!currentViewer() || !photoPart || photoPartRef.current?.token !== photoPart.token || busy || operationLock.current) return;
    operationLock.current = true;
    try {
      if (revokeDownload.current) revokeDownload.current.download();
      else revokeDownload.current = downloadPhotoPart(photoPart);
      setPartStarted(true); setNotice(say("Download started. Check your device before preparing the next part.", "Descarga iniciada. Revisa tu dispositivo antes de preparar la siguiente parte."));
    } catch (e) { if (currentViewer()) setError(formatApiError(e)); }
    finally { operationLock.current = false; }
  }
  async function downloadReceipt() {
    if (!currentViewer() || !prepared?.files.length || busy || operationLock.current) return;
    operationLock.current = true; setBusy(true); setError(null); const epoch = operationEpoch.current;
    try { const blob = await mediaExportZip(prepared.files); if (!currentViewer() || epoch !== operationEpoch.current) return; downloadMediaBlob(blob, filename); setNotice(say("Download started. You can attach the ZIP to an email.", "Descarga iniciada. Puedes adjuntar el ZIP a un correo.")); }
    catch (e) { if (currentViewer() && epoch === operationEpoch.current) setError(formatApiError(e)); }
    finally { if (epoch === operationEpoch.current) { operationLock.current = false; if (currentViewer()) setBusy(false); } }
  }
  async function share(files: File[], isPhoto: boolean, token?: string, part?: PreparedPhotoPart) {
    if (!currentViewer() || busy || operationLock.current || (isPhoto && (!part || photoPartRef.current?.token !== token))) return;
    operationLock.current = true; setError(null); setNotice(null); setBusy(true); const epoch = operationEpoch.current;
    try { const sharing = isPhoto && part ? sharePhotoPart(part) : shareMediaFiles(files); await sharing; if (currentViewer() && epoch === operationEpoch.current && isPhoto) { setPartStarted(true); setNotice(say("Sharing completed. Confirm this part is saved before preparing the next.", "Se completió el envío. Confirma que guardaste esta parte antes de preparar la siguiente.")); } }
    catch (e) { if (!isMediaShareCancel(e) && currentViewer() && epoch === operationEpoch.current) setError(say("Sharing did not finish. Download the ZIP and attach it to your email instead.", "No se pudo compartir. Descarga el ZIP y adjúntalo al correo.")); }
    finally { if (epoch === operationEpoch.current) { operationLock.current = false; if (currentViewer()) setBusy(false); } }
  }
  const thumbnailIsCurrent = useCallback((epoch: number) => currentViewer() && operationEpoch.current === epoch, [currentViewer]);
  const renderedEpoch = operationEpoch.current;
  if (invalid || !currentViewer()) return null;
  return <Sheet open onClose={invalidate} label={title} className="media-export-sheet">
    <header className="media-export-heading"><h2>{title}</h2><button type="button" className="action-btn" onClick={invalidate} aria-label={say("Close", "Cerrar")}><X size={20} aria-hidden /></button></header>
    <p className="muted">{say("Choose a job, dates and files. Downloads keep the original saved images; PDF receipts include the original document.", "Elige un trabajo, fechas y archivos. Las descargas conservan las imágenes guardadas; los recibos PDF incluyen el documento original.")}</p>
    <fieldset disabled={busy} className="media-export-filters">
      <label>{say("Export content", "Contenido a exportar")}<select value={activeKind} onChange={e => { reset(); setActiveKind(e.target.value === "receipt" ? "receipt" : "photo"); }}><option value="photo">{say("Job photos only (exclude receipts)", "Solo fotos del trabajo (sin recibos)")}</option><option value="receipt">{say("Receipts only", "Solo recibos")}</option></select></label>
      <p className="muted">{activeKind === "photo" ? say("Receipt captures are left out. Choose Receipts only to export receipts.", "Los recibos se dejan fuera. Elige Solo recibos para exportar recibos.") : say("Only receipts are included. Each receipt exports its saved image, plus the original PDF when there is one.", "Solo se incluyen recibos. Cada recibo exporta su imagen guardada y el PDF original si lo tiene.")}</p>
      <JobSearchSelect jobs={projects.data ?? []} value={job} onChange={id => { reset(); setJob(id); }} label={say("Export job", "Trabajo a exportar")} loading={projects.isFetching} />
      <button type="button" className="action-btn" aria-pressed={!job} onClick={() => { reset(); setJob(""); }}>{say("All jobs I can access", "Todos los trabajos a los que tengo acceso")}</button>
      <label className="media-export-choice"><input type="checkbox" checked={custom} onChange={e => { reset(); setCustom(e.target.checked); }} />{say("Custom dates", "Fechas personalizadas")}</label>
      {custom ? <div className="media-export-dates"><label>{say("From date", "Desde")}<input type="date" value={from} onChange={e => { reset(); setFrom(e.target.value); }} /></label><label>{say("Through date", "Hasta")}<input type="date" value={through} onChange={e => { reset(); setThrough(e.target.value); }} /></label></div> : <p className="muted">{activeReceiptFilter?.month ? say(`Saved month: ${activeReceiptFilter.month}`, `Mes guardado: ${activeReceiptFilter.month}`) : say("All dates", "Todas las fechas")}</p>}
    </fieldset>
    {activeReceiptFilter && <p className="muted">{say("Your office month, category and billing filters also apply to these files.", "También se aplican los filtros de mes, categoría y facturación de la oficina.")}</p>}
    <p className="muted">{activeKind === "photo" ? say("Dates use when the photo was taken, or when it was saved if unknown. Both dates are included, in your local time.", "Se usa la fecha de captura, o de guardado si se desconoce. Ambas fechas se incluyen, en tu hora local.") : say("Dates use the receipt purchase date, or the saved date if unknown. Both dates are included.", "Se usa la fecha de compra, o de guardado si se desconoce. Ambas fechas se incluyen.")}</p>
    {rangeError && <p role="alert" className="error">{say("Enter valid start and end dates, with the end on or after the start.", "Ingresa fechas válidas; la fecha final debe ser igual o posterior a la inicial.")}</p>}
    {query.isFetching && !rangeError && <p role="status">{say("Finding matching files…", "Buscando archivos…")}</p>}
    {query.error && !rangeError && <div role="alert"><p className="error">{readError(query.error)}</p><button className="action-btn" onClick={() => void query.refetch()}>{say("Try again", "Reintentar")}</button></div>}
    {projects.error && <p className="error">{say("Job names could not load. You can still export the current job or all accessible jobs.", "No se cargaron los nombres. Puedes exportar el trabajo actual o todos los accesibles.")}</p>}
    {query.isSuccess && !query.isFetching && !rangeError && <>
      <div className="media-export-selection"><strong>{activeKind === "photo" ? say(`${selectedJobs} jobs · ${selected.length} / ${items.length} photos selected`, `${selectedJobs} trabajos · ${selected.length} / ${items.length} fotos seleccionadas`) : `${selected.length} / ${items.length} ${say("selected", "seleccionados")}`}</strong><button type="button" className="action-btn" disabled={busy} onClick={() => changeSelection(selection?.size === 0 ? new Set(items.map(i => i.id)) : new Set())}>{selection?.size === 0 ? say("Select all", "Seleccionar todos") : say("Clear selection", "Quitar selección")}</button></div>
      {!items.length && <p>{say("No saved files match this job and date range.", "No hay archivos guardados para este trabajo y fechas.")}</p>}
      {activeKind === "photo" ? <div className="media-export-groups">{groups.map(group => {
        const checkedCount = group.items.filter(item => selection === null || selection.has(item.id)).length;
        const shown = visible[group.key] ?? PAGE_SIZE;
        let seen = 0;
        return <section className="media-export-group" key={group.key}>
          <div className="media-export-group-heading"><label><input type="checkbox" checked={checkedCount === group.items.length} disabled={busy} ref={node => { if (node) node.indeterminate = checkedCount > 0 && checkedCount < group.items.length; }} onChange={() => { const next = new Set(selection ?? items.map(i => i.id)); for (const item of group.items) if (checkedCount === group.items.length) next.delete(item.id); else next.add(item.id); changeSelection(next); }} /><span>{group.label} <small>{checkedCount} / {group.items.length} {say("photos", "fotos")}</small></span></label><button type="button" className="action-btn" aria-expanded={expanded.has(group.key)} onClick={() => setExpanded(prev => { const next = new Set(prev); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; })}>{expanded.has(group.key) ? say("Collapse", "Contraer") : say("Expand", "Expandir")}</button></div>
          {expanded.has(group.key) && <>{group.days.map(day => {
            const dayKey = `${group.key}::${day.day}`;
            const dayRows = collapsedDays.has(dayKey) ? [] : day.items.slice(0, Math.max(0, shown - seen)); seen += dayRows.length;
            return dayRows.length || collapsedDays.has(dayKey) ? <div key={day.day}><h3 className="media-export-day"><button type="button" className="action-btn" aria-expanded={!collapsedDays.has(dayKey)} onClick={() => setCollapsedDays(prev => { const next = new Set(prev); if (next.has(dayKey)) next.delete(dayKey); else next.add(dayKey); return next; })}>{day.day} · {day.items.length} {say("photos", "fotos")}</button></h3>{dayRows.length > 0 && <ul className="media-export-items">{dayRows.map(item => <li key={item.id}><label><input type="checkbox" checked={selection === null || selection.has(item.id)} disabled={busy} onChange={() => { const next = new Set(selection ?? items.map(i => i.id)); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); changeSelection(next); }} /><PhotoThumbnail path={item.storagePath} label={item.label} epoch={renderedEpoch} isCurrent={thumbnailIsCurrent} /><span><strong>{item.label}</strong><small>{item.id.slice(0, 8)}</small></span></label><button type="button" className="action-btn" disabled={busy || previewBusy} onClick={() => void showPreview(item.id, item.storagePath)}>{preview?.id === item.id ? say("Hide preview", "Ocultar vista previa") : say("Preview", "Vista previa")}</button>{preview?.id === item.id && <img className="media-export-preview" src={preview.url} alt={item.label} onError={() => { setPreview(null); setError(say("The photo preview is unavailable.", "La vista previa no está disponible.")); }} />}</li>)}</ul>}</div> : null;
          })}{shown < group.items.length && <button type="button" className="action-btn" onClick={() => setVisible(prev => ({ ...prev, [group.key]: shown + PAGE_SIZE }))}>{say("Show more", "Mostrar más")}</button>}</>}
        </section>;
      })}</div> : <ul className="media-export-items">{items.map(item => <li key={item.id}><label><input type="checkbox" checked={selection === null || selection.has(item.id)} disabled={busy} onChange={() => { const next = new Set(selection ?? items.map(i => i.id)); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); changeSelection(next); }} /><span><strong>{item.label}</strong><small>{projectLabel(item.projectId)} · {item.date} · {item.id.slice(0, 8)}{item.documentPath ? say(" · PDF + image", " · PDF + imagen") : ""}</small></span></label><button type="button" className="action-btn" disabled={busy || previewBusy} onClick={() => void showPreview(item.id, item.storagePath)}>{preview?.id === item.id ? say("Hide preview", "Ocultar vista previa") : say("Preview", "Vista previa")}</button>{preview?.id === item.id && <img className="media-export-preview" src={preview.url} alt={item.label} />}</li>)}</ul>}
    </>}
    {error && <p role="alert" className="error">{error}</p>}
    {busy && prepareController.current && <button type="button" className="action-btn" onClick={() => { operationEpoch.current++; prepareController.current?.abort(); releasePhoto(); operationLock.current = false; setError(say("Preparation was canceled.", "Se canceló la preparación.")); setBusy(false); }}>{say("Cancel preparation", "Cancelar preparación")}</button>}
    {busy && <p role="status">{say("Preparing files…", "Preparando archivos…")} {progress}</p>}
    {photoSummary && activeKind === "photo" && <div role="status"><p><strong>{say(`${photoSummary.packaged} of ${photoSummary.selected} selected photos prepared across ${photoSummary.partsPrepared} part${photoSummary.partsPrepared === 1 ? "" : "s"}.`, `${photoSummary.packaged} de ${photoSummary.selected} fotos preparadas en ${photoSummary.partsPrepared} parte${photoSummary.partsPrepared === 1 ? "" : "s"}.`)}</strong></p>{photoSummary.remaining > 0 && <p>{photoSummary.remaining} {say("photos remain queued.", "fotos aún pendientes.")}</p>}{photoSummary.failed.length > 0 && <div className="error"><p>{say("These files could not be prepared:", "No se pudieron preparar estos archivos:")}</p><ul>{photoSummary.failed.map(f => <li key={f.id}>{f.label}: {failureMessage(f.reason)}</li>)}</ul></div>}</div>}
    {prepared && <div role="status"><p><strong>{prepared.files.length} {say("files ready", "archivos listos")}</strong></p>{prepared.failed.length > 0 && <div className="error"><p>{say("Some files could not be exported. Only the available files below will be downloaded or shared. Retry preparation to try the missing files again.", "No se pudieron exportar algunos archivos. Solo se descargarán o compartirán los disponibles. Prepara de nuevo para reintentar.")}</p><ul>{prepared.failed.map((f, i) => <li key={`${f.id}-${i}`}>{f.label}: {failureMessage(f.reason)}</li>)}</ul></div>}</div>}
    <div className="media-export-actions">
      <button type="button" className="action-btn primary" onClick={() => void prepare()} disabled={!ready}>{activeKind === "photo" ? photoPart ? say("Prepare again", "Preparar de nuevo") : job ? say("Export selected job", "Exportar trabajo seleccionado") : say("Export all selected projects", "Exportar todos los proyectos seleccionados") : prepared ? say("Prepare again", "Preparar de nuevo") : say("Prepare export", "Preparar exportación")}</button>
      {activeKind === "photo" && photoPart && <><button type="button" className="action-btn" disabled={busy} onClick={downloadPhoto}><Download size={18} aria-hidden />{say("Download ZIP", "Descargar ZIP")}</button><button type="button" className="action-btn" disabled={busy || !canSharePhotoPart(photoPart)} onClick={() => void share([photoPart.zip], true, photoPart.token, photoPart)}><Share2 size={18} aria-hidden />{say("Share ZIP", "Compartir ZIP")}</button>{!photoPart.last && <button type="button" className="action-btn" disabled={busy || !partStarted} onClick={() => void nextPhotoPart()}>{say("I saved this part — prepare next", "Guardé esta parte — preparar siguiente")}</button>}</>}
      {activeKind === "photo" && photoNeedsResume && !photoPart && (photoSummary?.remaining ?? 0) > 0 && <button type="button" className="action-btn" disabled={busy} onClick={() => void nextPhotoPart()}>{say("Prepare next part", "Preparar siguiente parte")}</button>}
      {activeKind === "receipt" && prepared?.files.length ? <><button type="button" className="action-btn" disabled={busy} onClick={() => void downloadReceipt()}><Download size={18} aria-hidden />{prepared.failed.length ? say("Download available files", "Descargar disponibles") : say("Download ZIP", "Descargar ZIP")}</button><button type="button" className="action-btn" disabled={busy || !canShareMediaFiles(prepared.files)} onClick={() => void share(prepared.files, false)}><Share2 size={18} aria-hidden />{say("Share / Email", "Compartir / Correo")}</button></> : null}
    </div>
    {activeKind === "receipt" && prepared?.files.length ? <><p className="muted">{say("Choose Mail or another app in your device’s share sheet. If sharing is unavailable, download the ZIP or individual files and attach them yourself.", "Elige Correo u otra app en el menú de compartir. Si no está disponible, descarga el ZIP o los archivos y adjúntalos.")}</p><ul className="media-export-files">{prepared.files.map(file => <li key={file.name}><span>{file.name}</span><button type="button" className="action-btn" disabled={busy} aria-label={`${say("Download", "Descargar")} ${file.name}`} onClick={() => { if (currentViewer()) downloadMediaBlob(file, file.name); }}><Download size={16} aria-hidden /></button></li>)}</ul></> : null}
    {notice && <p role="status">{notice}</p>}
    <p className="muted">{activeKind === "photo" ? say("Large photo exports are packed into numbered ZIP parts. Download or share each part before preparing the next.", "Las exportaciones grandes se dividen en partes ZIP numeradas. Descarga o comparte cada parte antes de preparar la siguiente.") : say("Exports hold up to 50 MB at a time. Choose fewer files or a smaller date range for larger jobs.", "Las exportaciones incluyen hasta 50 MB. Elige menos archivos o fechas más cortas para trabajos grandes.")}</p>
    <p className="muted">{say("Only saved files you can view in Forge are included. Photos waiting to upload stay on your device.", "Solo se incluyen los archivos guardados que puedes ver en Forge. Las fotos pendientes quedan en tu dispositivo.")}</p>
  </Sheet>;
}
