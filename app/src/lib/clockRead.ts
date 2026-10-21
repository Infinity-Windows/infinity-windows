import type { QueryClient } from "@tanstack/react-query";
import { signInMark, stillSignedInAs, type SignInMark } from "./signedIn";
import { getOpenShift, type TimeShift } from "./timeclock";
import { CLOCK_READ_TIMEOUT_MS, CLOCK_READ_MAX_AGE_MS, clockReadFingerprint } from "./clockReadState";

interface ReadSnapshot {
  checking: boolean;
  failed: boolean;
  /** An own punch was acknowledged without matching local evidence. */
  invalidated: boolean;
  checkedAt: number;
  fingerprint: string;
  mark: SignInMark | null;
}

/** Deliberately outside the persisted query cache: hydration cannot verify a clock. */
export function createClockRead(profileId: string, read = getOpenShift) {
  let snapshot: ReadSnapshot = { checking: false, failed: false, invalidated: false, checkedAt: 0, fingerprint: "unknown", mark: null };
  // ClockSheet clears the cache after queuing a clock-out. Keep the row that
  // the person actually saw long enough to match that punch, without making
  // an arbitrary queued clock-out evidence of being off the clock.
  let queueBase: { shift: TimeShift; mark: SignInMark } | null = null;
  let localIntent: { queueKey: string; entryIds: readonly string[]; targets: Record<string, string>; fingerprint: string; mark: SignInMark } | null = null;
  let acknowledged: { fingerprint: string; mark: SignInMark; at: number } | null = null;
  const firstSeen = new Map<string, { mark: SignInMark; readRevision: number }>();
  let readRevision = 0;
  let lastReadShift: TimeShift | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (next: ReadSnapshot) => { snapshot = next; for (const cb of listeners) cb(); };
  return {
    snapshot: () => snapshot,
    subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    rememberQueueBase(shift: TimeShift | null | undefined) {
      const mark = signInMark();
      if (shift?.profile_id === profileId && stillSignedInAs(mark, profileId)) queueBase = { shift, mark };
    },
    queueBase() {
      return queueBase && stillSignedInAs(queueBase.mark, profileId) ? queueBase.shift : null;
    },
    rememberLocalIntent(queueKey: string, shift: TimeShift | null, entryIds: readonly string[], targets: Record<string, string> = {}) {
      const mark = signInMark();
      if (stillSignedInAs(mark, profileId)) {
        // A surviving queue may be replayed after signing in again, but an
        // ACK from its old in-flight send must not acquire that new identity.
        for (const id of entryIds) if (!firstSeen.has(id)) firstSeen.set(id, { mark, readRevision });
        localIntent = { queueKey, entryIds, targets, fingerprint: clockReadFingerprint(shift), mark };
      }
    },
    hasLocalIntent(queueKey: string, shift: TimeShift | null) {
      return Boolean(localIntent && stillSignedInAs(localIntent.mark, profileId) &&
        localIntent.queueKey === queueKey && localIntent.fingerprint === clockReadFingerprint(shift));
    },
    localIntentEntryIds(queueKey: string, shift: TimeShift | null): string[] {
      return localIntent && stillSignedInAs(localIntent.mark, profileId) && localIntent.queueKey === queueKey &&
        localIntent.fingerprint === clockReadFingerprint(shift) ? [...localIntent.entryIds] : [];
    },
    localIntentTargets(queueKey: string, shift: TimeShift | null): Record<string, string> {
      return localIntent && stillSignedInAs(localIntent.mark, profileId) && localIntent.queueKey === queueKey &&
        localIntent.fingerprint === clockReadFingerprint(shift) ? localIntent.targets : {};
    },
    /** A sent punch is a receipt for local intent, never a new server read. */
    acknowledge(entry: { id: string; ownerId?: string | null; op?: string; payload?: Record<string, unknown> }, shift: TimeShift | null): boolean {
      const seen = firstSeen.get(entry.id);
      if (entry.ownerId !== profileId || !localIntent?.entryIds.includes(entry.id) ||
          !seen || !stillSignedInAs(seen.mark, profileId) ||
          !stillSignedInAs(localIntent.mark, profileId) || (shift && shift.profile_id !== profileId)) return false;
      // A subsequent read of a different running shift takes precedence over
      // this earlier queued punch's ACK. Re-read instead of replacing it.
      const closesReadShift = shift === null && entry.op === "clock_out" && lastReadShift &&
        (entry.payload?.shiftRef === lastReadShift.id || localIntent.targets[entry.id] === lastReadShift.id);
      if (readRevision > seen.readRevision && lastReadShift && lastReadShift.id !== shift?.id && !closesReadShift) return false;
      acknowledged = { fingerprint: clockReadFingerprint(shift), mark: localIntent.mark, at: Date.now() };
      // A read begun before this punch landed must not subsequently replace
      // its result (especially with the previous empty answer).
      generation++;
      publish({ checking: false, failed: false, invalidated: false, checkedAt: 0, fingerprint: "unknown", mark: null });
      return true;
    },
    invalidateReadProof() {
      generation++;
      acknowledged = null;
      publish({ checking: false, failed: true, invalidated: true, checkedAt: 0, fingerprint: "unknown", mark: null });
    },
    hasAcknowledgedIntent(shift: TimeShift | null | undefined, now: number): boolean {
      return Boolean(acknowledged && stillSignedInAs(acknowledged.mark, profileId) &&
        acknowledged.fingerprint === clockReadFingerprint(shift) && now >= acknowledged.at &&
        now - acknowledged.at < CLOCK_READ_MAX_AGE_MS);
    },
    // Used by controlled fixtures. Production query verification comes from
    // load(); queued-punch callbacks must use acknowledge() instead.
    confirm(shift: TimeShift | null) {
      const mark = signInMark();
      if (!stillSignedInAs(mark, profileId) || (shift && shift.profile_id !== profileId)) return;
      generation++;
      readRevision++;
      lastReadShift = shift;
      publish({ checking: false, failed: false, invalidated: false, checkedAt: Date.now(), fingerprint: clockReadFingerprint(shift), mark });
    },
    async load(signal?: AbortSignal): Promise<TimeShift | null> {
      const mark = signInMark();
      if (!stillSignedInAs(mark, profileId)) throw new Error("Clock sign-in changed");
      const attempt = ++generation;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectWait: (error: Error) => void = () => {};
      const stopped = new Promise<never>((_resolve, reject) => { rejectWait = reject; });
      const abort = () => { controller.abort(); rejectWait(new DOMException("Clock read cancelled", "AbortError")); };
      if (signal?.aborted) throw new DOMException("Clock read cancelled", "AbortError");
      signal?.addEventListener("abort", abort, { once: true });
      publish({ ...snapshot, checking: true });
      timer = setTimeout(() => {
        controller.abort();
        rejectWait(new Error("Clock read timed out"));
      }, CLOCK_READ_TIMEOUT_MS);
      try {
        // This deadline includes SDK authentication BEFORE fetch, where the
        // normal network timeout cannot see a stalled request.
        const shift = await Promise.race([read(profileId, controller.signal), stopped]);
        if (attempt !== generation || controller.signal.aborted || !stillSignedInAs(mark, profileId)) {
          throw new DOMException("Clock read cancelled", "AbortError");
        }
        if (shift && shift.profile_id !== profileId) throw new Error("Clock belongs to a different sign-in");
        readRevision++;
        lastReadShift = shift;
        publish({ checking: false, failed: false, invalidated: false, checkedAt: Date.now(), fingerprint: clockReadFingerprint(shift), mark });
        return shift;
      } catch (error) {
        if (attempt === generation) publish({ ...snapshot, checking: false, failed: true });
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}

const reads = new WeakMap<QueryClient, Map<string, ReturnType<typeof createClockRead>>>();
export function clockReadFor(client: QueryClient, profileId: string) {
  let people = reads.get(client);
  if (!people) { people = new Map(); reads.set(client, people); }
  let reader = people.get(profileId);
  if (!reader) { reader = createClockRead(profileId); people.set(profileId, reader); }
  return reader;
}
