// A GPS fix kept warm while a capture screen is open, so the shutter never
// waits for one.
//
// WHY THIS EXISTS. Every photo used to ask for a high-accuracy fix AT THE
// SHUTTER and block up to eight seconds before the image was even compressed.
// High-accuracy GPS indoors — which is where windows get installed — routinely
// takes the whole eight seconds, and eight silent seconds after a tap reads as
// a broken app: people tap again, or back out, and the photo never gets taken.
// So the fix is asked for when the capture sheet OPENS, held here, and read
// instantly when the shutter fires. A multi-file pick stamps every file off the
// same held fix instead of waiting one out per file.
//
// The watch is ref-counted and stops with the last screen that wanted it, so
// the battery cost ends with the screen. There is no background location in
// this app and there must not be (CONTEXT.md, "Last seen").

import { useEffect } from "react";
import { captureGeoSoft, type GeoFix } from "./geo";

/**
 * How old a held fix may be and still be stamped onto a photo. The one-shot
 * lookup this replaces already accepted a 30-second-old cached fix
 * (`captureGeoSoft`'s `maximumAge`); a minute of standing at the same window is
 * still the same window.
 */
export const FIX_MAX_AGE_MS = 60_000;

/**
 * How long the shutter waits when nothing is held yet — three seconds, down
 * from eight. Past this the photo stamps time-only, which is exactly what it
 * has always done when GPS fails.
 */
export const SHUTTER_FIX_WAIT_MS = 3_000;

/** The slice of `navigator.geolocation` this module uses. */
export interface GeoWatchSource {
  watchPosition(
    onOk: PositionCallback,
    onErr?: PositionErrorCallback | null,
    options?: PositionOptions,
  ): number;
  clearWatch(id: number): void;
}

export interface FixHolder {
  /** Start (or join) the watch. Returns the stop for THIS caller only. */
  start(): () => void;
  /** The freshest fix we hold, or `{}` when there is none young enough. */
  peek(): GeoFix;
  /** {@link peek}, or wait up to `timeoutMs` for a first fix; `{}` on timeout. */
  waitFor(timeoutMs?: number): Promise<GeoFix>;
  /** Is a watch currently running? */
  watching(): boolean;
}

function toFix(pos: GeolocationPosition): GeoFix {
  return {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    accuracyM: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : undefined,
  };
}

function hasCoords(fix: GeoFix): boolean {
  return typeof fix.lat === "number" && typeof fix.lng === "number";
}

/**
 * Build a fix holder over an injected geolocation source, an injected one-shot
 * lookup (used when nobody warmed the watch up), and an injected clock — all
 * three so the staleness cutoff, the cold-start cap and the stop can be tested
 * without a real device.
 */
export function createFixHolder(
  getSource: () => GeoWatchSource | null,
  coldLookup: (timeoutMs: number) => Promise<GeoFix>,
  now: () => number = () => Date.now(),
): FixHolder {
  let held: { fix: GeoFix; at: number } | null = null;
  let source: GeoWatchSource | null = null;
  let watchId: number | null = null;
  let holders = 0;
  // Set only by a real PERMISSION_DENIED. A denied phone will never answer, so
  // making every shutter sit out its three seconds would be three seconds of
  // nothing, per photo, forever.
  let denied = false;
  let waiters: ((fix: GeoFix) => void)[] = [];

  const deliver = (fix: GeoFix) => {
    const pending = waiters;
    waiters = [];
    for (const w of pending) w(fix);
  };

  const start = (): (() => void) => {
    holders += 1;
    if (watchId == null) {
      source = getSource();
      if (source) {
        try {
          watchId = source.watchPosition(
            (pos) => {
              denied = false;
              held = { fix: toFix(pos), at: now() };
              deliver(held.fix);
            },
            (err) => {
              // A timeout or "position unavailable" is transient — the watch
              // keeps running and a shutter simply falls back to its own short
              // wait. Only an outright refusal is worth remembering.
              const code = err?.code;
              if (code === (err?.PERMISSION_DENIED ?? 1)) {
                denied = true;
                deliver({});
              }
            },
            { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
          );
        } catch {
          watchId = null;
          source = null;
        }
      }
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      holders = Math.max(0, holders - 1);
      if (holders > 0) return;
      if (watchId != null && source) {
        try {
          source.clearWatch(watchId);
        } catch {
          /* nothing left to stop */
        }
      }
      watchId = null;
      // The held fix survives the stop on purpose: reopening the sheet a few
      // seconds later is the same person at the same window, and peek()'s
      // staleness cutoff is the only thing allowed to judge that.
    };
  };

  const peek = (): GeoFix => {
    if (!held) return {};
    if (now() - held.at > FIX_MAX_AGE_MS) return {};
    return held.fix;
  };

  const waitFor = (timeoutMs: number = SHUTTER_FIX_WAIT_MS): Promise<GeoFix> => {
    const warm = peek();
    if (hasCoords(warm)) return Promise.resolve(warm);
    if (denied) return Promise.resolve({});
    // Nobody warmed this up — a caller that never mounted a capture sheet.
    // Fall back to the one-shot lookup, capped at the same short wait.
    if (watchId == null) return coldLookup(timeoutMs);
    // A fix we HELD and that has since aged out is a different situation from
    // never having had one, and it must not be treated as the same. This
    // device's receiver is warm and the platform is almost certainly sitting on
    // a position younger than captureGeoSoft's 30-second maximumAge that
    // watchPosition has simply not re-delivered — a phone standing still at a
    // window, or in a pocket between windows, can go quiet on the watch for
    // minutes. Waiting only on the watch would spend the full three seconds and
    // then burn a time-only stamp, throwing away coordinates the device would
    // have handed over instantly. So knock on the one-shot door as well and
    // take whichever answers first with coordinates.
    //
    // Only when nothing was ever held is the watch alone right: there is no
    // cached position to find, and a second high-accuracy request would cost
    // battery to learn what the watch is already asking.
    const wentStale = held != null;
    return new Promise<GeoFix>((resolve) => {
      let settled = false;
      const done = (fix: GeoFix) => {
        if (settled) return;
        settled = true;
        resolve(fix);
      };
      const timer = setTimeout(() => done({}), timeoutMs);
      waiters.push((fix) => {
        clearTimeout(timer);
        done(fix);
      });
      if (wentStale) {
        void coldLookup(timeoutMs).then((fix) => {
          // Only coordinates end the wait early. A one-shot that times out or
          // comes back empty leaves the watch its full three seconds.
          if (!hasCoords(fix)) return;
          held = { fix, at: now() };
          deliver(fix);
        });
      }
    });
  };

  return { start, peek, waitFor, watching: () => watchId != null };
}

/** The app's one warm fix, shared by every capture surface on screen. */
export const warmGeoFix = createFixHolder(
  () =>
    typeof navigator !== "undefined" && navigator.geolocation
      ? navigator.geolocation
      : null,
  (timeoutMs) => captureGeoSoft(timeoutMs),
);

/**
 * Keep a fix warm for as long as this component is mounted. Called by every
 * capture surface that stamps — and by none that doesn't, because a photo of a
 * piece of paper should not cost a location lookup (see PhotoCaptureSheet's
 * `stamp` prop).
 */
export function useWarmGeoFix(active: boolean = true): void {
  useEffect(() => {
    if (!active) return;
    return warmGeoFix.start();
  }, [active]);
}
