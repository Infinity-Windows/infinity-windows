// Global sync-status pill (p1-12). Shows pending outbox counts like
// "Clock 1 · Photos 3 · 2 logs queued", a calm "All synced" resting state, and
// a "needs attention" state when writes have dead-lettered. Status is conveyed
// by text + icon + tone, never color alone, and announced via aria-live.

import { CheckCircle2, CloudOff, RefreshCw, TriangleAlert } from "lucide-react";
import { useOutbox } from "../../lib/offline/useOutbox";

export function SyncStatusPill({ compact = false }: { compact?: boolean }) {
  const { pill } = useOutbox();

  const Icon =
    pill.tone === "attention"
      ? TriangleAlert
      : pill.tone === "syncing"
        ? CloudOff
        : CheckCircle2;

  return (
    <div
      className={`sync-pill sync-pill-${pill.tone}${compact ? " sync-pill-compact" : ""}`}
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
