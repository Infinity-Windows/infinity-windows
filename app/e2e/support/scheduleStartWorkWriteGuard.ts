// Only the existing on-clock foreground stamp is admitted in the open-shift
// scenario. It is a mutation, never a read-only RPC. No GPS/shift/project data
// or extra fields are permitted; all other attempted writes remain refused.
export type ForegroundTouchPayload = { p_lat: null; p_lng: null; p_accuracy_m: null };
export function expectedForegroundTouch(openShiftScenario: boolean, body: unknown): body is ForegroundTouchPayload {
  if (!openShiftScenario || typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return Object.keys(b).sort().join(",") === "p_accuracy_m,p_lat,p_lng" &&
    b.p_lat === null && b.p_lng === null && b.p_accuracy_m === null;
}
