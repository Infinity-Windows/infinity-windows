import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, X } from "lucide-react";
import { enqueueUpload } from "../lib/offline/outbox";
import {
  capturePhotoMeta,
  stampPhoto,
  stampPhotoFile,
  toPhotoMetaFields,
  type StampMeta,
} from "../lib/photo/stampPhoto";
import { supabase } from "../lib/supabase";
import { formatApiError } from "../lib/errors";

export interface BeforeAfterValue {
  before: File | null;
  after: File | null;
  /** Capture metadata (GPS + timestamp) burned into each shot, for persistence. */
  beforeMeta?: StampMeta | null;
  afterMeta?: StampMeta | null;
}

type PhotoCaptureSheetProps =
  | {
      mode: "job";
      projectId: string | null;
      /** Watermark label (e.g. the job code) burned into each shot. */
      label?: string | null;
      /** Receipts store as attachments.kind 'document' but still get watermarked. */
      kind?: "photo" | "receipt";
      onClose: () => void;
      /** Fired after at least one photo is queued, so the feed can refetch. */
      onQueued?: () => void;
    }
  | {
      mode: "beforeAfter";
      value: BeforeAfterValue;
      onChange: (next: BeforeAfterValue) => void;
      /** Optional job/opening label burned into the watermark. */
      label?: string | null;
      /**
       * Which slots to offer. The Check stage shows only ["before"] — the
       * before photo is captured while "before" still exists — and Capture
       * keeps both so a bad first shot can be retaken.
       */
      slots?: ("before" | "after")[];
    }
  | {
      /**
       * One stamped shot handed back to the caller — the phase-proof camera
       * (flashing photos). Same live rear camera, same GPS + timestamp
       * watermark, same file-picker fallback as everything else.
       */
      mode: "single";
      value: File | null;
      onChange: (file: File) => void;
      label?: string | null;
      /** Button copy, e.g. "Photo of the finished flashing". */
      prompt: string;
    };

/**
 * The single photo-capture surface for the whole app. `mode="job"` is the
 * general "add a job photo/receipt" bottom sheet (offline-outbox queued);
 * `mode="beforeAfter"` is the install-proof before/after pair (CompanyCam
 * pattern, ghosted alignment) fed back to the caller. Both share one camera
 * pipeline: rear-camera live capture or file picker, each shot watermarked with
 * GPS + timestamp via stampPhoto. Falls back to the file picker when the camera
 * is unavailable (desktop, denied permission, dead spot). Works offline.
 */
export function PhotoCaptureSheet(props: PhotoCaptureSheetProps) {
  if (props.mode === "beforeAfter") return <BeforeAfterCapture {...props} />;
  if (props.mode === "single") return <SinglePhotoCapture {...props} />;
  return <JobPhotoCapture {...props} />;
}

/** Start the rear camera while `active`, wiring the stream into `videoRef`. */
function useCameraStream(active: boolean, onError: (message: string) => void) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const stopStream = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    if (!active) {
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
        onError(formatApiError(e));
      }
    })();
    return () => {
      cancelled = true;
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return videoRef;
}

/** Grab the current video frame as a JPEG blob (0.85 quality). */
function grabFrame(video: HTMLVideoElement): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85);
  });
}

function JobPhotoCapture({
  projectId,
  label,
  kind = "photo",
  onClose,
  onQueued,
}: Extract<PhotoCaptureSheetProps, { mode: "job" }>) {
  const isReceipt = kind === "receipt";
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [caption, setCaption] = useState("");
  const [queued, setQueued] = useState(0);

  const videoRef = useCameraStream(cameraOn, (message) => {
    setCameraError(message);
    setCameraOn(false);
  });

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
    void grabFrame(video).then((blob) => {
      if (blob) void queueBlob(blob);
    });
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

function BeforeAfterCapture({
  value,
  onChange,
  label,
  slots,
}: Extract<PhotoCaptureSheetProps, { mode: "beforeAfter" }>) {
  const [mode, setMode] = useState<"idle" | "before" | "after">("idle");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [stamping, setStamping] = useState(false);

  const metaKey = (slot: "before" | "after"): "beforeMeta" | "afterMeta" =>
    slot === "before" ? "beforeMeta" : "afterMeta";

  const applyPhoto = async (slot: "before" | "after", raw: File) => {
    setStamping(true);
    try {
      const meta = await capturePhotoMeta(label ?? null, 8000);
      const stamped = await stampPhotoFile(raw, meta);
      onChange({ ...value, [slot]: stamped, [metaKey(slot)]: meta });
    } finally {
      setStamping(false);
    }
  };

  const videoRef = useCameraStream(mode !== "idle", (message) => {
    setCameraError(message);
    setMode("idle");
  });

  const beforeUrl = useObjectUrl(value.before);
  const afterUrl = useObjectUrl(value.after);

  const snap = () => {
    const video = videoRef.current;
    if (!video || mode === "idle") return;
    const slot = mode;
    void grabFrame(video).then((blob) => {
      if (!blob) return;
      const file = new File([blob], `${slot}-${Date.now()}.jpg`, {
        type: "image/jpeg",
      });
      setMode("idle");
      void applyPhoto(slot, file);
    });
  };

  const pickFile = (slot: "before" | "after") => (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (file) void applyPhoto(slot, file);
    e.target.value = "";
  };

  if (mode !== "idle") {
    return (
      <div className="ba-camera">
        <div className="ba-camera-stage">
          <video ref={videoRef} playsInline muted className="ba-video" />
          {mode === "after" && beforeUrl && (
            <img src={beforeUrl} alt="before ghost" className="ba-ghost" />
          )}
        </div>
        <div className="row-gap">
          <button className="primary big" onClick={snap}>
            Capture {mode}
          </button>
          <button className="big" onClick={() => setMode("idle")}>
            Cancel
          </button>
        </div>
        {mode === "after" && beforeUrl && (
          <p className="muted">Line up with the ghosted "before" shot.</p>
        )}
      </div>
    );
  }

  return (
    <div className="ba-grid">
      {(slots ?? (["before", "after"] as const)).map((slot) => {
        const url = slot === "before" ? beforeUrl : afterUrl;
        return (
          <div key={slot} className="ba-slot">
            <span className="field-label" style={{ textTransform: "capitalize" }}>
              {slot}
            </span>
            {url ? (
              <img src={url} alt={slot} className="ba-thumb" />
            ) : (
              <div className="ba-empty muted">no {slot} photo</div>
            )}
            <div className="row-gap">
              <button className="link" onClick={() => setMode(slot)}>
                {url ? "Retake" : "Camera"}
              </button>
              <label className="link" style={{ cursor: "pointer" }}>
                File
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  style={{ display: "none" }}
                  onChange={pickFile(slot)}
                />
              </label>
            </div>
          </div>
        );
      })}
      {stamping && (
        <p className="muted" style={{ gridColumn: "1 / -1" }}>
          Stamping GPS &amp; time…
        </p>
      )}
      {cameraError && (
        <p className="muted" style={{ gridColumn: "1 / -1" }}>
          Camera unavailable — use File instead.
        </p>
      )}
    </div>
  );
}

function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

function SinglePhotoCapture({
  value,
  onChange,
  label,
  prompt,
}: Extract<PhotoCaptureSheetProps, { mode: "single" }>) {
  const [live, setLive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [stamping, setStamping] = useState(false);

  const applyPhoto = async (raw: File) => {
    setStamping(true);
    try {
      const meta = await capturePhotoMeta(label ?? null, 8000);
      const stamped = await stampPhotoFile(raw, meta);
      onChange(stamped);
    } finally {
      setStamping(false);
    }
  };

  const videoRef = useCameraStream(live, (message) => {
    setCameraError(message);
    setLive(false);
  });
  const url = useObjectUrl(value);

  const snap = () => {
    const video = videoRef.current;
    if (!video) return;
    void grabFrame(video).then((blob) => {
      if (!blob) return;
      const file = new File([blob], `phase-${Date.now()}.jpg`, { type: "image/jpeg" });
      setLive(false);
      void applyPhoto(file);
    });
  };

  if (live) {
    return (
      <div className="ba-camera">
        <div className="ba-camera-stage">
          <video ref={videoRef} playsInline muted className="ba-video" />
        </div>
        <div className="row-gap">
          <button className="primary big" onClick={snap}>Capture</button>
          <button className="big" onClick={() => setLive(false)}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="ba-grid" style={{ gridTemplateColumns: "1fr" }}>
      <div className="ba-slot">
        <span className="field-label">{prompt}</span>
        {url ? (
          <img src={url} alt={prompt} className="ba-thumb" />
        ) : (
          <div className="ba-empty muted">no photo yet</div>
        )}
        <div className="row-gap">
          <button className="link" onClick={() => setLive(true)}>
            {url ? "Retake" : "Camera"}
          </button>
          <label className="link" style={{ cursor: "pointer" }}>
            File
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void applyPhoto(f);
                e.target.value = "";
              }}
            />
          </label>
          {stamping && <span className="muted">stamping…</span>}
        </div>
        {cameraError && <p className="muted">{cameraError} — use File instead.</p>}
      </div>
    </div>
  );
}
