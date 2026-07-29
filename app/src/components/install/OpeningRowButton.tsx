// The tappable, informational part of a window/door row.
//
// Only this part of the row opens the details. The row's own control — "Claim"
// on the map list, the installer picker on Dispatch — stays outside the button,
// so a foreman working down 42 rows with the dropdown never gets a panel in his
// face, and nothing needs to guess at intent from where a finger landed.

import type { ReactNode } from "react";
import { openingRowLabel } from "../../lib/install/openingRowAction";

interface OpeningRowButtonProps {
  /** `12-2` — used for the spoken name, which also says the mark. */
  openingCode: string;
  expanded: boolean;
  /** The panel this row opens, for readers following the relationship. */
  panelId: string;
  onToggle: () => void;
  children: ReactNode;
}

export function OpeningRowButton({
  openingCode,
  expanded,
  panelId,
  onToggle,
  children,
}: OpeningRowButtonProps) {
  return (
    <button
      type="button"
      className="opening-row-open"
      aria-label={openingRowLabel(openingCode)}
      aria-expanded={expanded}
      aria-controls={expanded ? panelId : undefined}
      onClick={onToggle}
    >
      <span className="opening-row-open__info">{children}</span>
      <span className="opening-row-open__chev" aria-hidden>
        {expanded ? "▾" : "›"}
      </span>
    </button>
  );
}
