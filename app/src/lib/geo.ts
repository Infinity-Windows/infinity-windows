/**
 * Best-effort GPS for clock punches. It never throws and never blocks a punch:
 * on denial, timeout, insecure context, or missing API it resolves to {} so the
 * caller can clock in/out without coordinates. Mirrors Horizon's soft-fail rule.
 */
export interface GeoFix {
  lat?: number;
  lng?: number;
  /** Reported horizontal accuracy in meters, when available. */
  accuracyM?: number;
}

export async function captureGeoSoft(timeoutMs = 12_000): Promise<GeoFix> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return {};
  return new Promise<GeoFix>((resolve) => {
    let settled = false;
    const done = (fix: GeoFix) => {
      if (settled) return;
      settled = true;
      resolve(fix);
    };
    // Hard backstop in case the platform never fires success or error.
    const timer = setTimeout(() => done({}), timeoutMs + 500);
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timer);
          done({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracyM: Number.isFinite(pos.coords.accuracy)
              ? pos.coords.accuracy
              : undefined,
          });
        },
        () => {
          clearTimeout(timer);
          done({});
        },
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
      );
    } catch {
      clearTimeout(timer);
      done({});
    }
  });
}
