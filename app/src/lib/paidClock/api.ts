import { clientWithToken, supabase } from "../supabase";
import { stillSignedInAs, type SignInMark } from "../signedIn";
import { uuid } from "../workConfiguration/model";
import { isMissingFunction } from "../schemaErrors";
import { clockSqlCall, parseClockIntent, parseClockReceiptRead, type ClockIntent } from "./protocol";
import { trackPaidClockOperation } from "./reloadGuard";
import { isPaidClockTransportFailure } from "./readFailure";

export class ClockAccountChangedError extends Error {
  constructor() { super("Sign back into the account that saved this clock request."); }
}
export class ClockRequestRefusedError extends Error {
  readonly code: string;
  constructor(code: string) { super("The clock request was refused. Review it before another attempt."); this.code = code; }
}
export interface ConfirmedClockSafetyBasis {
  readonly ownerId: string;
  readonly shiftId: string;
  readonly loginGeneration: number;
}
const safetyReads = new WeakSet<object>();
export function isCurrentClockSafetyBasis(value: unknown, ownerId: string, shiftId: string, login: SignInMark): value is ConfirmedClockSafetyBasis {
  if (!value || typeof value !== "object" || !safetyReads.has(value)) return false;
  const basis = value as ConfirmedClockSafetyBasis;
  return basis.ownerId === ownerId && basis.shiftId === shiftId && basis.loginGeneration === login.generation && stillSignedInAs(login, ownerId);
}
function current(login: SignInMark): string {
  if (!login.userId || !stillSignedInAs(login, login.userId)) throw new ClockAccountChangedError();
  return login.userId;
}
export async function ownPaidClockClient(login: SignInMark) {
  const owner = current(login);
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token || data.session.user.id !== owner || current(login) !== owner) throw new ClockAccountChangedError();
  return clientWithToken(data.session.access_token);
}

/** A new independent safety chain needs an explicit fresh self-owned shift read.
 * The branded value is runtime-only; it is never a credential or stored proof.
 * The keyed payroll RPC remains the authority when another action intervenes. */
export async function fetchOwnClockSafetyBasis(shiftId: string, login: SignInMark): Promise<ConfirmedClockSafetyBasis> {
  uuid(shiftId);
  const ownerId = current(login);
  try {
  const client = await ownPaidClockClient(login);
  current(login);
  const { data, error } = await client.from("time_shifts").select("id,profile_id,status,clock_out_at")
    .eq("id", shiftId).eq("profile_id", ownerId).maybeSingle();
  current(login);
  if (error) throw error;
  if (!data || data.id !== shiftId || data.profile_id !== ownerId || data.status !== "open" || data.clock_out_at !== null) {
    throw new Error("A current paid shift is unavailable. Refresh before this safety action.");
  }
  const basis = Object.freeze({ ownerId, shiftId, loginGeneration: login.generation });
  safetyReads.add(basis);
  return basis;
  } catch (error) {
    if (!isPaidClockTransportFailure(error)) (await import("./current")).invalidateObservedClockTarget(login, shiftId);
    throw error;
  }
}

/** Ignore the mutable shift replay result. Only a matching immutable read can acknowledge delivery. */
export async function sendPaidClockIntent(raw: ClockIntent, login: SignInMark, resolvedShiftId?: string): Promise<void> {
  return trackPaidClockOperation(() => sendOriginal(raw, login, resolvedShiftId));
}
async function sendOriginal(raw: ClockIntent, login: SignInMark, resolvedShiftId?: string): Promise<void> {
  const intent = parseClockIntent(raw), call = clockSqlCall(intent, resolvedShiftId);
  const client = await ownPaidClockClient(login);
  current(login);
  const { error } = await client.rpc(call.rpc, call.args);
  current(login);
  if (error) {
    if (error.code === "42501") (await import("./current")).invalidateObservedClockTarget(login);
    // These replies explicitly report a SQL/PostgREST refusal. A prior unknown
    // attempt remains uncertain even when a later attempt receives this reply.
    if (isMissingFunction(error) || ["42501", "23514", "22023", "22P02"].includes(error.code ?? "")) throw new ClockRequestRefusedError(error.code ?? "missing_function");
    throw error;
  }
}
export async function readPaidClockReceipt(raw: ClockIntent, login: SignInMark, resolvedShiftId?: string) {
  return trackPaidClockOperation(() => readOriginal(raw, login, resolvedShiftId));
}
async function readOriginal(raw: ClockIntent, login: SignInMark, resolvedShiftId?: string) {
  const intent = parseClockIntent(raw), client = await ownPaidClockClient(login);
  current(login);
  const { data, error } = await client.rpc("work_activity_clock_receipt", { p_client_id: intent.clientId });
  current(login);
  if (error) {
    if (error.code === "42501") (await import("./current")).invalidateObservedClockTarget(login);
    throw error;
  }
  const receiptRead = parseClockReceiptRead(data, intent, resolvedShiftId);
  if (receiptRead.availability === "available" && !receiptRead.receipt.sourcePresent) {
    (await import("./current")).invalidateObservedClockTarget(login, receiptRead.receipt.shiftId);
  }
  return receiptRead;
}
