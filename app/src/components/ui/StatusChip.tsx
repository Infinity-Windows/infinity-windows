// One pill component for a status word (kit item G, S6) — readiness on a My
// Work row, or on the Next card. Mirrors the solid/soft pair StageChip
// already draws for storage stages (index.css `.stage-chip[data-stage]`),
// but keyed by a tone rather than a stage, since readiness isn't a stage.
import type { ReactNode } from "react";

export type StatusTone = "ok" | "warn" | "error" | "muted" | "accent";

export function StatusChip({
  tone,
  children,
}: {
  tone: StatusTone;
  children: ReactNode;
}) {
  return (
    <span className="kit-status-chip" data-tone={tone}>
      {children}
    </span>
  );
}
