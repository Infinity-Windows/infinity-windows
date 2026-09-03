import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Camera,
  CheckCircle2,
  ImageIcon,
  MapPin,
  Receipt as ReceiptIcon,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  deleteJobPhoto,
  groupPhotosByDay,
  listDeletedPhotos,
  listPhotos,
  photoTime,
  restoreJobPhoto,
  type FeedPhoto,
} from "../../lib/photos";
import { formatCents } from "../../lib/aiSpend";
import { listReceipts, type Receipt } from "../../lib/receipts";
import { subscribeSynced } from "../../lib/offline/outbox";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isForemanPlus } from "../../lib/install/types";
import { pushToast, toastError } from "../../lib/toast";
import { EmptyState, QueryError, SkeletonCard } from "../ui/States";
import { PhotoCaptureSheet } from "../PhotoCaptureSheet";
import { useT } from "../../lib/i18n";

function whoLabel(createdBy: string | null): string {
  if (!createdBy) return "Someone";
  const at = createdBy.indexOf("@");
  return at > 0 ? createdBy.slice(0, at) : createdBy;
}

function timeLabel(p: FeedPhoto): string {
  const d = new Date(photoTime(p));
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function mapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

/** Shaped to fit groupPhotosByDay's generic Pick<takenAt|createdAt>, so the
 * same day-grouping the photo grid uses groups receipts too. */
interface FeedReceipt {
  id: string;
  takenAt: string | null;
  createdAt: string;
  signedUrl: string | null;
  vendor: string | null;
  amountCents: number | null;
  jobCode: string | null;
  pendingJobName: string | null;
  reviewed: boolean;
}

function toFeedReceipt(r: Receipt): FeedReceipt {
  return {
    id: r.id,
    // purchasedOn (a bare date) when the machine or a human has it; falls
    // back to the server insert time, same convention photoTime() uses.
    takenAt: r.purchasedOn,
    createdAt: r.createdAt,
    signedUrl: r.signedUrl,
    vendor: r.vendor,
    amountCents: r.amountCents,
    jobCode: r.jobCode,
    pendingJobName: r.pendingJobName,
    reviewed: r.reviewedAt != null,
  };
}

/**
 * The photo/receipt feed body — day-grouped grid, capture flow and lightbox —
 * scoped to a single project (or all jobs when `projectId` is null). Shared by
 * the standalone Photos page and the project hub's Photos tab so the feed logic
 * lives in one place. Page-specific chrome (the job filter) is passed via
 * `toolbarExtra`.
 *
 * kind="receipt" reads from the `receipts` table (Wave P) rather than
 * `attachments` — a receipt is a structured row (amount/vendor/category/
 * review), not a bare photo, and RLS already scopes what comes back
 * (foreman+ sees every receipt on the job; an installer sees only their own
 * uploads) so no extra filtering is needed here. The office's full
 * filterable table with CSV/zip export lives at /receipts (P4); this is
 * just "what I've snapped," the same quick-glance role the photo grid plays.
 */
export function PhotoFeed({
  projectId,
  selectedJobCode,
  kind = "photo",
  initialCapture = false,
  toolbarExtra,
}: {
  projectId: string | null;
  selectedJobCode: string | null;
  kind?: "photo" | "receipt";
  initialCapture?: boolean;
  toolbarExtra?: ReactNode;
}) {
  const isReceipt = kind === "receipt";
  const t = useT();
  const queryClient = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  // Removing / restoring a job photo is foreman+ (server-enforced by the RPCs).
  // Receipts have their own model — no trash here.
  const canCurate = isForemanPlus(effectiveRole) && !isReceipt;
  const [capturing, setCapturing] = useState(initialCapture);
  const [viewer, setViewer] = useState<FeedPhoto | null>(null);
  const [showTrash, setShowTrash] = useState(false);

  const photos = useQuery({
    queryKey: ["photos", projectId ?? "all"],
    queryFn: () => listPhotos(projectId),
    enabled: !isReceipt,
  });
  const receipts = useQuery({
    queryKey: ["receipts-feed", projectId ?? "all"],
    queryFn: () => listReceipts({ projectId }),
    enabled: isReceipt,
  });
  // The 30-day recoverable trash (slice 3) — loaded only when a lead opens it.
  const trash = useQuery({
    queryKey: ["photos-trash", projectId ?? "all"],
    queryFn: () => listDeletedPhotos(projectId),
    enabled: canCurate && showTrash,
  });

  const refreshPhotos = () => {
    void queryClient.invalidateQueries({ queryKey: ["photos"] });
    void queryClient.invalidateQueries({ queryKey: ["photos-trash"] });
  };

  const removePhoto = useMutation({
    mutationFn: (id: string) => deleteJobPhoto(id),
    onSuccess: () => {
      pushToast(t("feed.photoTrashed"), "info");
      setViewer(null);
      refreshPhotos();
    },
    onError: (e) => toastError(e),
  });
  const restorePhoto = useMutation({
    mutationFn: (id: string) => restoreJobPhoto(id),
    onSuccess: () => {
      pushToast("Photo restored.", "info");
      refreshPhotos();
    },
    onError: (e) => toastError(e),
  });

  useEffect(() => {
    return subscribeSynced(() => {
      void queryClient.invalidateQueries({ queryKey: ["photos"] });
      void queryClient.invalidateQueries({ queryKey: ["receipts-feed"] });
    });
  }, [queryClient]);

  const groups = useMemo(
    () => groupPhotosByDay(photos.data ?? []),
    [photos.data],
  );
  const receiptGroups = useMemo(
    () => groupPhotosByDay((receipts.data ?? []).map(toFeedReceipt)),
    [receipts.data],
  );

  const isLoading = isReceipt ? receipts.isLoading : photos.isLoading;
  const isError = isReceipt ? receipts.isError : photos.isError;
  const isEmpty = isReceipt ? receiptGroups.length === 0 : groups.length === 0;

  return (
    <>
      <div className="photos-toolbar">
        {toolbarExtra}
        <button
          type="button"
          className="action-btn primary photos-add"
          onClick={() => setCapturing(true)}
        >
          {isReceipt ? <ReceiptIcon size={16} aria-hidden /> : <Camera size={16} aria-hidden />}{" "}
          {isReceipt ? "Add receipt" : "Add photo"}
        </button>
        {canCurate && (
          <button
            type="button"
            className="action-btn"
            aria-pressed={showTrash}
            onClick={() => setShowTrash((v) => !v)}
          >
            <Trash2 size={16} aria-hidden /> {showTrash ? t("feed.backToPhotos") : t("feed.trash")}
          </button>
        )}
      </div>

      {/* ---- The 30-day recoverable trash (foreman+) ---- */}
      {showTrash && (
        <>
          <p className="muted" style={{ margin: "0 0 8px" }}>
            {t("feed.trashHint")}
          </p>
          {trash.isLoading && (
            <div className="photos-grid">
              {Array.from({ length: 3 }).map((_, i) => (
                <SkeletonCard key={i} height={120} />
              ))}
            </div>
          )}
          {trash.isError && (
            <QueryError
              error={trash.error}
              onRetry={() => void trash.refetch()}
              label="Couldn't load the trash"
            />
          )}
          {trash.isSuccess && trash.data.length === 0 && (
            <EmptyState
              icon={<Trash2 size={22} />}
              title="Trash is empty"
              message="Removed photos show up here, recoverable for 30 days."
            />
          )}
          {trash.isSuccess && trash.data.length > 0 && (
            <div className="photos-grid">
              {trash.data.map((p) => (
                <div key={p.id} className="photo-card">
                  {p.signedUrl ? (
                    <img src={p.signedUrl} alt={p.caption ?? "Removed photo"} loading="lazy" />
                  ) : (
                    <div className="photo-card-missing muted">
                      <ImageIcon size={20} aria-hidden />
                    </div>
                  )}
                  <span className="photo-card-meta">
                    <span className="photo-card-who">{whoLabel(p.createdBy)}</span>
                    <button
                      type="button"
                      className="link"
                      disabled={restorePhoto.isPending}
                      onClick={() => restorePhoto.mutate(p.id)}
                    >
                      <RotateCcw size={12} aria-hidden /> {t("feed.restore")}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {!showTrash && isLoading && (
        <div className="photos-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} height={120} />
          ))}
        </div>
      )}
      {!showTrash && isError && (
        <QueryError
          error={isReceipt ? receipts.error : photos.error}
          onRetry={() => void (isReceipt ? receipts.refetch() : photos.refetch())}
          label={isReceipt ? "Couldn't load receipts" : "Couldn't load photos"}
        />
      )}
      {!showTrash && !isLoading && !isError && isEmpty && (
        <EmptyState
          icon={isReceipt ? <ReceiptIcon size={22} /> : <ImageIcon size={22} />}
          title={isReceipt ? "No receipts yet" : "No photos yet"}
          message={
            isReceipt
              ? "Snap a gas or materials receipt — the job is optional, everything else is skippable."
              : selectedJobCode
                ? "Snap the first progress or install photo for this job."
                : "Photos from every job show up here as the crew captures them."
          }
          action={
            <button type="button" className="action-btn primary" onClick={() => setCapturing(true)}>
              {isReceipt ? (
                <>
                  <ReceiptIcon size={16} aria-hidden /> Add a receipt
                </>
              ) : (
                <>
                  <Camera size={16} aria-hidden /> Add a photo
                </>
              )}
            </button>
          }
        />
      )}

      {!showTrash && !isLoading && !isError && !isReceipt &&
        groups.map((group) => (
          <section key={group.key} className="photos-day">
            <h2 className="photos-day-label">{group.label}</h2>
            <div className="photos-grid">
              {group.photos.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="photo-card"
                  onClick={() => setViewer(p)}
                >
                  {p.signedUrl ? (
                    <img src={p.signedUrl} alt={p.caption ?? "Job photo"} loading="lazy" />
                  ) : (
                    <div className="photo-card-missing muted">
                      <ImageIcon size={20} aria-hidden />
                    </div>
                  )}
                  <span className="photo-card-meta">
                    <span className="photo-card-who">{whoLabel(p.createdBy)}</span>
                    <span className="photo-card-time">{timeLabel(p)}</span>
                  </span>
                  {p.lat != null && p.lng != null && (
                    <span className="photo-gps-chip">
                      <MapPin size={11} aria-hidden /> GPS
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        ))}

      {!showTrash && !isLoading && !isError && isReceipt &&
        receiptGroups.map((group) => (
          <section key={group.key} className="photos-day">
            <h2 className="photos-day-label">{group.label}</h2>
            <div className="photos-grid">
              {group.photos.map((r) => (
                <div key={r.id} className="photo-card receipt-card">
                  {r.signedUrl ? (
                    <img src={r.signedUrl} alt={r.vendor ?? "Receipt"} loading="lazy" />
                  ) : (
                    <div className="photo-card-missing muted">
                      <ReceiptIcon size={20} aria-hidden />
                    </div>
                  )}
                  <span className="photo-card-meta">
                    <span className="photo-card-who">{r.vendor ?? "Receipt"}</span>
                    <span className="photo-card-time">
                      {r.amountCents != null ? formatCents(r.amountCents) : "—"}
                    </span>
                  </span>
                  {r.reviewed && (
                    <span className="photo-gps-chip">
                      <CheckCircle2 size={11} aria-hidden /> Reviewed
                    </span>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}

      {capturing && (
        <PhotoCaptureSheet
          mode="job"
          projectId={projectId}
          label={selectedJobCode}
          kind={kind}
          onClose={() => setCapturing(false)}
          onQueued={() => {
            void photos.refetch();
            void receipts.refetch();
          }}
        />
      )}

      {viewer && (
        <div
          className="photo-viewer-backdrop overlay-enter"
          role="dialog"
          aria-modal="true"
          onClick={() => setViewer(null)}
        >
          <div className="photo-viewer" onClick={(e) => e.stopPropagation()}>
            {viewer.signedUrl ? (
              <img src={viewer.signedUrl} alt={viewer.caption ?? "Job photo"} />
            ) : (
              <div className="photo-card-missing muted">Image unavailable offline.</div>
            )}
            <div className="photo-viewer-info">
              {viewer.caption && <p className="photo-viewer-caption">{viewer.caption}</p>}
              <p className="muted">
                {whoLabel(viewer.createdBy)} ·{" "}
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(photoTime(viewer)))}
              </p>
              {viewer.lat != null && viewer.lng != null && (
                <a
                  className="photo-viewer-map"
                  href={mapsUrl(viewer.lat, viewer.lng)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <MapPin size={13} aria-hidden /> {viewer.lat.toFixed(4)},{" "}
                  {viewer.lng.toFixed(4)}
                </a>
              )}
            </div>
            <div className="row-gap" style={{ justifyContent: "space-between" }}>
              {canCurate && (
                <button
                  type="button"
                  className="button-like"
                  disabled={removePhoto.isPending}
                  onClick={() => {
                    if (window.confirm(t("feed.removeConfirm"))) {
                      removePhoto.mutate(viewer.id);
                    }
                  }}
                >
                  <Trash2 size={14} aria-hidden /> Remove
                </button>
              )}
              <button
                type="button"
                className="action-btn photo-viewer-close"
                onClick={() => setViewer(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
