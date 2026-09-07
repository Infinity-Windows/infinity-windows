import type { ReactNode } from "react";

export type StatusTone = "ok" | "warn" | "danger" | "soft" | "mute";

/**
 * A small state pill — same idea as `StageChip` (warehouse) and `InstallChip`
 * (install), generalized for the rest of the kit instead of adding a fourth
 * one-off. See ListRow.tsx for why this lives here instead of importing S6's
 * own kit.
 */
export function StatusChip({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className="ui-status-chip" data-tone={tone}>
      {children}
    </span>
  );
}
