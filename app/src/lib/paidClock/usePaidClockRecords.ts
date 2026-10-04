import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { signedInUserId, signInGeneration, signInMark, stillSignedInAs, subscribeSignedIn } from "../signedIn";
import { subscribePaidClockChanges } from "./notifications";
import { readPaidClockRecords, type PaidClockRecord } from "./storage";

type State = "blocked" | "loading" | "ready" | "unavailable";
const EMPTY: PaidClockRecord[] = [];
interface ReadState { identity: string; state: State; rows: PaidClockRecord[] }

/** Read-only owner projection of the isolated native clock queue. Never drains or retries it. */
export function usePaidClockRecords(profileId: string | null): { state: State; rows: PaidClockRecord[]; refresh: () => Promise<void> } {
  const owner=useSyncExternalStore(subscribeSignedIn,signedInUserId,()=>null);
  const generation=useSyncExternalStore(subscribeSignedIn,signInGeneration,()=>0);
  const allowed=!!owner && profileId===owner;
  const identity=`${owner ?? "anonymous"}:${generation}:${profileId ?? "none"}`;
  const [read,setRead]=useState<ReadState>({identity:"",state:"loading",rows:EMPTY});
  // Drop the previous owner's array during render, before a new paint or
  // asynchronous effect. The key comparison also covers same-person ABA.
  if (read.identity!==identity && read.rows.length) setRead({identity,state:allowed?"loading":"blocked",rows:EMPTY});
  const latestIdentity=useRef(identity);
  latestIdentity.current=identity;
  const readSequence=useRef(0);
  const alive=useRef(false);
  const refresh=useCallback(async () => {
    const sequence=++readSequence.current;
    const mark=signInMark();
    if (!allowed || mark.userId!==owner || mark.generation!==generation || !stillSignedInAs(mark,owner)) return;
    const current=()=>alive.current && sequence===readSequence.current && latestIdentity.current===identity && stillSignedInAs(mark,owner);
    if (!current()) return;
    setRead({identity,state:"loading",rows:EMPTY});
    try {
      const rows=await readPaidClockRecords(mark);
      if (!current()) return;
      if (!Array.isArray(rows) || rows.some(row=>row.ownerId!==owner)) throw Error("Clock records unavailable");
      setRead({identity,state:"ready",rows});
    } catch {
      if (current()) setRead({identity,state:"unavailable",rows:EMPTY});
    }
  },[allowed,generation,identity,owner]);
  useEffect(()=>{
    const lifetime=alive, sequence=readSequence;
    alive.current=true;
    if (!allowed) { sequence.current++; return () => { lifetime.current=false; sequence.current++; }; }
    void refresh();
    const unsubscribe=subscribePaidClockChanges(()=>{ void refresh(); });
    return ()=>{ lifetime.current=false; sequence.current++; unsubscribe(); };
  },[allowed,refresh]);
  if (!allowed) return {state:"blocked",rows:EMPTY,refresh};
  if (read.identity!==identity) return {state:"loading",rows:EMPTY,refresh};
  return {state:read.state,rows:read.state==="ready"?read.rows:EMPTY,refresh};
}
