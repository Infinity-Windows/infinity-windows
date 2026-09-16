// One chip for a daily log's day-flow (wave L, L3). Same technique
// InstallChip (components/install/InstallChip.tsx) and .veh-status-* both
// use: reuse the app's ok/warn/danger tokens directly rather than minting a
// fourth copy of them. A separate component, not a fourth InstallState,
// because day-flow is not an install state — InstallChip's own header
// comment scopes it to "every install state a crew reads", and Smooth/Fine/
// Stuck is a different domain (a day's temperature, not a unit's).
import { useT, type TKey } from "../../lib/i18n";
import type { ReactNode } from "react";
import type { DayFlow } from "../../lib/dailyLogs";

const LABEL: Record<DayFlow, TKey> = {
  smooth: "dailyLog.flow.smooth",
  fine: "dailyLog.flow.fine",
  stuck: "dailyLog.flow.stuck",
};

export function DayFlowChip({
  flow,
  children,
}: {
  flow: DayFlow;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <span className="dayflow-chip" data-flow={flow}>
      {children ?? t(LABEL[flow])}
    </span>
  );
}
