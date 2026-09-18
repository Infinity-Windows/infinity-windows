import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, FolderOpen } from "lucide-react";
import { getPhotoUploadProgress, listFailed, retryFailed, subscribe } from "../../lib/offline/outbox";
import type { PhotoUploadProgress } from "../../lib/offline/photoUploadProgress";
import { signedInEmail } from "../../lib/signedIn";
import { useT } from "../../lib/i18n";
import { toastError } from "../../lib/toast";

const NO_ENTRIES: readonly string[] = [];

/** Show the actual result beside the camera/gallery. The captured-photo count
 * is not the pending count, and an empty queue alone is not proof of success. */
export function PhotoUploadStatus({ projectId, entryIds = NO_ENTRIES, showGalleryLink = false, onViewGallery }: {
  projectId: string | null;
  entryIds?: readonly string[];
  showGalleryLink?: boolean;
  onViewGallery?: () => void;
}) {
  const t = useT();
  const [failed, setFailed] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<{ ids: readonly string[]; progress: PhotoUploadProgress } | null>(null);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const email = signedInEmail()?.toLowerCase();
        const [entries, progress] = await Promise.all([listFailed(), getPhotoUploadProgress(entryIds)]);
        if (!alive || generation !== current) return;
        setFailed(entries.filter((entry) =>
          entry.op === "photo_upload" && email &&
          typeof entry.payload.createdBy === "string" &&
          entry.payload.createdBy.toLowerCase() === email &&
          (!projectId || entry.payload.projectId === projectId),
        ).map((entry) => entry.id));
        setSnapshot({ ids: entryIds, progress });
      } catch { /* Keep checking visible; never invent a successful upload. */ }
    };
    const off = subscribe(() => { void refresh(); });
    void refresh();
    return () => { alive = false; off(); };
  }, [projectId, entryIds]);

  if (!failed.length && !entryIds.length) return null;
  const progress = snapshot?.ids === entryIds ? snapshot.progress : null;
  const retry = async () => {
    setRetrying(true);
    try {
      for (const id of failed) await retryFailed(id);
    } catch (error) { toastError(error); }
    finally { setRetrying(false); }
  };
  return <div className="card photo-upload-status" role="status" style={{ marginBlock: 12 }}>
    {entryIds.length > 0 && <>
      {!progress && <p className="muted">{t("photo.checkingUploads")}</p>}
      {Boolean(progress?.uploaded) && <p className="ok row-gap">
        <CheckCircle2 size={18} aria-hidden />
        {progress!.uploaded === 1 ? t("photo.uploadedOne") : t("photo.uploadedMany", { n: progress!.uploaded })}
      </p>}
      {Boolean(progress?.pending) && <>
        <p>{progress!.pending === 1 ? t("photo.waitingOne") : t("photo.waitingMany", { n: progress!.pending })}</p>
        <p className="muted">{t("photo.waitingHint")}</p>
      </>}
      {Boolean(progress?.unconfirmed) && <p className="muted">{t("photo.uploadUnconfirmed")}</p>}
    </>}
    {failed.length > 0 && <>
      <strong>{t("photo.uploadNeedsAttention", { n: failed.length })}</strong>
      <p className="muted">{t("photo.uploadRetryHint")}</p>
      <div className="row-gap">
        <button type="button" disabled={retrying} onClick={() => void retry()}>{t("photo.retryUploads")}</button>
        <Link to="/stuck">{t("photo.reviewUploads")}</Link>
      </div>
    </>}
    {showGalleryLink && entryIds.length > 0 && <Link
      className="action-btn"
      onClick={onViewGallery}
      to={projectId ? `/photos?project=${projectId}` : "/photos"}
    ><FolderOpen size={16} aria-hidden /> {t("photo.viewJobPhotos")}</Link>}
  </div>;
}
