// The existing release constant remains false. New design alone is not a
// release authorization; disabled/Classic entry renders the prior Work body.
import { PAID_SETUP_RELEASE_AUTHORIZED } from "../paidClock/ClockFlowBridge";
import { useDesign } from "../design/context";

export function useSelectedJobWorkGate(): boolean {
  const { design } = useDesign();
  return PAID_SETUP_RELEASE_AUTHORIZED && design === "new";
}
