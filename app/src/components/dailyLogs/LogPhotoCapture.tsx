// Log photos (section 7 of the Log Today form, Horizon parity). Equal-width
// Take one / Choose, through the SAME usePhotoPicker rule every photo
// surface in the app follows (camera input always `capture`, library input
// never does — lib/photo/usePhotoPicker.tsx).
//
// Owner acceptance review, 2026-10-01: both buttons must work on a log that
// has never been saved — the original gate ("save first, then add photos")
// failed the owner's own acceptance check and is gone. A photo taken before
// the first Save cannot be tagged on the server yet (the tagged-photo path
// needs a real daily_logs id, and Astra's attachments trigger refuses to let
// an ordinary caller retag an untagged photo after the fact — that IS the
// forged-tag hole the trigger exists to close), so it is held locally
// instead, in dailyLogPendingPhotos's own durable IndexedDB store — never
// just React state, so it survives a close or a reload. The moment a real
// dailyLogId exists (this mount, or a later one that finds the log already
// saved), every pending photo for this exact owner/job/day is reconciled:
// handed to the real upload queue with the SAME client id it was minted
// with, then dropped from the local store. A photo here is log context, not
// automatic unit/QC evidence.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, ImagePlus } from "lucide-react";
import { usePhotoPicker } from "../../lib/photo/usePhotoPicker";
import { capturePhotoMeta, stampPhoto, toPhotoMetaFields } from "../../lib/photo/stampPhoto";
import {
  addDailyLogPendingPhoto,
  listDailyLogPendingPhotos,
  reconcileDailyLogPendingPhotos,
  type DailyLogPendingPhoto,
} from "../../lib/offline/dailyLogPendingPhotos";
import { dailyLogPhotoUploader } from "../../lib/offline/dailyLogPhotoUploader";
import { listDailyLogPhotos } from "../../lib/photos";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import { useT } from "../../lib/i18n";
import {subscribeSynced} from "../../lib/offline/outbox";
import {signedInEmail,signInMark,stillSignedInAs} from "../../lib/signedIn";
import { PhotoUploadStatus } from "../photos/PhotoUploadStatus";

function newClientId(): string {
  return crypto.randomUUID();
}

export function LogPhotoCapture({
  projectId,
  logDate,
  ownerId,
  dailyLogId,
  disabled = false,
  onBusyChange,
  onStorageIssue,
}: {
  projectId: string;
  logDate: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onStorageIssue?: (failed: boolean) => void;
  /** Null only while sign-in is still resolving — the picker still renders
   * (Take one / Choose must never wait on a network round trip) but a photo
   * taken with no owner known yet is held in memory only, not written to the
   * pending store (which is owner-scoped on purpose, like the draft and the
   * conflict record). */
  ownerId: string | null;
  /** The confirmed server id, once this log has been saved at least once —
   * null for a brand-new, never-saved log. */
  dailyLogId: string | null;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [queuedIds, setQueuedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [unsaved, setUnsaved] = useState<DailyLogPendingPhoto[]>([]);
  useEffect(() => { onStorageIssue?.(unsaved.length > 0); }, [unsaved.length,onStorageIssue]);
  const objectUrls = useRef(new Map<string, string>());

  const saved = useQuery({
    queryKey: ["dailyLogPhotos", dailyLogId],
    queryFn: () => (dailyLogId ? listDailyLogPhotos(dailyLogId) : Promise.resolve([])),
    enabled: !!dailyLogId,
  });
  const pending = useQuery({
    queryKey: ["dailyLogPendingPhotos", ownerId, projectId, logDate],
    queryFn: () => (ownerId ? listDailyLogPendingPhotos(ownerId, projectId, logDate) : Promise.resolve([])),
    enabled: !!ownerId,
  });

  useEffect(()=>subscribeSynced(()=>{
    if(dailyLogId)void queryClient.invalidateQueries({queryKey:["dailyLogPhotos",dailyLogId]});
  }),[dailyLogId,queryClient]);
  // The log just became confirmed (this Save, or an earlier one found on
  // reopen) — reconcile every photo still waiting locally for this exact
  // owner/job/day. Idempotent: a photo already reconciled by an earlier
  // mount is simply not in the pending store anymore, so this is a no-op the
  // common case (no photos were taken before the first Save).
  useEffect(() => {
    if (!dailyLogId || !ownerId) return;
    let cancelled = false;
    void reconcileDailyLogPendingPhotos(
      { ownerId, projectId, logDate, dailyLogId, uploaderUid: ownerId },
      dailyLogPhotoUploader,
    ).then((result) => {
      if (cancelled) return;
      if (result.reconciled > 0) {
        void queryClient.invalidateQueries({ queryKey: ["dailyLogPendingPhotos", ownerId, projectId, logDate] });
        void queryClient.invalidateQueries({ queryKey: ["dailyLogPhotos", dailyLogId] });
      }
      if (result.failed > 0) {
        pushToast(t("dailyLog.photos.failed"), "error");
      }
    }).catch(e=>{if(!cancelled)pushToast(formatApiError(e),"error");});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyLogId, ownerId, projectId, logDate]);

  useEffect(() => {
    const urls = objectUrls.current;
    return () => { for (const url of urls.values()) URL.revokeObjectURL(url); };
  }, []);

  function urlFor(id: string, blob: Blob): string {
    let url = objectUrls.current.get(id);
    if (!url) {
      url = URL.createObjectURL(blob);
      objectUrls.current.set(id, url);
    }
    return url;
  }

  async function persist(photo: DailyLogPendingPhoto) {
    // Even an already-filed log uses durable local staging before handoff.
    await addDailyLogPendingPhoto(photo);
    if(dailyLogId){
      const outcome=await reconcileDailyLogPendingPhotos({ownerId:photo.ownerId,projectId,logDate,dailyLogId,uploaderUid:photo.ownerId},dailyLogPhotoUploader);
      if(outcome.reconciled)setQueuedIds(ids=>[...ids,photo.id]);
      if(outcome.failed)throw new Error("Photo remains saved on this phone for upload retry");
    }
    await pending.refetch();
  }
  async function onFiles(files: File[]) {
    if(disabled)return;
    const mark=signInMark();
    const email=signedInEmail();
    if(!ownerId || !email || !stillSignedInAs(mark,ownerId))return;
    setBusy(true);onBusyChange?.(true);
    try {
      for(const file of files){
        const meta=await capturePhotoMeta(null);
        const stamped=await stampPhoto(file,meta);
        if(!stillSignedInAs(mark,ownerId))throw new Error("Sign-in changed while preparing this photo");
        const fields=toPhotoMetaFields(meta);
        const photo:DailyLogPendingPhoto={id:newClientId(),ownerId,projectId,logDate,blob:stamped,contentType:"image/jpeg",...fields,createdBy:email,capturedAt:Date.now()};
        try { await persist(photo); }
        catch(e){ setUnsaved(old=>[...old,photo]);throw e; }
      }
      void saved.refetch();
    }catch(e){pushToast(`${t("dailyLog.photos.failed")} — ${formatApiError(e)}`,"error");}
    finally{setBusy(false);onBusyChange?.(false);}
  }
  async function retryUnsaved(){
    const mark=signInMark();
    if(!ownerId || !stillSignedInAs(mark,ownerId))return;
    setBusy(true);onBusyChange?.(true);
    try{
      for(const photo of unsaved){
        if(!stillSignedInAs(mark,photo.ownerId))throw new Error("Sign-in changed");
        await persist(photo);
        setUnsaved(old=>old.filter(p=>p.id!==photo.id));
      }
    }catch(e){pushToast(formatApiError(e),"error");}
    finally{setBusy(false);onBusyChange?.(false);}
  }

  const picker = usePhotoPicker({ camera: true, multiple: true, onFiles });
  const pendingPhotos = pending.data ?? [];
  const savedPhotos = saved.data ?? [];

  return (
    <div className="daily-log-photos">
      {unsaved.length>0 && <div role="alert">
        <p>{t("dailyLog.photos.failed")}</p>
        <button type="button" disabled={busy || disabled} onClick={()=>void retryUnsaved()}>{t("mondayFiles.new.retry")}</button>
        <button type="button" disabled={busy || disabled} onClick={()=>setUnsaved([])}>{t("dailyLog.delays.remove")}</button>
        <ul className="daily-log-photo-grid">{unsaved.map(p=><li key={p.id}><img src={urlFor(p.id,p.blob)} alt="" /></li>)}</ul>
      </div>}
      <div className="daily-log-photo-buttons">
        <button type="button" className="button-like" disabled={busy || disabled} onClick={picker.openCamera}>
          <Camera size={18} aria-hidden="true" /> {t("dailyLog.photos.takeOne")}
        </button>
        <button type="button" className="button-like" disabled={busy || disabled} onClick={picker.openLibrary}>
          <ImagePlus size={18} aria-hidden="true" /> {t("dailyLog.photos.choose")}
        </button>
      </div>
      {picker.inputs}
      <PhotoUploadStatus projectId={projectId} entryIds={queuedIds} />
      {pendingPhotos.length > 0 && (
        <>
          <p className="muted daily-log-photos-pending-note">{t("dailyLog.photos.pending")}</p>
          <ul className="daily-log-photo-grid daily-log-photo-grid-pending">
            {pendingPhotos.map((p) => (
              <li key={p.id}><img src={urlFor(p.id, p.blob)} alt="" /></li>
            ))}
          </ul>
        </>
      )}
      {savedPhotos.length > 0 && (
        <ul className="daily-log-photo-grid">
          {savedPhotos.map((p) => (
            <li key={p.id}>
              {p.signedUrl && <img src={p.signedUrl} alt="" loading="lazy" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
