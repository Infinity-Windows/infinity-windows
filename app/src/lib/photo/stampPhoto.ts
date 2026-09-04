// Burn a CompanyCam-style GPS + timestamp watermark into a photo at capture
// time, and shape the same facts into structured metadata for the attachments
// row. The text/coord/date composition is pure (and unit-tested); only the
// pixel work touches the DOM, behind a tiny canvas seam that degrades to the
// original blob when no 2D context is available (e.g. jsdom in tests).

import { captureGeoSoft } from "../geo";

export interface StampMeta {
  takenAt: Date;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  /** Job/opening label shown on the overlay, e.g. a job code. */
  label?: string | null;
}

/** Structured fields persisted alongside the photo (see attachments geo columns). */
export interface PhotoMetaFields {
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  takenAt: string;
}

/** Format a lat/lng pair to 4 decimals, or null when either is missing/invalid. */
export function formatCoords(
  lat: number | null | undefined,
  lng: number | null | undefined,
): string | null {
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

/**
 * Local date + time as "Jul 21, 2026 · 7:16 AM". `timeZone` is exposed so tests
 * can pin the output; production omits it and uses the device's local zone.
 */
export function formatStampTime(date: Date, timeZone?: string): string {
  const tz = timeZone ? { timeZone } : {};
  const day = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...tz,
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...tz,
  }).format(date);
  return `${day} · ${time}`;
}

/**
 * Compose the 1–3 overlay lines: optional label, timestamp, and coords (with
 * accuracy) when a fix is present. Pure so the wording/order is unit-tested.
 */
export function composeStampLines(meta: StampMeta, timeZone?: string): string[] {
  const lines: string[] = [];
  const label = meta.label?.trim();
  if (label) lines.push(label);
  lines.push(formatStampTime(meta.takenAt, timeZone));
  const coords = formatCoords(meta.lat, meta.lng);
  if (coords) {
    const acc =
      typeof meta.accuracyM === "number" && Number.isFinite(meta.accuracyM)
        ? `  ±${Math.round(meta.accuracyM)}m`
        : "";
    lines.push(`GPS ${coords}${acc}`);
  }
  return lines;
}

/** Shape capture metadata into the nullable fields the outbox/attachments carry. */
export function toPhotoMetaFields(meta: StampMeta): PhotoMetaFields {
  return {
    lat: typeof meta.lat === "number" && Number.isFinite(meta.lat) ? meta.lat : null,
    lng: typeof meta.lng === "number" && Number.isFinite(meta.lng) ? meta.lng : null,
    accuracyM:
      typeof meta.accuracyM === "number" && Number.isFinite(meta.accuracyM)
        ? meta.accuracyM
        : null,
    takenAt: meta.takenAt.toISOString(),
  };
}

/** Gather GPS (soft — never blocks) + a capture timestamp for a new photo. */
export async function capturePhotoMeta(
  label?: string | null,
  timeoutMs?: number,
): Promise<StampMeta> {
  const fix = await captureGeoSoft(timeoutMs);
  return {
    takenAt: new Date(),
    lat: fix.lat ?? null,
    lng: fix.lng ?? null,
    accuracyM: fix.accuracyM ?? null,
    label: label ?? null,
  };
}

export interface StampOptions {
  /** Longest edge of the output, downscaled to keep queued blobs small. */
  maxDimension?: number;
  /** JPEG quality 0–1. */
  quality?: number;
}

const DEFAULT_MAX_DIM = 2000;
const DEFAULT_QUALITY = 0.85;

async function loadBitmap(blob: Blob): Promise<{
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  close: () => void;
} | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(blob);
      return {
        width: bmp.width,
        height: bmp.height,
        draw: (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h),
        close: () => bmp.close(),
      };
    } catch {
      /* fall through to <img> path */
    }
  }
  if (typeof Image === "undefined" || typeof URL === "undefined") return null;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () =>
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
        draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
        close: () => URL.revokeObjectURL(url),
      });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Decode, downscale to `maxDimension`, optionally draw on top, and re-encode as
 * a JPEG. On any environment without a usable canvas (or on decode failure) the
 * ORIGINAL blob is returned unchanged so capture never breaks.
 *
 * The overlay is the ONLY difference between a stamped photo and a plain one.
 * Pulling it out to a callback is what lets an unstamped capture keep the half
 * that has nothing to do with stamping: a phone hands over a 12-megapixel file
 * in whatever container it likes, and every upload in this app has always
 * counted on that being shrunk and re-encoded before it goes anywhere. "No
 * watermark" must not quietly mean "no processing".
 */
async function renderToJpeg(
  blob: Blob,
  options: StampOptions,
  overlay?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): Promise<Blob> {
  if (typeof document === "undefined") return blob;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return blob;

  const bitmap = await loadBitmap(blob);
  if (!bitmap || !bitmap.width || !bitmap.height) return blob;

  try {
    const maxDim = options.maxDimension ?? DEFAULT_MAX_DIM;
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    canvas.width = w;
    canvas.height = h;
    bitmap.draw(ctx, w, h);

    overlay?.(ctx, w, h);

    const out = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", options.quality ?? DEFAULT_QUALITY);
    });
    return out ?? blob;
  } finally {
    bitmap.close();
  }
}

/**
 * Return a new JPEG Blob with the GPS/timestamp overlay burned into the bottom.
 * On any environment without a usable canvas (or on decode failure) the ORIGINAL
 * blob is returned unchanged so capture never breaks.
 */
export async function stampPhoto(
  blob: Blob,
  meta: StampMeta,
  options: StampOptions = {},
): Promise<Blob> {
  return renderToJpeg(blob, options, (ctx, w, h) => {
    const lines = composeStampLines(meta);
    const fontSize = Math.max(16, Math.round(w * 0.028));
    const pad = Math.round(fontSize * 0.6);
    const lineHeight = Math.round(fontSize * 1.35);
    const barHeight = pad * 2 + lineHeight * lines.length;

    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, h - barHeight, w, barHeight);

    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "top";
    ctx.font = `600 ${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 2;
    lines.forEach((line, i) => {
      ctx.fillText(line, pad, h - barHeight + pad + i * lineHeight);
    });
  });
}

/**
 * The same shrink and re-encode with NOTHING drawn on top — for a photo of a
 * piece of paper, where a GPS fix says nothing true and a full legal name is
 * already on the page.
 */
export async function shrinkPhoto(blob: Blob, options: StampOptions = {}): Promise<Blob> {
  return renderToJpeg(blob, options);
}

/** Stamp a File and return a new JPEG File (keeps a sensible .jpg name). */
export async function stampPhotoFile(
  file: File,
  meta: StampMeta,
  options?: StampOptions,
): Promise<File> {
  return asJpegFile(file, await stampPhoto(file, meta, options));
}

/** Shrink a File and return a new JPEG File, same naming as stampPhotoFile. */
export async function shrinkPhotoFile(file: File, options?: StampOptions): Promise<File> {
  return asJpegFile(file, await shrinkPhoto(file, options));
}

function asJpegFile(original: File, out: Blob): File {
  const base = original.name.replace(/\.[^./\\]+$/, "");
  return new File([out], `${base || "photo"}.jpg`, { type: "image/jpeg" });
}
