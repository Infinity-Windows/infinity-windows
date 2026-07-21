import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, X } from "lucide-react";
import { enqueueUpload } from "../lib/offline/outbox";
import { capturePhotoMeta, stampPhoto, toPhotoMetaFields } from "../lib/photo/stampPhoto";
import { supabase } from "../lib/supabase";

interface JobPhotoCaptureProps {
  projectId: string | null;
  /** Watermark label (e.g. the job code) burned into each shot. */
  label?: string | null;
  /** Receipts store as attachments.kind 'document' but still get watermarked. */
  kind?: "photo" | "receipt";
  onClose: () => void;
  /** Fired after at least one photo is queued, so the feed can refetch. */
  onQueued?: () => void;
}

/**
 * General "add a job photo" capture: snap with the rear camera or pick files,
 * each photo watermarked with GPS + timestamp and queued to the offline outbox
 * against the selected job. No opening/install required. Works offline.
 */
export function JobPhotoCapture({
  projectId,
  label,
  kind = "photo",
  onClose,
  onQueued,
}: JobPhotoCaptureProps) {
  const isReceipt = kind === "receipt";
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [caption, setCaption] = useState("");
  const [queued, setQueued] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!cameraOn) {
      stopStream();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
      } catch (e) {
        setCameraError(String(e));
        setCameraOn(false);
      }
    })();
    return () => {
      cancelled = true;
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn]);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const queueBlob = async (raw: Blob) => {
    setBusy(true);
    try {
      const meta = await capturePhotoMeta(label ?? null, 8000);
      const stamped = await stampPhoto(raw, meta);
      const fields = toPhotoMetaFields(meta);
      const createdBy = (await supabase.auth.getUser()).data.user?.email ?? null;
      const stamp = Date.now();
      const rand = Math.random().toString(16).slice(2, 8);
      const prefix = projectId ?? "unassigned";
      await enqueueUpload({
        kind,
        bucket: "install-media",
        path: `${prefix}/feed/${stamp}-${rand}.jpg`,
        contentType: "image/jpeg",
        projectId,
        createdBy,
        caption: caption.trim() || null,
        lat: fields.lat,
        lng: fields.lng,
        accuracyM: fields.accuracyM,
        takenAt: fields.takenAt,
        blob: stamped,
      });
      setQueued((n) => n + 1);
      onQueued?.();
    } finally {
      setBusy(false);
    }
  };

  const snap = () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (blob) void queueBlob(blob);
      },
      "image/jpeg",
      0.85,
    );
  };

  const pickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    for (const file of files) {
      if (file.type.startsWith("image/")) await queueBlob(file);
    }
  };

  const title = isReceipt ? "Add a receipt" : "Add job photos";

  return (
    <>
      <div className="capture-backdrop overlay-enter" onClick={onClose} aria-hidden />
      <div
        className="jobphoto-sheet sheet-enter"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="capture-grip" aria-hidden />
        <div className="capture-head">
          <h2 className="capture-title">{title}</h2>
          <button type="button" className="capture-close" aria-label="Close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <p className="muted jobphoto-sub">
          {label ? <>For <strong>{label}</strong>. </> : null}
          Each shot is stamped with the time and GPS location.
        </p>

        {cameraOn ? (
          <div className="jobphoto-stage">
            <video ref={videoRef} playsInline muted className="ba-video" />
            <div className="row-gap">
              <button className="primary big" disabled={busy} onClick={snap}>
                {busy ? "Saving…" : "Capture"}
              </button>
              <button className="big" onClick={() => setCameraOn(false)}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="field-label">Caption (optional)</label>
            <input
              className="jobphoto-caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder={isReceipt ? "e.g. Home Depot — shims" : "e.g. South elevation, unit 3"}
            />
            <div className="jobphoto-actions">
              <button
                type="button"
                className="jobphoto-action"
                onClick={() => setCameraOn(true)}
              >
                <Camera size={22} aria-hidden />
                <span>Use camera</span>
              </button>
              <label className="jobphoto-action" style={{ cursor: "pointer" }}>
                <ImagePlus size={22} aria-hidden />
                <span>Upload files</span>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  multiple={!isReceipt}
                  style={{ display: "none" }}
                  onChange={(e) => void pickFiles(e)}
                />
              </label>
            </div>
          </>
        )}

        {cameraError && <p className="muted">Camera unavailable — use Upload files instead.</p>}
        {busy && !cameraOn && <p className="muted">Stamping GPS &amp; time…</p>}
        {queued > 0 && (
          <p className="ok jobphoto-count">
            {queued} {isReceipt ? "receipt" : "photo"}
            {queued === 1 ? "" : "s"} queued — syncing in the background.
          </p>
        )}
      </div>
    </>
  );
}
