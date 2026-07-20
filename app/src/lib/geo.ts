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

/** Outcome of a one-shot geolocation priming call. */
export type GeoPrimeResult = "granted" | "denied" | "unavailable";

/**
 * Prime the geolocation permission with a single position request. Unlike
 * {@link captureGeoSoft} (which is fire-and-forget mid-punch and only cares
 * about coordinates), this exists so the onboarding wizard can trigger the real
 * OS prompt *after* the user opts in, and learn whether they allowed it,
 * blocked it, or the fix was simply unavailable. It never throws.
 *
 * PERMISSION_DENIED (code 1) is the only hard "denied"; a timeout or
 * position-unavailable is reported as "unavailable" so we can ask again later.
 */
export async function primeGeolocation(
  timeoutMs = 12_000,
): Promise<GeoPrimeResult> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return "unavailable";
  }
  return new Promise<GeoPrimeResult>((resolve) => {
    let settled = false;
    const done = (r: GeoPrimeResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timer = setTimeout(() => done("unavailable"), timeoutMs + 500);
    try {
      navigator.geolocation.getCurrentPosition(
        () => {
          clearTimeout(timer);
          done("granted");
        },
        (err) => {
          clearTimeout(timer);
          done(err && err.code === err.PERMISSION_DENIED ? "denied" : "unavailable");
        },
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
      );
    } catch {
      clearTimeout(timer);
      done("unavailable");
    }
  });
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
