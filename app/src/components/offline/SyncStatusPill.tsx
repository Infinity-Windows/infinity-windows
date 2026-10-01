// Global sync-status pill (p1-12). Shows pending outbox counts like
// "Clock 1 · Photos 3 · 2 logs queued", a calm "All synced" resting state, and
// a "needs attention" state when writes have dead-lettered. Status is conveyed
// by text + icon + tone, never color alone, and announced via aria-live.
//
// It counts EVERY queue on the phone (K0.6, 2026-09-23): the main outbox, the
// install outbox (a finished unit persists RPC + points + media as one durable
// record in its own store), the custom-work and servicing command queues, the
// servicing evidence store, and whatever the retired upload queue still holds
// before its first start moves it across. The composition is pure and tested
// in lib/offline/pillQueues.ts; this file only reads the counts. "All synced"
// is never drawn while any of them holds anything.
//
// It is also where the background drains are STARTED: the main outbox's and
// the install outbox's. The pill is on every screen, which is what makes
// "sends from any screen" true — the install drain used to be started by the
// opening sheet alone, so an install queued in a dead zone was retried only
// while that one sheet was open.

import { useClock } from "../../lib/clockContext";
import { signInMark, signedInUserId, stillSignedInAs, subscribeSignedIn } from "../../lib/signedIn";
import {
  readWorkQueue,
  syncWork,
  WORK_QUEUE_EVENT,
} from "../../lib/customWork/queue";
import { Link } from "react-router-dom";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  CheckCircle2,
  CloudOff,
  RefreshCw,
  TriangleAlert,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useT } from "../../lib/i18n";
import { useOutbox } from "../../lib/offline/useOutbox";
import { totalPending } from "../../lib/offline/outbox-core";
import { subscribe as subscribeOutbox } from "../../lib/offline/outbox";
import { subscribeSyncReceipt, type SyncReceipt } from "../../lib/offline/syncReceipt";
import { CONFIRM_MS, statusPresentation } from "../../lib/offline/statusPresentation";
import { withConnection } from "../../lib/offline/pillConnection";
import { combineQueues, PILL_DESTINATION } from "../../lib/offline/pillQueues";
import { withHeld } from "../../lib/offline/pillHeld";
import { useConnection } from "../../lib/offline/useWeakSignal";
import {
  initInstallOutboxAutoFlush,
  installCounts,
  subscribeSyncListeners,
} from "../../lib/install/installOutbox";
import { pendingLegacyUploadCount } from "../../lib/install/legacyUploadQueue";

/** Live count of installs waiting in the install outbox — this person's, and
 * apart from them anyone else's — and the drain that empties it, started here
 * so it runs from every screen. */
function useInstallOutboxCount(profileId: string | null) {
  const empty = useMemo(() => ({ profileId, pending: 0, failed: 0, theirs: 0, unknown: 0, ready: false, readError: false }), [profileId]);
  const [count, setCount] = useState(empty);
  useEffect(() => {
    initInstallOutboxAutoFlush();
    let cancelled = false;
    setCount(empty);
    const refresh = () => {
      if (!profileId) return;
      const mark = signInMark();
      void installCounts().then((next) => {
        if (!cancelled && stillSignedInAs(mark, profileId)) setCount({ ...next, profileId, ready: true, readError: false });
      }).catch(() => {
        if (!cancelled && stillSignedInAs(mark, profileId)) setCount((old) => ({ ...old, ready: true, readError: true }));
      });
    };
    refresh();
    const unsubscribe = subscribeSyncListeners(refresh);
    const offSignedIn = subscribeSignedIn(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
      offSignedIn();
    };
  }, [profileId, empty]);
  return count.profileId === profileId ? count : empty;
}

function useCustomWorkCount(profileId: string | null) {
  const empty = useMemo(() => ({ profileId, pending: 0, failed: 0, ready: false, readError: false }), [profileId]);
  const [state, setState] = useState(empty);
  useEffect(() => {
    setState(empty);
    const read = () => {
      try {
        const rows = profileId ? readWorkQueue(profileId) : [];
        setState({
          pending: rows.length,
          failed: rows.filter((r) => r.error).length,
          profileId,
          ready: Boolean(profileId),
          readError: false,
        });
      } catch {
        setState((old) => ({ ...old, ready: true, readError: true }));
      }
    };
    const sync = () => {
      read();
      if (profileId && navigator.onLine) {
        try {
          if (readWorkQueue(profileId).length)
            void syncWork(profileId).catch(read);
        } catch {
          read();
        }
      }
    };
    sync();
    window.addEventListener(WORK_QUEUE_EVENT, read);
    window.addEventListener("storage", read);
    window.addEventListener("online", sync);
    window.addEventListener("focus", sync);
    const retry = setInterval(sync, 30000);
    return () => {
      window.removeEventListener(WORK_QUEUE_EVENT, read);
      window.removeEventListener("storage", read);
      window.removeEventListener("online", sync);
      window.removeEventListener("focus", sync);
      clearInterval(retry);
    };
  }, [profileId, empty]);
  return state.profileId === profileId ? state : empty;
}

/**
 * Is there anything of this person's in the servicing stores at all? Answered
 * without loading the servicing code: the command queue is one localStorage
 * key, and the evidence store is a database whose existence
 * `indexedDB.databases()` reports without opening it. Servicing lives outside
 * the shell bundle on purpose, and most phones never do servicing — this keeps
 * that chunk off every screen of every other crew member's day.
 */
async function servicingMayHoldWork(profileId: string): Promise<boolean> {
  try {
    const raw = localStorage.getItem(`forge-servicing-v1:${profileId}`);
    if (raw && raw !== "[]") return true;
  } catch {
    // No localStorage: nothing could have been queued in it.
  }
  if (typeof indexedDB === "undefined") return false;
  const list = (indexedDB as { databases?: () => Promise<Array<{ name?: string }>> }).databases;
  if (typeof list !== "function") return true;
  try {
    return (await list.call(indexedDB)).some((d) => d.name === "forge-service-evidence-v1");
  } catch {
    return true;
  }
}

/**
 * Servicing commands and evidence waiting on this phone, and one attempt to
 * send them on every tick — the servicing screen syncs its own queue while it
 * is open, and this covers every other screen. Both syncs take the same lock
 * the screen does, so the two never send the same command twice.
 */
function useServicingCount(profileId: string | null) {
  const empty = useMemo(() => ({ profileId, pending: 0, failed: 0, ready: false, readError: false }), [profileId]);
  const [state, setState] = useState(empty);
  useEffect(() => {
    setState(empty);
    if (!profileId) {
      return;
    }
    let cancelled = false;
    const read = async (send: boolean) => {
      try {
        if (!(await servicingMayHoldWork(profileId))) {
          if (!cancelled) setState({ profileId, pending: 0, failed: 0, ready: true, readError: false });
          return;
        }
        const [{ readServiceQueue, syncService }, { flushServiceMedia, pendingServiceMedia }] =
          await Promise.all([import("../../lib/servicing/queue"), import("../../lib/servicing/mediaQueue")]);
        if (send && navigator.onLine) {
          try {
            await syncService(profileId);
            await flushServiceMedia(profileId);
          } catch {
            // Refusals are recorded on the rows themselves; read them below.
          }
        }
        const commands = readServiceQueue(profileId);
        const media = await pendingServiceMedia(profileId);
        if (cancelled) return;
        setState({
          pending: commands.length + media.length,
          failed: commands.filter((c) => c.error).length + media.filter((m) => m.error).length,
          profileId,
          ready: true,
          readError: false,
        });
      } catch {
        // A store this session cannot read is a store it cannot be sending
        // from; but something is there, and "synced" would be a lie.
        if (!cancelled) setState((old) => ({ ...old, ready: true, readError: true }));
      }
    };
    const onChange = () => void read(false);
    const onSync = () => void read(true);
    void read(true);
    let eventName: string | null = null;
    void import("../../lib/servicing/queue")
      .then(({ SERVICE_QUEUE_EVENT }) => {
        if (cancelled) return;
        eventName = SERVICE_QUEUE_EVENT;
        window.addEventListener(SERVICE_QUEUE_EVENT, onChange);
      })
      .catch(() => {
        // The chunk failed to load: the interval below still re-reads.
      });
    window.addEventListener("storage", onChange);
    window.addEventListener("online", onSync);
    window.addEventListener("focus", onSync);
    const tick = setInterval(onSync, 30_000);
    return () => {
      cancelled = true;
      if (eventName) window.removeEventListener(eventName, onChange);
      window.removeEventListener("storage", onChange);
      window.removeEventListener("online", onSync);
      window.removeEventListener("focus", onSync);
      clearInterval(tick);
    };
  }, [profileId, empty]);
  return state.profileId === profileId ? state : empty;
}

/**
 * What the retired upload queue still holds. Zero on every phone after its
 * first start with this build (the outbox's startup moves them across and
 * then announces itself, which is the re-read below); until then, a photo in
 * it is a photo that has not been sent, and the pill says so.
 */
function useLegacyUploadCount() {
  const [state, setState] = useState({ count: 0, ready: false, readError: false });
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      void pendingLegacyUploadCount()
        .then((n) => {
          if (!cancelled) setState({ count: n, ready: true, readError: false });
        })
        .catch(() => {
          // Cannot be opened → never call the phone fully synced.
          if (!cancelled) setState((old) => ({ ...old, ready: true, readError: true }));
        });
    };
    read();
    const unsubscribe = subscribeOutbox(read);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return state;
}

export function SyncStatusPill({ quietWhenSynced = false }: { quietWhenSynced?: boolean }) {
  const t = useT();
  const { counts, pill: outboxPill, held, unknown, readState } = useOutbox();
  const { loading: clockLoading } = useClock();
  // The clock profile query can still describe the previous person during an
  // account switch. Queue ownership follows the actual auth session instead.
  const profileId = useSyncExternalStore(subscribeSignedIn, signedInUserId, signedInUserId);
  const installs = useInstallOutboxCount(profileId);
  const custom = useCustomWorkCount(profileId);
  const service = useServicingCount(profileId);
  const legacy = useLegacyUploadCount();
  // Someone else's queued work waits for them and is shown as theirs, never
  // counted as this person's (2026-09-25, lib/offline/entryOwner.ts): it is
  // already out of `counts`, and withHeld names it on the face.
  const combined = combineQueues(
    withHeld(outboxPill, { theirs: held + installs.theirs, unknown: unknown + installs.unknown }, t),
    {
      basePending: totalPending(counts),
      installsPending: installs.pending,
      installsFailed: installs.failed,
      workPending: custom.pending,
      workFailed: custom.failed,
      servicePending: service.pending,
      serviceFailed: service.failed,
      legacyPending: legacy.count,
    },
    t,
  );
  const { online, weak } = useConnection();
  const pill = withConnection(combined, online, weak, t);
  const [checkTimedOut, setCheckTimedOut] = useState(false);
  const [receipt, setReceipt] = useState<SyncReceipt | null>(null);
  useEffect(() => {
    setReceipt(null);
    if (!profileId) return;
    return subscribeSyncReceipt((next) => {
      // A receipt for the previous sign-in must never congratulate the next
      // person on this shared phone. Queue ownership is checked at send time.
      if (next.ownerId === profileId) setReceipt(next);
    });
  }, [profileId]);
  useEffect(() => {
    if (!receipt) return;
    const remaining = Math.max(0, CONFIRM_MS - (Date.now() - receipt.savedAt));
    const timer = setTimeout(() => setReceipt((current) => current?.sequence === receipt.sequence ? null : current), remaining);
    return () => clearTimeout(timer);
  }, [receipt]);

  const allReady = Boolean(profileId) && !clockLoading && readState === "ready" && installs.ready && custom.ready && service.ready && legacy.ready;
  const readError = readState === "error" || installs.readError || custom.readError || service.readError || legacy.readError || checkTimedOut;
  useEffect(() => {
    setCheckTimedOut(false);
    if (allReady || readState === "error") return;
    // An IndexedDB read can stall on an older iPhone. A permanent spinner
    // would be another false reassurance; give the person a review door.
    const timer = setTimeout(() => setCheckTimedOut(true), 15_000);
    return () => clearTimeout(timer);
  }, [profileId, allReady, readState]);
  const presentation = statusPresentation({
    pill, outboxReadState: readState, allReady, readError, receipt: quietWhenSynced ? receipt : null,
    profileId, quietWhenSynced, now: Date.now(), t,
  });
  const { display, receipt: isReceipt } = presentation;

  // The modern crew layout has no permanent "All synced" decoration. A
  // confirmed write gets four seconds; a wait, weak signal, or refusal stays.
  if (!presentation.visible) return null;

  const Icon =
    display.tone === "attention"
      ? TriangleAlert
      : display.tone === "offline"
        ? WifiOff
        : display.tone === "weak"
          ? Wifi
          : display.tone === "syncing"
            ? CloudOff
            : CheckCircle2;

  // The pill IS the indicator that something is waiting or needs a person, so
  // it is also the door: tapping it opens the one screen that lists every
  // queue, where a waiting photo shows its age and a failed punch can be
  // retried or thrown away. Always the same door (F5) — it used to open
  // Current Work when custom work was queued, so the same tap led two places.
  return (
    <Link
      to={PILL_DESTINATION}
      className={`sync-pill sync-pill-${display.tone}${isReceipt ? " sync-pill-receipt" : ""}`}
      data-tone={display.tone}
      role="status"
      aria-live="polite"
      aria-label={`${display.detail} — ${t("pill.openStatus")}`}
      title={display.detail}
    >
      <span className="sync-pill-icon" aria-hidden>
        {display.tone === "syncing" ? (
          <RefreshCw size={14} className="sync-pill-spin" />
        ) : (
          <Icon size={14} />
        )}
      </span>
      <span className="sync-pill-text">
        {display === pill && combined.tone === "syncing" &&
          <span className="sync-pill-state">{t("stuck.state.waiting")} · </span>}
        {display.label}
      </span>
    </Link>
  );
}
