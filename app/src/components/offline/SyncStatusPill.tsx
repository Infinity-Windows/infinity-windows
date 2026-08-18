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

import { useEffect, useState } from "react";
import { CheckCircle2, CloudOff, RefreshCw, TriangleAlert } from "lucide-react";
import { useOutbox } from "../../lib/offline/useOutbox";
import type { PillSummary, PillTone } from "../../lib/offline/outbox-core";
import {
  pendingInstallCount,
  subscribeSyncListeners,
} from "../../lib/install/installOutbox";

/** Live count of installs waiting in the install outbox. */
function useInstallOutboxCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      pendingInstallCount().then((n) => {
        if (!cancelled) setCount(n);
      });
    };
    refresh();
    return subscribeSyncListeners(refresh);
  }, []);
  return count;
}

/**
 * Fold the install-outbox count into the offline-outbox pill summary. Kept
 * here rather than in outbox-core.ts's pillSummary because OpCounts only
 * enumerates lib/offline/outbox ops — installs are a different queue with no
 * dead-letter state of their own (retry cap is deliberately deferred), so a
 * queued install can only ever push the pill toward "syncing", never toward
 * "needs attention" by itself.
 */
function withInstalls(pill: PillSummary, installsPending: number): PillSummary {
  if (installsPending === 0) return pill;
  const installsLabel =
    installsPending === 1 ? "1 install queued" : `${installsPending} installs queued`;
  const installsSentence =
    installsPending === 1 ? "1 install" : `${installsPending} installs`;
  const tone: PillTone = pill.tone === "attention" ? "attention" : "syncing";
  return {
    tone,
    label: pill.tone === "synced" ? installsLabel : `${pill.label} · ${installsLabel}`,
    detail:
      pill.tone === "synced"
        ? `${installsSentence} saved and waiting to sync.`
        : `${pill.detail} ${installsSentence} also waiting to sync.`,
  };
}

export function SyncStatusPill() {
  const { pill: outboxPill } = useOutbox();
  const installsPending = useInstallOutboxCount();
  const pill = withInstalls(outboxPill, installsPending);

  const Icon =
    pill.tone === "attention"
      ? TriangleAlert
      : pill.tone === "syncing"
        ? CloudOff
        : CheckCircle2;

  return (
    <div
      className={`sync-pill sync-pill-${pill.tone}`}
      role="status"
      aria-live="polite"
      aria-label={pill.detail}
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
    </div>
  );
}
