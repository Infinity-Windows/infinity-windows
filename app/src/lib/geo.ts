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

/**
 * A fix we actually have: coordinates present, not merely optional. Structurally
 * the same shape as jobProximity's DeviceFix, so a granted fix can be handed
 * straight to `farFromJob()` without a cast.
 */
export interface GrantedFix {
  lat: number;
  lng: number;
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

/**
 * A fix, but ONLY if this device has already granted location — never a
 * prompt of its own.
 *
 * The difference from {@link captureGeoSoft} matters: that one is called from a
 * tap the person just made (clocking in), where an OS prompt is expected and
 * fair. This one is called by advisory features that run on their own — the
 * "not near this job" note at clock-in, and the far-from-job question when the
 * app comes to the foreground (Wave K, K1). A background feature that summons a
 * permission dialog out of nowhere is how an app teaches people to tap Deny.
 *
 * Returns null when permission is not already granted, when the Permissions API
 * is missing, or when no fix came back. Never throws.
 */
export async function captureGeoIfGranted(): Promise<GrantedFix | null> {
  try {
    const perms = (navigator as Navigator & { permissions?: Permissions })
      .permissions;
    if (!perms?.query) return null;
    const status = await perms.query({ name: "geolocation" as PermissionName });
    if (status.state !== "granted") return null;
    const fix = await captureGeoSoft();
    if (fix.lat == null || fix.lng == null) return null;
    return { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM };
  } catch {
    return null;
  }
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
