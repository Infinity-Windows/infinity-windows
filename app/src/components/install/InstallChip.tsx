// One chip for every install state a crew reads — planned, assigned,
// installed, ready, blocked, incomplete, damaged, redo, flashing. Mirrors
// StageChip's shape (components/warehouse/StageChip.tsx): the word inside is
// whatever the caller already prints — this component never rewords (see
// lib/install/types.ts's openingStatusLabel/readyStatusLabel for that), only
// the pill and its color come from here. Read-only, unlike StageChip: an
// install state is never a filter toggle, so there is no aria-pressed/
// selected look to invert.
import type { ReactNode } from "react";

export type InstallState =
  | "planned"
  | "assigned"
  | "installed"
  | "ready"
  | "blocked"
  | "incomplete"
  | "damaged"
  | "redo"
  | "flashing";

export function InstallChip({
  state,
  children,
}: {
  state: InstallState;
  children: ReactNode;
}) {
  return (
    <span className="install-chip" data-state={state}>
      {children}
    </span>
  );
}
