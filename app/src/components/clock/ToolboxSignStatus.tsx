// Where today's toolbox talk signature stands (offline toolbox signing,
// 2026-09-25): "Signed — waiting to send" while it is still on this phone,
// "Signed ✓" once Forge has it, and — when Forge refused it — the refusal in
// Forge's own words, that the clock-in behind it waits for it, and the door to
// Stuck writes where it can be tried again. The same line on every screen
// that opens on the signature, so a person reading any of them knows the
// signature is real and not yet in Forge, and never signs twice.

import { Link } from "react-router-dom";
import { useT } from "../../lib/i18n";
import type { ToolboxTodayView } from "../../lib/useToolboxGate";

export function ToolboxSignStatus({
  done,
  showSent = true,
}: {
  done: ToolboxTodayView;
  /** Also say "Signed ✓" once Forge has it; off where that would be clutter. */
  showSent?: boolean;
}) {
  const t = useT();
  if (!done.data) return null;
  const label = t("toolbox.status.label");
  if (done.refused) {
    return (
      <p className="clock-queue-line refused toolbox-sign-status" data-state="refused" role="status">
        {label}: {t("toolbox.status.refused", { reason: done.data.sendError ?? "" })}{" "}
        <Link to="/stuck">{t("toolbox.status.openStuck")}</Link>
      </p>
    );
  }
  if (done.pending) {
    return (
      <p className="clock-queue-line toolbox-sign-status" data-state="pending" role="status">
        {label}: {t("toolbox.status.pending")}
      </p>
    );
  }
  if (!showSent) return null;
  return (
    <p className="clock-pick-summary toolbox-sign-status" data-state="sent">
      {label}: {t("toolbox.status.sent")}
    </p>
  );
}
