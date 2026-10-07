import { useSyncExternalStore } from "react";
import { readClockFlow, subscribeClockFlow } from "./flowRegistry";

/** One provider's RAM-only, current-login clock route, also usable by cards
 * mounted outside the provider subtree. Missing admission stays unknown. */
export function useNativeClockFlow(profileId:string|null) {
  return useSyncExternalStore(subscribeClockFlow,()=>readClockFlow(profileId),()=>null);
}
