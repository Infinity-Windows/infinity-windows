// Global sync-status pill (p1-12). Shows pending outbox counts like
// "Clock 1 · Photos 3 · 2 logs queued", a calm "All synced" resting state, and
// a "needs attention" state when writes have dead-lettered. Status is conveyed
// by text + icon + tone, never color alone, and announced via aria-live.
//
// Marking a window installed queues in a SEPARATE store (lib/install/
// installOutbox), not lib/offline/outbox — the install flow persists RPC +
// points + media as one durable record so a retry can't half-apply. That
// queue had a listener (subscribeSyncListeners) built for exactly this and no
// caller: a queued install was invisible everywhere, so closing the app
// mid-flight looked identical to a finished submit. Fold its count in here.

import { useClock } from "../../lib/clockContext";
import {
  readWorkQueue,
  syncWork,
  WORK_QUEUE_EVENT,
} from "../../lib/customWork/queue";
import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
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
import type { PillSummary, PillTone } from "../../lib/offline/outbox-core";
import { withConnection } from "../../lib/offline/pillConnection";
import { useConnection } from "../../lib/offline/useWeakSignal";
import {
  failedInstallCount,
  pendingInstallCount,
  subscribeSyncListeners,
} from "../../lib/install/installOutbox";

/** Live count of installs waiting in the install outbox. */
function useInstallOutboxCount(): { pending: number; failed: number } {
  const [count, setCount] = useState({ pending: 0, failed: 0 });
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void Promise.all([pendingInstallCount(), failedInstallCount()]).then(
        ([pending, failed]) => {
          if (!cancelled) setCount({ pending, failed });
        },
      );
    };
    refresh();
    const unsubscribe = subscribeSyncListeners(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return count;
}

/**
 * Fold the install-outbox count into the offline-outbox pill summary. Kept
 * here rather than in outbox-core.ts's pillSummary because OpCounts only
 * enumerates lib/offline/outbox ops.
 *
 * A GIVEN-UP install turns the pill to "needs attention" on its own: the retry
 * cap now exists, so an install can stop trying, and a stopped install that
 * never turned the pill red would be exactly the silent loss the cap was
 * supposed to end. Tapping the pill opens the stuck-writes screen.
 */
function withInstalls(
  pill: PillSummary,
  installsPending: number,
  installsFailed: number,
): PillSummary {
  if (installsFailed > 0) {
    const failedLabel =
      installsFailed === 1
        ? "1 install needs you"
        : `${installsFailed} installs need you`;
    return {
      tone: "attention",
      label:
        pill.tone === "synced" ? failedLabel : `${pill.label} · ${failedLabel}`,
      detail:
        installsFailed === 1
          ? "An install stopped trying to send. Open this to try it again."
          : `${installsFailed} installs stopped trying to send. Open this to try them again.`,
    };
  }
  if (installsPending === 0) return pill;
  const installsLabel =
    installsPending === 1
      ? "1 install queued"
      : `${installsPending} installs queued`;
  const installsSentence =
    installsPending === 1 ? "1 install" : `${installsPending} installs`;
  const tone: PillTone = pill.tone === "attention" ? "attention" : "syncing";
  return {
    tone,
    label:
      pill.tone === "synced"
        ? installsLabel
        : `${pill.label} · ${installsLabel}`,
    detail:
      pill.tone === "synced"
        ? `${installsSentence} saved and waiting to sync.`
        : `${pill.detail} ${installsSentence} also waiting to sync.`,
  };
}

function useCustomWorkCount() {
  const { profileId } = useClock();
  const [state, setState] = useState({ pending: 0, failed: 0 });
  useEffect(() => {
    const read = () => {
      try {
        const rows = profileId ? readWorkQueue(profileId) : [];
        setState({
          pending: rows.length,
          failed: rows.filter((r) => r.error).length,
        });
      } catch {
        setState({ pending: 1, failed: 1 });
      }
    };
    const sync = () => {
      read();
      if (profileId && navigator.onLine) {
        try {
          if (readWorkQueue(profileId).length)
            void syncWork(profileId).catch(() =>
              setState({ pending: 1, failed: 1 }),
            );
        } catch {
          setState({ pending: 1, failed: 1 });
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
  }, [profileId]);
  return state;
}

export function SyncStatusPill() {
  const t = useT();
  const { pill: outboxPill } = useOutbox();
  const installs = useInstallOutboxCount();
  const custom = useCustomWorkCount();
  const basePill = withInstalls(outboxPill, installs.pending, installs.failed);
  const workLabel = custom.failed
    ? "Work needs review"
    : `${custom.pending} work changes queued`;
  const combined: PillSummary = custom.pending
    ? {
        tone:
          custom.failed || basePill.tone === "attention"
            ? "attention"
            : "syncing",
        label:
          basePill.tone === "synced"
            ? workLabel
            : `${basePill.label} · ${workLabel}`,
        detail:
          "Custom work is saved on this device and waiting to sync. Open Current Work to review it.",
      }
    : basePill;
  const { online, weak } = useConnection();
  const pill = withConnection(combined, online, weak, t);

  const Icon =
    pill.tone === "attention"
      ? TriangleAlert
      : pill.tone === "offline"
        ? WifiOff
        : pill.tone === "weak"
          ? Wifi
          : pill.tone === "syncing"
            ? CloudOff
            : CheckCircle2;

  // The pill IS the indicator that something needs a person, so it is also the
  // door: tapping it opens the stuck-writes screen where a failed punch can be
  // retried or thrown away. Before this there was nowhere for a dead-lettered
  // write to be acted on, which is why one could sit invisible forever.
  return (
    <Link
      to={custom.pending ? "/current-work" : "/stuck"}
      className={`sync-pill sync-pill-${pill.tone}`}
      data-tone={pill.tone}
      role="status"
      aria-live="polite"
      aria-label={`${pill.detail} — ${custom.pending ? "open Current Work" : "open stuck writes"}`}
      title={pill.detail}
    >
      <span className="sync-pill-icon" aria-hidden>
        {pill.tone === "syncing" ? (
          <RefreshCw size={14} className="sync-pill-spin" />
        ) : (
          <Icon size={14} />
        )}
      </span>
      <span className="sync-pill-text">{pill.label}</span>
    </Link>
  );
}
