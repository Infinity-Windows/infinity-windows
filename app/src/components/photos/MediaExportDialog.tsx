import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Share2, X } from "lucide-react";
import { Sheet } from "../ui/Sheet";
import { JobSearchSelect } from "../JobSearchSelect";
import { listProjectsAnyStatus } from "../../lib/api";
import { useLanguage } from "../../lib/i18n";
import { signedMedia } from "../../lib/photos";
import { formatApiError } from "../../lib/errors";
import { canShareMediaFiles, downloadMediaBlob, listMediaExportItems, mediaExportName, mediaExportRangeError, mediaExportZip, prepareMediaExport, shareMediaFiles, MediaExportDataError, isMediaShareCancel, type MediaExportKind, type PreparedMediaExport } from "../../lib/mediaExport";
import { signInMark, stillSignedInAs, subscribeSignedIn } from "../../lib/signedIn";
import type { ReceiptFilter } from "../../lib/receipts";
import "./mediaExport.css";

export default function MediaExportDialog({ kind, projectId, fromDate = "", throughDate = "", receiptFilter, onClose }: { kind: MediaExportKind; projectId: string | null; fromDate?: string; throughDate?: string; receiptFilter?: ReceiptFilter; onClose: () => void }) {
  const { lang } = useLanguage();
  const say = (en: string, es: string) => lang === "es" ? es : en;
  const [job, setJob] = useState(projectId ?? "");
  const [from, setFrom] = useState(fromDate);
  const [through, setThrough] = useState(throughDate);
  const [custom, setCustom] = useState(Boolean(fromDate && throughDate));
  const [selection, setSelection] = useState<Set<string> | null>(null);
  const [prepared, setPrepared] = useState<PreparedMediaExport | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const prepareController = useRef<AbortController | null>(null);
  const listingControllers = useRef(new Set<AbortController>());
  const [viewer] = useState(signInMark);
  const active = useRef(true);
  const [invalid, setInvalid] = useState(false);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  const currentViewer = useCallback(() => active.current && viewer.userId !== null && stillSignedInAs(viewer, viewer.userId), [viewer]);
  const invalidate = useCallback(() => {
    if (!active.current) return;
    active.current = false;
    prepareController.current?.abort();
    for (const ctl of listingControllers.current) ctl.abort();
    setPrepared(null); setPreview(null); setInvalid(true);
    closeRef.current();
  }, []);
  useEffect(() => {
    active.current = true;
    const stop = subscribeSignedIn(() => { if (!currentViewer()) invalidate(); });
    if (!currentViewer()) invalidate();
    return () => {
      active.current = false;
      prepareController.current?.abort();
      for (const ctl of listingControllers.current) ctl.abort();
      stop();
    };
  }, [currentViewer, invalidate]);
  function close() { invalidate(); }
  const scopedRead = useCallback(async <T,>(read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> => {
    if (!currentViewer()) throw new DOMException("Export canceled", "AbortError");
    const ctl = new AbortController(); listingControllers.current.add(ctl);
    const cancel = () => ctl.abort();
    signal.addEventListener("abort", cancel, { once: true });
    let rejectAbort!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new DOMException("Export canceled", "AbortError")); });
    ctl.signal.addEventListener("abort", rejectAbort, { once: true });
    if (signal.aborted) ctl.abort();
    try {
      const result = await Promise.race([Promise.resolve().then(() => {
        if (!currentViewer() || ctl.signal.aborted) throw new DOMException("Export canceled", "AbortError");
        return read(ctl.signal);
      }), stopped]);
      if (!currentViewer() || ctl.signal.aborted) throw new DOMException("Export canceled", "AbortError");
      return result;
    } finally {
      signal.removeEventListener("abort", cancel);
      ctl.signal.removeEventListener("abort", rejectAbort);
      listingControllers.current.delete(ctl);
    }
  }, [currentViewer]);
  const rangeError = custom ? ((!from || !through) ? "Both dates are required" : mediaExportRangeError(from, through)) : null;
  const projects = useQuery({ queryKey: ["media-export-jobs", viewer.userId, viewer.generation], queryFn: ({ signal }) => scopedRead(() => listProjectsAnyStatus(), signal), enabled: !invalid && currentViewer(), retry: false, gcTime: 0 });
  const filter = useMemo(() => ({ kind, projectId: job || null, fromDate: custom ? from : "", throughDate: custom ? through : "", receiptFilter }), [kind, job, custom, from, through, receiptFilter]);
  const query = useQuery({ queryKey: ["media-export", viewer.userId, viewer.generation, filter], queryFn: ({ signal }) => scopedRead(ownedSignal => listMediaExportItems(filter, undefined, ownedSignal), signal), enabled: !invalid && currentViewer() && !rangeError, staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: false, retry: false, gcTime: 0 });
  const items = query.data ?? [];
  const jobCodeById = useMemo(() => new Map((projects.data ?? []).map(p => [p.id, p.job_code])), [projects.data]);
  const selected = useMemo(() => (query.data ?? []).filter(item => selection === null || selection.has(item.id)).map(item => ({ ...item, jobCode: item.jobCode ?? jobCodeById.get(item.projectId ?? "") ?? item.projectId })), [query.data, selection, jobCodeById]);
  const ready = currentViewer() && query.isSuccess && !query.isFetching && !rangeError && !busy && !projects.isFetching && (projects.isSuccess || projects.isError) && selected.length > 0;
  const title = kind === "photo" ? say("Export photos", "Exportar fotos") : say("Export receipts", "Exportar recibos");
  const jobLabel = jobCodeById.get(job) ?? (job || "all-jobs");
  const filename = mediaExportName(kind, jobLabel, filter.fromDate, filter.throughDate);
  function reset() { setPreview(null); setPrepared(null); setSelection(null); setError(null); setNotice(null); setProgress(""); }
  function readError(e: unknown) {
    if (e instanceof MediaExportDataError) return e.code === "too_many" ? say("Too many files to load at once. Choose one job or a smaller date range.", "Hay demasiados archivos. Elige un trabajo o un rango de fechas menor.") : say("Photo export is unavailable right now. Please try again later.", "La exportación de fotos no está disponible. Inténtalo más tarde.");
    return lang === "es" ? "No se pudieron cargar los archivos. Reintenta con conexión." : formatApiError(e);
  }
  function failureMessage(reason: string) {
    const pdf = reason.startsWith("pdf_");
    const code = pdf ? reason.slice(4) : reason;
    const detail = code === "too_large" ? say("Export size limit reached. Choose fewer files.", "Límite de tamaño alcanzado. Elige menos archivos.") : code === "aborted" ? say("Preparation was canceled.", "Se canceló la preparación.") : say("This saved file could not be downloaded. Try again.", "No se pudo descargar este archivo. Reintenta.");
    return pdf ? `${say("Original PDF", "PDF original")}: ${detail}` : detail;
  }
  async function showPreview(id: string, path: string) {
    if (!currentViewer()) return;
    if (preview?.id === id) { setPreview(null); return; }
    setPreviewBusy(true); setError(null);
    try { const url = await signedMedia(path); if (!url) throw new Error("unavailable"); if (currentViewer()) setPreview({ id, url }); }
    catch { if (currentViewer()) setError(say("The photo preview is unavailable. You can still try preparing the export.", "La vista previa no está disponible. Puedes intentar preparar la exportación.")); }
    finally { if (currentViewer()) setPreviewBusy(false); }
  }
  async function prepare() {
    if (!currentViewer() || !ready) return;
    setBusy(true); setError(null); setNotice(null); setPrepared(null);
    const ctl = new AbortController(); prepareController.current = ctl;
    try {
      const result = await prepareMediaExport(selected, (done, total) => { if (currentViewer()) setProgress(`${done} / ${total}`); }, { signal: ctl.signal });
      if (currentViewer()) setPrepared(result);
    } catch (e) { if (currentViewer()) setError(formatApiError(e)); }
    finally { prepareController.current = null; if (currentViewer()) setBusy(false); }
  }
  async function download() {
    if (!currentViewer() || !prepared?.files.length || busy) return;
    setBusy(true); setError(null);
    try { const blob = await mediaExportZip(prepared.files); if (!currentViewer()) return; downloadMediaBlob(blob, filename); setNotice(say("Download started. You can attach the ZIP to an email.", "Descarga iniciada. Puedes adjuntar el ZIP a un correo.")); }
    catch (e) { if (currentViewer()) setError(formatApiError(e)); }
    finally { if (currentViewer()) setBusy(false); }
  }
  async function share() {
    if (!currentViewer() || !prepared?.files.length || busy) return;
    setError(null); setNotice(null); setBusy(true);
    try { await shareMediaFiles(prepared.files); }
    catch (e) {
      if (isMediaShareCancel(e)) return;
      if (currentViewer()) setError(say("Sharing did not finish. Download the files and attach them to your email instead.", "No se pudo compartir. Descarga los archivos y adjúntalos al correo."));
    } finally { if (currentViewer()) setBusy(false); }
  }
  if (invalid || !currentViewer()) return null;
  return <Sheet open onClose={close} label={title} className="media-export-sheet">
    <header className="media-export-heading"><h2>{title}</h2><button type="button" className="action-btn" onClick={close} aria-label={say("Close", "Cerrar")}><X size={20} aria-hidden /></button></header>
    <p className="muted">{say("Choose a job, dates and files. Downloads keep the original saved images; PDF receipts include the original document.", "Elige un trabajo, fechas y archivos. Las descargas conservan las imágenes guardadas; los recibos PDF incluyen el documento original.")}</p>
    <fieldset disabled={busy} className="media-export-filters">
      <JobSearchSelect jobs={projects.data ?? []} value={job} onChange={id => { setJob(id); reset(); }} label={say("Export job", "Trabajo a exportar")} loading={projects.isFetching} />
      <button type="button" className="action-btn" aria-pressed={!job} onClick={() => { setJob(""); reset(); }}>{say("All jobs I can access", "Todos los trabajos a los que tengo acceso")}</button>
      <label className="media-export-choice"><input type="checkbox" checked={custom} onChange={e => { setCustom(e.target.checked); reset(); }} />{say("Custom dates", "Fechas personalizadas")}</label>
      {custom ? <div className="media-export-dates"><label>{say("From date", "Desde")}<input type="date" value={from} onChange={e => { setFrom(e.target.value); reset(); }} /></label><label>{say("Through date", "Hasta")}<input type="date" value={through} onChange={e => { setThrough(e.target.value); reset(); }} /></label></div> : <p className="muted">{receiptFilter?.month ? say(`Saved month: ${receiptFilter.month}`, `Mes guardado: ${receiptFilter.month}`) : say("All dates", "Todas las fechas")}</p>}
    </fieldset>
    {receiptFilter && <p className="muted">{say("Your office month, category and billing filters also apply to these files.", "También se aplican los filtros de mes, categoría y facturación de la oficina.")}</p>}
    <p className="muted">{kind === "photo" ? say("Dates use when the photo was taken, or when it was saved if unknown. Both dates are included, in your local time.", "Se usa la fecha de captura, o de guardado si se desconoce. Ambas fechas se incluyen, en tu hora local.") : say("Dates use the receipt purchase date, or the saved date if unknown. Both dates are included.", "Se usa la fecha de compra, o de guardado si se desconoce. Ambas fechas se incluyen.")}</p>
    {rangeError && <p role="alert" className="error">{say("Enter valid start and end dates, with the end on or after the start.", "Ingresa fechas válidas; la fecha final debe ser igual o posterior a la inicial.")}</p>}
    {query.isFetching && !rangeError && <p role="status">{say("Finding matching files…", "Buscando archivos…")}</p>}
    {query.error && !rangeError && <div role="alert"><p className="error">{readError(query.error)}</p><button className="action-btn" onClick={() => void query.refetch()}>{say("Try again", "Reintentar")}</button></div>}
    {projects.error && <p className="error">{say("Job names could not load. You can still export the current job or all accessible jobs.", "No se cargaron los nombres. Puedes exportar el trabajo actual o todos los accesibles.")}</p>}
    {query.isSuccess && !query.isFetching && !rangeError && <>
      <div className="media-export-selection"><strong>{selected.length} / {items.length} {say("selected", "seleccionados")}</strong><button type="button" className="action-btn" disabled={busy} onClick={() => { setSelection(selection?.size === 0 ? null : new Set()); setPrepared(null); }}>{selection?.size === 0 ? say("Select all", "Seleccionar todos") : say("Clear selection", "Quitar selección")}</button></div>
      {!items.length && <p>{say("No saved files match this job and date range.", "No hay archivos guardados para este trabajo y fechas.")}</p>}
      <ul className="media-export-items">{items.map(item => <li key={item.id}><label><input type="checkbox" checked={selection === null || selection.has(item.id)} disabled={busy} onChange={() => { const next = new Set(selection ?? items.map(i => i.id)); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); setSelection(next); setPrepared(null); setNotice(null); }} /><span><strong>{item.label}</strong><small>{jobCodeById.get(item.projectId ?? "") ?? say("No job", "Sin trabajo")} · {item.date} · {item.id.slice(0, 8)}{item.documentPath ? say(" · PDF + image", " · PDF + imagen") : ""}</small></span></label><button type="button" className="action-btn" disabled={busy || previewBusy} onClick={() => void showPreview(item.id, item.storagePath)}>{preview?.id === item.id ? say("Hide preview", "Ocultar vista previa") : say("Preview", "Vista previa")}</button>{preview?.id === item.id && <img className="media-export-preview" src={preview.url} alt={item.label} onError={() => { setPreview(null); setError(say("The photo preview is unavailable.", "La vista previa no está disponible.")); }} />}</li>)}</ul>
    </>}
    {error && <p role="alert" className="error">{error}</p>}
    {busy && prepareController.current && <button type="button" className="action-btn" onClick={() => prepareController.current?.abort()}>{say("Cancel preparation", "Cancelar preparación")}</button>}
    {busy && <p role="status">{say("Preparing files…", "Preparando archivos…")} {progress}</p>}
    {prepared && <div role="status"><p><strong>{prepared.files.length} {say("files ready", "archivos listos")}</strong></p>{prepared.failed.length > 0 && <div className="error"><p>{say("Some files could not be exported. Only the available files below will be downloaded or shared. Retry preparation to try the missing files again.", "No se pudieron exportar algunos archivos. Solo se descargarán o compartirán los disponibles. Prepara de nuevo para reintentar.")}</p><ul>{prepared.failed.map((f, i) => <li key={`${f.id}-${i}`}>{f.label}: {failureMessage(f.reason)}</li>)}</ul></div>}</div>}
    <div className="media-export-actions">
      <button type="button" className="action-btn primary" onClick={() => void prepare()} disabled={!ready}>{prepared ? say("Prepare again", "Preparar de nuevo") : say("Prepare export", "Preparar exportación")}</button>
      {prepared?.files.length ? <><button type="button" className="action-btn" disabled={busy} onClick={() => void download()}><Download size={18} aria-hidden />{prepared.failed.length ? say("Download available files", "Descargar disponibles") : say("Download ZIP", "Descargar ZIP")}</button><button type="button" className="action-btn" disabled={busy || !canShareMediaFiles(prepared.files)} onClick={() => void share()}><Share2 size={18} aria-hidden />{say("Share / Email", "Compartir / Correo")}</button></> : null}
    </div>
    {prepared?.files.length ? <><p className="muted">{say("Choose Mail or another app in your device’s share sheet. If sharing is unavailable, download the ZIP or individual files and attach them yourself.", "Elige Correo u otra app en el menú de compartir. Si no está disponible, descarga el ZIP o los archivos y adjúntalos.")}</p><ul className="media-export-files">{prepared.files.map(file => <li key={file.name}><span>{file.name}</span><button type="button" className="action-btn" disabled={busy} aria-label={`${say("Download", "Descargar")} ${file.name}`} onClick={() => { if (currentViewer()) downloadMediaBlob(file, file.name); }}><Download size={16} aria-hidden /></button></li>)}</ul></> : null}
    {notice && <p role="status">{notice}</p>}
    <p className="muted">{say("Exports hold up to 50 MB at a time. Choose fewer files or a smaller date range for larger jobs.", "Las exportaciones incluyen hasta 50 MB. Elige menos archivos o fechas más cortas para trabajos grandes.")}</p>
    <p className="muted">{say("Only saved files you can view in Forge are included. Photos waiting to upload stay on your device.", "Solo se incluyen los archivos guardados que puedes ver en Forge. Las fotos pendientes quedan en tu dispositivo.")}</p>
  </Sheet>;
}
