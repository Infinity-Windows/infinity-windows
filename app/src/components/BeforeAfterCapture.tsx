import { useEffect, useRef, useState } from "react";
import { capturePhotoMeta, stampPhotoFile, type StampMeta } from "../lib/photo/stampPhoto";

export interface BeforeAfterValue {
  before: File | null;
  after: File | null;
  /** Capture metadata (GPS + timestamp) burned into each shot, for persistence. */
  beforeMeta?: StampMeta | null;
  afterMeta?: StampMeta | null;
}

/**
 * Photo-first capture (CompanyCam pattern): a "before" and an "after" shot.
 * When taking the after, the before image is ghosted over the live camera so
 * the installer lines up the same angle. Falls back to the file picker when
 * the camera is unavailable (desktop, denied permission, dead spot).
 */
export function BeforeAfterCapture({
  value,
  onChange,
  label,
}: {
  value: BeforeAfterValue;
  onChange: (next: BeforeAfterValue) => void;
  /** Optional job/opening label burned into the watermark. */
  label?: string | null;
}) {
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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const beforeUrl = useObjectUrl(value.before);
  const afterUrl = useObjectUrl(value.after);

  useEffect(() => {
    if (mode === "idle") {
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
        setMode("idle");
      }
    })();
    return () => {
      cancelled = true;
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const snap = () => {
    const video = videoRef.current;
    if (!video || mode === "idle") return;
    const slot = mode;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], `${slot}-${Date.now()}.jpg`, {
          type: "image/jpeg",
        });
        setMode("idle");
        void applyPhoto(slot, file);
      },
      "image/jpeg",
      0.85,
    );
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
      {(["before", "after"] as const).map((slot) => {
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
