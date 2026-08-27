// Wave S, S2: supervisor-only toggle on a Logs tab row, showing and
// flipping daily_logs.customer_visible (Q14 — the one gate for everything
// crew-made reaching a builder login). Rendered only when the viewer is
// supervisor+ (DailyLogsTab checks isSupervisorPlus(effectiveRole)) — a
// foreman sees the log's shared state nowhere, matching Q14's own
// "supervisor shares", not "supervisor OR foreman shares".
import { useState } from "react";
import { setLogCustomerVisible } from "../../lib/dailyLogs";

export function ShareWithBuilderChip({
  logId,
  visible,
  onChanged,
}: {
  logId: string;
  visible: boolean;
  /** Called with the new state once the server confirms it. */
  onChanged: (visible: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation(); // the row itself opens the log dialog on click
    if (saving) return;
    setSaving(true);
    try {
      const next = !visible;
      const row = await setLogCustomerVisible(logId, next);
      onChanged(row.customer_visible);
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      type="button"
      className="share-chip"
      data-shared={visible}
      disabled={saving}
      onClick={toggle}
      title={
        visible
          ? "The builder can see this log — tap to hide it again"
          : "The builder cannot see this log yet — tap to share it"
      }
    >
      {visible ? "Shared with builder" : "Share with builder"}
    </button>
  );
}
