import { stillSignedInAs, subscribeSignedIn, type SignInMark } from "../signedIn";
import { ClockPreDispatchVetoError, ClockRequestRefusedError, readPaidClockReceipt, sendPaidClockIntent } from "./api";
import { ClockProtocolError, type ClockReceipt } from "./protocol";
import { readPaidClockRecords, updatePaidClockDelivery, type PaidClockRecord } from "./storage";
import { postgresInstantMicros } from "../workConfiguration/model";
import { fetchPaidClockCapability } from "./capability";
import { fetchOwnPaidClockCurrent, readLastObservedPaidClock } from "./current";

export type PaidClockDispatch = { kind: "settled"; record: PaidClockRecord }
  | { kind: "held"; reason: "account_changed" | "offline" | "dispatcher_busy" | "locks_unavailable" | "dependency" | "unknown" | "attention" | "storage" };
export type PaidClockPolicy = "first_attempt" | "check_only" | "retry_original";
const current = (login: SignInMark) => !!login.userId && stillSignedInAs(login, login.userId);
// Negative evidence from THIS login/invocation only. A crashed durable sending
// row alone never proves no dispatch. Keep this fence if its native repair fails.
const noSendFences = new Set<string>();
subscribeSignedIn(() => noSendFences.clear());
const fenceKey = (login: SignInMark, id: string, token: string) => `${login.userId}:${login.generation}:${id}:${token}`;
function noSendShape(row: PaidClockRecord): boolean {
  return row.intent.action === "clock_in" && row.delivery.everAttempted && !row.delivery.everUncertain &&
    row.delivery.attemptToken !== null && row.delivery.receipt === null && row.delivery.resolvedShiftId === null;
}
function knownFirstDeliveryHeld(row: PaidClockRecord, login: SignInMark): boolean {
  if (!noSendShape(row)) return false;
  return row.delivery.status === "attention" && row.delivery.attentionReason === "first_delivery_held" ||
    row.delivery.status === "sending" && row.delivery.attentionReason === null &&
      noSendFences.has(fenceKey(login, row.clientId, row.delivery.attemptToken!));
}
async function retainFirstDeliveryHold(login: SignInMark, clientId: string, token: string): Promise<void> {
  const key = fenceKey(login, clientId, token);
  if (!current(login)) return;
  noSendFences.add(key);
  try {
    const rows = await readPaidClockRecords(login);
    if (!current(login)) return;
    const row = rows.find(value => value.clientId === clientId);
    if (!row || row.delivery.attemptToken !== token || !noSendShape(row) || row.delivery.status !== "sending") {
      noSendFences.delete(key); return;
    }
    await updatePaidClockDelivery(login, clientId, token, old => {
      if (!noSendShape(old) || old.delivery.status !== "sending") throw new ClockProtocolError();
      return { ...old.delivery, status: "attention", attentionReason: "first_delivery_held" };
    });
    noSendFences.delete(key);
  } catch { /* Durable repair is unconfirmed; this live login retains its fence. */ }
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Clock reply unavailable")), 10_000);
  })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function settle(row: PaidClockRecord, receipt: ClockReceipt, login: SignInMark): Promise<PaidClockRecord> {
  if (row.delivery.receipt && !sameReceiptEvidence(row.delivery.receipt, receipt)) throw new ClockProtocolError();
  const attention = receipt.outcome === "requires_review" ? "requires_review" : !receipt.sourcePresent ? "source_removed" : null;
  return updatePaidClockDelivery(login, row.clientId, row.delivery.attemptToken, old => ({ ...old.delivery,
    status: attention ? "attention" : "acknowledged", everAttempted: true,
    receipt: old.delivery.receipt ?? receipt, resolvedShiftId: receipt.shiftId, attentionReason: attention }));
}
function sameReceiptEvidence(a: ClockReceipt, b: ClockReceipt): boolean {
  const evidence = (r: ClockReceipt) => ({ ...r, sourcePresent: undefined,
    tappedAt: r.tappedAt === null ? null : postgresInstantMicros(r.tappedAt).toString(),
    arrivedAt: postgresInstantMicros(r.arrivedAt).toString(),
    clockCheckedAt: r.clockCheckedAt === null ? null : postgresInstantMicros(r.clockCheckedAt).toString() });
  return JSON.stringify(evidence(a)) === JSON.stringify(evidence(b));
}

/** Original request only. Neither a mutable shift reply nor an unavailable
 * receipt is evidence that a punch completed or failed. Separate origins can
 * dispatch independently; unknown ancestors are never resent as a side effect. */
export async function dispatchPaidClockRequest(clientId: string, login: SignInMark, policy: PaidClockPolicy): Promise<PaidClockDispatch> {
  if (!current(login)) return { kind: "held", reason: "account_changed" };
  if (navigator.onLine === false) return { kind: "held", reason: "offline" };
  if (!navigator.locks) return { kind: "held", reason: "locks_unavailable" };
  try {
    return await navigator.locks.request(`forge:paid-clock-dispatch:${login.userId}`, { ifAvailable: true }, async lock => {
      if (!lock) return { kind: "held", reason: "dispatcher_busy" } as const;
      if (!current(login)) return { kind: "held", reason: "account_changed" } as const;
      const rows = await readPaidClockRecords(login);
      if (!current(login)) return { kind: "held", reason: "account_changed" } as const;
      let row = rows.find(record => record.clientId === clientId);
      if (!row) return { kind: "held", reason: "storage" } as const;
      if (row.delivery.status === "acknowledged") return { kind: "settled", record: row } as const;
      const freshReceipts = new Map<string, ClockReceipt>();
      const freshDependency = async (dependency: PaidClockRecord) => {
        const cached = freshReceipts.get(dependency.clientId);
        if (cached) return cached;
        const read = await bounded(readPaidClockReceipt(dependency.intent, login, dependency.delivery.resolvedShiftId ?? undefined));
        if (!current(login) || read.availability !== "available" || !dependency.delivery.receipt ||
          !sameReceiptEvidence(dependency.delivery.receipt, read.receipt)) return null;
        freshReceipts.set(dependency.clientId, read.receipt); return read.receipt;
      };
      const removedSource = async () => {
        if (!row!.delivery.everAttempted) await updatePaidClockDelivery(login, row!.clientId, row!.delivery.attemptToken,
          old => ({ ...old.delivery, status: "attention", attentionReason: "source_removed" }));
        return { kind: "held", reason: "attention" } as const;
      };
      let resolved = row.intent.action === "clock_in" ? undefined : row.intent.shiftRef.kind === "shift" ? row.intent.shiftRef.id : undefined;
      if (row.predecessorClientId) {
        const predecessor = rows.find(record => record.clientId === row!.predecessorClientId);
        if (!predecessor || predecessor.storageGeneration !== row.storageGeneration || predecessor.sequence + 1 !== row.sequence ||
          predecessor.origin.kind !== row.origin.kind || predecessor.origin.id !== row.origin.id ||
          predecessor.delivery.status !== "acknowledged" || !predecessor.delivery.receipt ||
          !predecessor.delivery.receipt.sourcePresent || predecessor.delivery.receipt.outcome === "requires_review") {
          return { kind: "held", reason: "dependency" } as const;
        }
        if (row.intent.action === "break_end" && (predecessor.intent.action !== "break_start" ||
          !["started", "already_on_break"].includes(predecessor.delivery.receipt.outcome))) return { kind: "held", reason: "dependency" } as const;
        let fresh: ClockReceipt | null;
        try { fresh = await freshDependency(predecessor); }
        catch { return { kind: "held", reason: current(login) ? "dependency" : "account_changed" } as const; }
        if (!current(login)) return { kind: "held", reason: "account_changed" } as const;
        if (!fresh) return { kind: "held", reason: "dependency" } as const;
        if (!fresh.sourcePresent) return removedSource();
      }
      if (row.intent.action !== "clock_in" && row.intent.shiftRef.kind === "clock_command") {
        const clock = rows.find(record => record.clientId === row!.origin.id);
        if (!clock || clock.intent.action !== "clock_in" || clock.delivery.status !== "acknowledged" || !clock.delivery.receipt) return { kind: "held", reason: "dependency" } as const;
        let fresh: ClockReceipt | null;
        try { fresh = await freshDependency(clock); }
        catch { return { kind: "held", reason: current(login) ? "dependency" : "account_changed" } as const; }
        if (!current(login)) return { kind: "held", reason: "account_changed" } as const;
        if (!fresh) return { kind: "held", reason: "dependency" } as const;
        if (!fresh.sourcePresent) return removedSource();
        resolved = fresh.shiftId;
      }
      const attempted = row.delivery.everAttempted || row.delivery.status === "sending" || row.delivery.status === "uncertain";
      const knownHeld = knownFirstDeliveryHeld(row, login);
      const possiblePriorSend = attempted && !knownHeld;
      const firstStart = row.intent.action === "clock_in" && (!attempted || knownHeld);
      if (attempted || row.delivery.status === "attention" || policy === "check_only" || firstStart) {
        try {
          const read = await bounded(readPaidClockReceipt(row.intent, login, resolved));
          if (!current(login)) return { kind: "held", reason: "account_changed" } as const;
          if (read.availability === "available") return { kind: "settled", record: await settle(row, read.receipt, login) } as const;
        } catch (error) {
          if (!current(login)) return { kind: "held", reason: "account_changed" } as const;
          // An invalid/foreign acknowledgement must not erase prior uncertainty.
          if (error instanceof ClockProtocolError && !row.delivery.everAttempted) {
            await updatePaidClockDelivery(login, row.clientId, row.delivery.attemptToken,
              old => ({ ...old.delivery, status: "attention", attentionReason: "receipt_conflict" }));
            return { kind: "held", reason: "attention" } as const;
          }
          return { kind: "held", reason: "unknown" } as const;
        }
        if (knownHeld && policy !== "retry_original") return { kind: "held", reason: "attention" } as const;
        if (row.delivery.status === "attention" && !knownHeld) return { kind: "held", reason: "attention" } as const;
        if (policy === "check_only" || possiblePriorSend && policy !== "retry_original") {
          if (attempted && row.delivery.status !== "uncertain") await updatePaidClockDelivery(login, row.clientId, row.delivery.attemptToken,
            old => ({ ...old.delivery, status: "uncertain", everUncertain: true }));
          return { kind: "held", reason: "unknown" } as const;
        }
      }
      // A queued start is only a saved intention. Even an explicit retry after
      // reload needs fresh first-delivery admission UNDER this owner's lock.
      // First check its own immutable receipt above: a current open shift may
      // be this original's already-applied result, never a reason to replace it.
      // Unknown attempted originals retain their separate exact-retry contract.
      let admission = () => true;
      if (firstStart) {
        try {
          const capability = await bounded(fetchPaidClockCapability(login));
          if (!current(login)) return { kind: "held", reason: "account_changed" } as const;
          if (!capability.canAuthorSetup || !capability.canDispatchExistingSetup ||
            !capability.canReadOwnReceipts || !capability.canDispatchPayrollSafety) return { kind: "held", reason: "dependency" } as const;
          const observed = await bounded(fetchOwnPaidClockCurrent(login));
          if (!current(login)) return { kind: "held", reason: "account_changed" } as const;
          if (observed.kind !== "off") return { kind: "held", reason: "dependency" } as const;
          admission = () => current(login) && readLastObservedPaidClock(login) === observed;
        } catch {
          return { kind: "held", reason: current(login) ? "dependency" : "account_changed" } as const;
        }
      }
      if (navigator.onLine === false) return { kind: "held", reason: "offline" } as const;
      if (!admission()) return { kind: "held", reason: current(login) ? "dependency" : "account_changed" } as const;
      const token = crypto.randomUUID();
      try {
        row = await updatePaidClockDelivery(login, row.clientId, row.delivery.attemptToken, old => ({ ...old.delivery,
          status: "sending", attemptToken: token, everAttempted: true, everUncertain: old.delivery.everUncertain || possiblePriorSend,
          resolvedShiftId: resolved ?? null, attentionReason: null }), admission);
      } catch {
        // Native completion may precede the helper's final admission exception.
        // Re-read THIS token; never reset an earlier/foreign attempt or receipt.
        if (firstStart) await retainFirstDeliveryHold(login, clientId, token);
        return { kind: "held", reason: current(login) ? "storage" : "account_changed" } as const;
      }
      if (!current(login)) return { kind: "held", reason: "account_changed" } as const;
      if (!admission()) {
        if (firstStart) await retainFirstDeliveryHold(login, clientId, token);
        return { kind: "held", reason: "dependency" } as const;
      }
      let refusal = false;
      try { await bounded(sendPaidClockIntent(row.intent, login, resolved, admission)); }
      catch (error) {
        if (firstStart && error instanceof ClockPreDispatchVetoError) {
          await retainFirstDeliveryHold(login, clientId, token);
          return { kind: "held", reason: current(login) ? "dependency" : "account_changed" } as const;
        }
        refusal = error instanceof ClockRequestRefusedError;
      }
      if (!current(login)) return { kind: "held", reason: "account_changed" } as const;
      try {
        const read = await bounded(readPaidClockReceipt(row.intent, login, resolved));
        if (!current(login)) return { kind: "held", reason: "account_changed" } as const;
        if (read.availability === "available") return { kind: "settled", record: await settle(row, read.receipt, login) } as const;
      } catch { /* keep original durable request; an unreadable reply is not a receipt */ }
      if (!current(login)) return { kind: "held", reason: "account_changed" } as const;
      const definite = refusal && !row.delivery.everUncertain;
      await updatePaidClockDelivery(login, row.clientId, token, old => ({ ...old.delivery,
        status: definite ? "attention" : "uncertain", everUncertain: old.delivery.everUncertain || !definite,
        attentionReason: definite ? "request_refused" : null }));
      return { kind: "held", reason: definite ? "attention" : "unknown" } as const;
    });
  } catch { return { kind: "held", reason: current(login) ? "storage" : "account_changed" }; }
}
