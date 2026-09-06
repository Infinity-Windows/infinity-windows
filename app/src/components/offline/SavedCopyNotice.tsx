// One line, the same everywhere: this screen is showing what the phone last
// saved, and why. Rendered from lib/offline/useSavedCopy's reason.

import { useT } from "../../lib/i18n";
import type { SavedCopyReason } from "../../lib/offline/useSavedCopy";

export function SavedCopyNotice({ reason }: { reason: SavedCopyReason }) {
  const t = useT();
  if (!reason) return null;
  const key =
    reason === "offline"
      ? "offline.savedCopy.offline"
      : reason === "weak"
        ? "offline.savedCopy.weak"
        : "offline.savedCopy.failed";
  return (
    <p className="muted saved-copy-notice" role="status" aria-live="polite" data-testid="saved-copy-notice">
      {t(key)}
    </p>
  );
}
