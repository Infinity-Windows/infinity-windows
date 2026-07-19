import type { ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { formatApiError } from "../../lib/errors";

/** A block of shimmer skeleton rows to stand in for a loading list. */
export function SkeletonList({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={`skeleton-list${className ? ` ${className}` : ""}`} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton-row">
          <div className="skeleton-block skeleton-avatar" />
          <div className="skeleton-lines">
            <div className="skeleton-block skeleton-line-lg" />
            <div className="skeleton-block skeleton-line-sm" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A single-line / card shimmer for simple placeholders. */
export function SkeletonCard({ height = 72 }: { height?: number }) {
  return <div className="skeleton-block" style={{ height, borderRadius: 14 }} aria-hidden />;
}

/** Purposeful empty state with an optional next-action. */
export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon?: ReactNode;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state" role="status">
      {icon && <span className="empty-state-icon" aria-hidden>{icon}</span>}
      <p className="empty-state-title">{title}</p>
      {message && <p className="empty-state-msg muted">{message}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}

/** Per-query error state with a Retry button. */
export function QueryError({
  error,
  onRetry,
  label = "Couldn't load this",
}: {
  error?: unknown;
  onRetry?: () => void;
  label?: string;
}) {
  return (
    <div className="query-error" role="alert">
      <span className="query-error-icon" aria-hidden>
        <AlertTriangle size={18} />
      </span>
      <div className="query-error-text">
        <p className="query-error-title">{label}</p>
        <p className="muted">{formatApiError(error)}</p>
      </div>
      {onRetry && (
        <button type="button" className="query-error-retry" onClick={onRetry}>
          <RotateCw size={14} aria-hidden /> Retry
        </button>
      )}
    </div>
  );
}
