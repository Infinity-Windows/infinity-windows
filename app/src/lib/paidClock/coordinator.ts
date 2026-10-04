import type { ClockPunch } from "../clockPunch";
import { stillSignedInAs, type SignInMark } from "../signedIn";
import { ClockAccountChangedError, fetchOwnClockSafetyBasis } from "./api";
import { dispatchPaidClockRequest, type PaidClockDispatch } from "./dispatch";
import { readObservedClockTarget } from "./current";
import { isPaidClockTransportFailure } from "./readFailure";
import { parseClockIntent, type ClockIntent } from "./protocol";
import { appendPaidClockIntent, appendPendingPaidClockIntent, getPaidClockDeviceId, readPaidClockRecords } from "./storage";

export type PaidClockSubmission =
  | { kind: "saved"; clientId: string; dispatch: PaidClockDispatch }
  | { kind: "held"; clientId: string; reason: "account_changed" | "storage_unavailable" | "basis_unavailable" };
const current = (login: SignInMark): boolean => !!login.userId && stillSignedInAs(login, login.userId);
function requireCurrent(login: SignInMark): void { if (!current(login)) throw new ClockAccountChangedError(); }

/** The caller supplies the punch minted at the actual tap. No job selection,
 * geolocation wait, toolbox signature or retry may restamp this request. The
 * server still decides whether that original tap is trustworthy and applicable. */
export function paidSetupIntent(punch: ClockPunch, mode: "data" | "tracking" | null = null): ClockIntent {
  return parseClockIntent({ action: "clock_in", clientId: punch.clientId, tappedAt: punch.tappedAt,
    clockCheckedAt: punch.clockCheckedAt, clockSkewMs: punch.clockSkewMs, projectId: null, costCodeId: null,
    photo: null, lat: null, lng: null, note: null, mode, setupVersion: 1 });
}

/** Freeze the original before the first await, COMMIT its native chain, then
 * attempt delivery. Returns delivery evidence, never an optimistic TimeShift
 * or an old-outbox pending reference. An error may follow a committed save;
 * callers must read the owner's records rather than create a replacement tap. */
export async function submitPaidClockIntent(login: SignInMark, raw: ClockIntent,
  expectedHeadClientId: string | null): Promise<PaidClockSubmission> {
  const intent = parseClockIntent(raw);
  if (!current(login)) return { kind: "held", clientId: intent.clientId, reason: "account_changed" };
  let phase: "storage" | "basis" = "storage";
  try {
    const rows = await readPaidClockRecords(login); requireCurrent(login);
    const existing = rows.find(row => row.clientId === intent.clientId);
    const predecessor = rows.find(row => row.clientId === expectedHeadClientId);
    const deviceId = existing?.deviceId ?? predecessor?.deviceId ?? await getPaidClockDeviceId(login); requireCurrent(login);
    let basis, target;
    let pendingOnly = navigator.onLine === false;
    if (pendingOnly && intent.action === "clock_in" && !existing) {
      return { kind: "held", clientId: intent.clientId, reason: "basis_unavailable" };
    }
    // A repeated original can already have closed its shift. Native duplicate
    // validation is still exact; it must not require that shift to be open.
    if (!existing && intent.action !== "clock_in" && intent.shiftRef.kind === "shift" && expectedHeadClientId === null) {
      phase = "basis";
      if (!pendingOnly) {
        try { basis = await fetchOwnClockSafetyBasis(intent.shiftRef.id, login); requireCurrent(login); }
        catch (error) {
          requireCurrent(login);
          if (!isPaidClockTransportFailure(error)) throw error;
          pendingOnly = true;
        }
      }
      if (pendingOnly) {
        target = readObservedClockTarget(login, intent.shiftRef.id);
        if (!target) return { kind: "held", clientId: intent.clientId, reason: "basis_unavailable" };
      }
    }
    phase = "storage";
    // Recheck transport after awaited reads. A pending save must not call the
    // dispatcher at all, including check-only; reconnection is not a resend.
    pendingOnly ||= navigator.onLine === false;
    if (pendingOnly && intent.action !== "clock_in" && intent.shiftRef.kind === "shift") {
      target ??= readObservedClockTarget(login, intent.shiftRef.id);
    }
    const saved = pendingOnly ? await appendPendingPaidClockIntent(login, deviceId, intent, expectedHeadClientId, target) :
      await appendPaidClockIntent(login, deviceId, intent, expectedHeadClientId, basis);
    requireCurrent(login);
    if (pendingOnly) return { kind: "saved", clientId: saved.clientId, dispatch: { kind: "held", reason: "offline" } };
    // A competing tap may check the winning original, never resend it.
    const dispatch = await dispatchPaidClockRequest(saved.clientId, login,
      existing || saved.clientId !== intent.clientId ? "check_only" : "first_attempt"); requireCurrent(login);
    return { kind: "saved", clientId: saved.clientId, dispatch };
  } catch {
    return { kind: "held", clientId: intent.clientId, reason: !current(login) ? "account_changed" :
      phase === "basis" ? "basis_unavailable" : "storage_unavailable" };
  }
}

/** Checking a saved punch cannot transmit it. Resending is a separate explicit
 * human action, and sends the original UUID, timestamp and arguments only. */
export async function recoverPaidClockRequest(clientId: string, login: SignInMark,
  action: "check" | "retry_original"): Promise<PaidClockDispatch> {
  const result = await dispatchPaidClockRequest(clientId, login, action === "check" ? "check_only" : "retry_original");
  return current(login) ? result : { kind: "held", reason: "account_changed" };
}
