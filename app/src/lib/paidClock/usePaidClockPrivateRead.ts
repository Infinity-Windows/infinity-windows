import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { signInGeneration, signedInUserId, signInMark, stillSignedInAs, subscribeSignedIn, type SignInMark } from "../signedIn";
import { useConnection } from "../offline/useWeakSignal";
import { subscribePaidClockChanges } from "./notifications";
import { isPaidClockTransportFailure } from "./readFailure";

type State="blocked"|"loading"|"unavailable"|"ready"|"stale";
type Read<T>={identity:string;state:State;value:T|null};
/** Private, online, current-login state. No query cache hydration, queue merge,
 * receipt projection or offline persistence can turn an unread shift into off. */
export function usePaidClockPrivateRead<T>(profileId:string|null,enabled:boolean,fetchValue:(login:SignInMark)=>Promise<T>,
  retainTransport=false,readLast?: (login:SignInMark)=>T|null) {
  const owner=useSyncExternalStore(subscribeSignedIn,signedInUserId,()=>null);
  const generation=useSyncExternalStore(subscribeSignedIn,signInGeneration,()=>0);
  const {online}=useConnection();
  const permitted=enabled && !!owner && owner===profileId;
  const allowed=permitted && online;
  const identity=`${owner ?? "none"}:${generation}:${profileId ?? "none"}:${permitted}`;
  const [read,setRead]=useState<Read<T>>({identity:"",state:"blocked",value:null});
  const live=useRef(identity),sequence=useRef(0),alive=useRef(false);
  live.current=identity;
  if(read.identity!==identity && read.value)setRead({identity,state:allowed?"loading":"blocked",value:null});
  const refresh=useCallback(async()=>{
    const token=++sequence.current,login=signInMark();
    if(!allowed || !owner || !stillSignedInAs(login,owner) || login.generation!==generation)return;
    const current=()=>alive.current && live.current===identity && token===sequence.current && stillSignedInAs(login,owner);
    if(!current())return;
    setRead(old=>({identity,state:"loading",value:retainTransport && old.identity===identity?old.value:null}));
    try {const value=await fetchValue(login);if(current())setRead({identity,state:"ready",value});}
    catch(error) {if(current())setRead(old=>({identity,state:retainTransport && old.value && isPaidClockTransportFailure(error)?"stale":"unavailable",
      value:retainTransport && isPaidClockTransportFailure(error)?old.value:null}));}
  },[allowed,generation,identity,owner,fetchValue,retainTransport]);
  useEffect(()=>{
    const lifetime=alive,counter=sequence;lifetime.current=true;
    if(!allowed)return()=>{lifetime.current=false;counter.current++;};
    void refresh();
    const unsubscribe=subscribePaidClockChanges(()=>{void refresh();});
    const poll=setInterval(()=>{void refresh();},60_000);
    return()=>{lifetime.current=false;counter.current++;clearInterval(poll);unsubscribe();};
  },[allowed,refresh]);
  if(!permitted)return {state:"blocked" as const,value:null,refresh};
  const retained=retainTransport?(read.identity===identity?read.value:readLast?.(signInMark()) ?? null):null;
  if(!online)return {state:retained?"stale" as const:"blocked" as const,value:retained,refresh};
  if(read.identity!==identity)return {state:"loading" as const,value:null,refresh};
  return {state:read.state==="loading" && retained?"stale" as const:read.state,
    value:read.state==="ready"?read.value:retained,refresh};
}
