import { useState } from "react";
import { Paperclip, Trash2 } from "lucide-react";
import type { TripAttachment } from "../../lib/travel/types";
import {
  deleteAttachment,
  signedAttachmentUrl,
  uploadTripAttachment,
} from "../../lib/travel/api";
import { toastError, toastSuccess } from "../../lib/toast";
import { useT } from "../../lib/i18n";

/**
 * Private attachments (boarding passes, reservations, screenshots). Files open
 * via short-lived signed URLs; supervisors can upload/remove.
 */
export function AttachmentsPanel({
  tripId,
  attachments,
  canEdit,
  scope,
  onChanged,
}: {
  tripId: string;
  attachments: TripAttachment[];
  canEdit: boolean;
  scope?: { flightId?: string | null; lodgingId?: string | null };
  onChanged: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const open = async (att: TripAttachment) => {
    const url = await signedAttachmentUrl(att.storage_path);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    else toastError(null, t("travelAttach.couldNotOpen"));
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      await uploadTripAttachment({
        tripId,
        file,
        flightId: scope?.flightId ?? null,
        lodgingId: scope?.lodgingId ?? null,
      });
      toastSuccess(t("travelAttach.added"));
      onChanged();
    } catch (err) {
      toastError(err, t("travelAttach.uploadFailed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (att: TripAttachment) => {
    setBusy(true);
    try {
      await deleteAttachment(att);
      onChanged();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  if (attachments.length === 0 && !canEdit) return null;

  return (
    <div className="travel-attach">
      {attachments.map((att) => (
        <span key={att.id} className="travel-attach-chip">
          <button type="button" className="travel-attach-open" onClick={() => open(att)}>
            <Paperclip size={13} aria-hidden /> {att.label ?? t("travelAttach.attachment")}
          </button>
          {canEdit && (
            <button
              type="button"
              className="travel-attach-del"
              aria-label={t("travelAttach.removeAttachment")}
              disabled={busy}
              onClick={() => remove(att)}
            >
              <Trash2 size={12} />
            </button>
          )}
        </span>
      ))}
      {canEdit && (
        <label className="travel-attach-add">
          <Paperclip size={13} aria-hidden /> {busy ? t("travelAttach.uploading") : t("travelAttach.addFile")}
          <input type="file" hidden onChange={onUpload} disabled={busy} />
        </label>
      )}
    </div>
  );
}
