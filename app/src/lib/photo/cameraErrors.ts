// Which getUserMedia failures mean "there is no live camera here, and asking
// again will not change that".
//
// THE INCIDENT: the photo sheet swapped its live-preview shutter for a hand-off
// to the phone's own camera app on ANY getUserMedia rejection, and never swapped
// back for the life of the sheet. That is right for a refused permission — the
// browser remembers the answer, so a second ask pops nothing — and wrong for the
// everyday transient one. On Android, another app holding the lens (the OS
// camera left open, a video call in the background) rejects with
// NotReadableError; the installer closes that app, taps "Use camera" again, and
// the live preview they were promised is gone until they close and reopen the
// sheet.

/** Rejection names that mean the live camera is unreachable for good. */
const PERMANENT = new Set([
  // The person said no. Chrome and Safari both remember it for the origin.
  "NotAllowedError",
  // Old Chrome / old Android WebView spelling of the same answer.
  "PermissionDeniedError",
  // Insecure origin, or a permissions policy that forbids the camera. Neither
  // changes because somebody tapped again.
  "SecurityError",
  // This device has no camera at all — a desktop with no webcam. The file
  // input's `capture` hint degrades to an ordinary picker there, which is
  // exactly the right thing to offer.
  "NotFoundError",
  "DevicesNotFoundError",
]);

/**
 * Is this getUserMedia rejection permanent — should the sheet fall back to the
 * OS camera app for good — or worth another tap?
 *
 * Matched by `name`, not `instanceof DOMException`: in-app WebViews and older
 * Safari reject with a plain object carrying the same names, and anything whose
 * shape we do not recognise has to count as retryable. Leaving a working
 * shutter one tap away costs nothing; taking it away wrongly costs the preview.
 */
export function isPermanentCameraFailure(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const name = (e as { name?: unknown }).name;
  return typeof name === "string" && PERMANENT.has(name);
}
