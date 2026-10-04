import {useMemo,useSyncExternalStore} from "react";
import {signInMark} from "../signedIn";
import {fetchOwnPaidClockCurrent,readLastObservedPaidClock,minimalObservedPaidClock,subscribeObservedClockChanges} from "./current";
import {usePaidClockPrivateRead} from "./usePaidClockPrivateRead";
const readObserved=()=>readLastObservedPaidClock(signInMark());
export function useOwnPaidClockCurrent(profileId:string|null,enabled:boolean) {
  const observed=useSyncExternalStore(subscribeObservedClockChanges,readObserved,()=>null);
  const read=usePaidClockPrivateRead(profileId,enabled,fetchOwnPaidClockCurrent,true,readLastObservedPaidClock);
  const minimal=useMemo(()=>read.value?minimalObservedPaidClock(read.value):null,[read.value]);
  if(read.value?.observedAt && read.state!=="blocked") {
    if(!observed)return {...read,state:"unavailable" as const,value:null};
    if(observed.observedAt!==read.value.observedAt)return {...read,state:"stale" as const,value:observed};
  }
  return read.state==="stale" && read.value?{...read,value:minimal}:read;
}
