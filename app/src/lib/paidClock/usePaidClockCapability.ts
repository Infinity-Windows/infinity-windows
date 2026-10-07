import {fetchPaidClockCapability} from "./capability";
import {usePaidClockPrivateRead} from "./usePaidClockPrivateRead";
export function usePaidClockCapability(profileId:string|null,enabled:boolean) {
  return usePaidClockPrivateRead(profileId,enabled,fetchPaidClockCapability);
}
