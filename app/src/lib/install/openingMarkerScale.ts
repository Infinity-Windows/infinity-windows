const STORAGE_KEY = "infinity:opening-marker-scales:v1";

function readScales(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function getOpeningMarkerScale(openingId: string): number {
  const value = Number(readScales()[openingId]);
  return Number.isFinite(value) ? Math.min(2, Math.max(0.6, value)) : 1;
}

export function setOpeningMarkerScale(openingId: string, scale: number): number {
  const next = Math.min(2, Math.max(0.6, Math.round(scale * 10) / 10));
  if (typeof window === "undefined") return next;
  const scales = readScales();
  scales[openingId] = next;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(scales));
  return next;
}

export function openingMarkerStyle(openingId: string): {
  width: number;
  height: number;
  marginLeft: number;
  marginTop: number;
  fontSize: number;
} {
  const scale = getOpeningMarkerScale(openingId);
  const size = 30 * scale;
  return {
    width: size,
    height: size,
    marginLeft: -size / 2,
    marginTop: -size / 2,
    fontSize: 12 * Math.min(scale, 1.5),
  };
}
