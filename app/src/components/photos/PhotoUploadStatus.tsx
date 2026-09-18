import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listFailed, retryFailed, subscribe } from "../../lib/offline/outbox";
import { signedInEmail } from "../../lib/signedIn";
import { useT } from "../../lib/i18n";
import { toastError } from "../../lib/toast";

/** Keep the upload result beside the camera/gallery. A successful local save
 * must not hide a later server refusal behind the global connection pill. */
export function PhotoUploadStatus({ projectId }: { projectId: string | null }) {
  const t = useT();
  const [failed, setFailed] = useState<string[]>([]);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const email = signedInEmail()?.toLowerCase();
        const entries = await listFailed();
        if (!alive || generation !== current) return;
        setFailed(entries.filter((entry) =>
          entry.op === "photo_upload" && email &&
          typeof entry.payload.createdBy === "string" &&
          entry.payload.createdBy.toLowerCase() === email &&
          (!projectId || entry.payload.projectId === projectId),
        ).map((entry) => entry.id));
      } catch { /* The global diagnostics screen retains storage failures. */ }
    };
    const off = subscribe(() => { void refresh(); });
    void refresh();
    return () => { alive = false; off(); };
  }, [projectId]);

  if (!failed.length) return null;
  const retry = async () => {
    setRetrying(true);
    try {
      for (const id of failed) await retryFailed(id);
    } catch (error) { toastError(error); }
    finally { setRetrying(false); }
  };
  return <div className="card" role="status" style={{ marginBlock: 12 }}>
    <strong>{t("photo.uploadNeedsAttention", { n: failed.length })}</strong>
    <p className="muted">{t("photo.uploadRetryHint")}</p>
    <div className="row-gap">
      <button type="button" disabled={retrying} onClick={() => void retry()}>{t("photo.retryUploads")}</button>
      <Link to="/stuck">{t("photo.reviewUploads")}</Link>
    </div>
  </div>;
}
