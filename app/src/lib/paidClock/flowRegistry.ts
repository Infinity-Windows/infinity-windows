import { signInMark, stillSignedInAs, subscribeSignedIn } from "../signedIn";
import type { NativeClockFlow } from "./flow";
let flow:NativeClockFlow|null=null;
const listeners=new Set<()=>void>();
const changed=()=>{for(const callback of listeners)callback();};
// The shared registry contains RAM-only state for the currently mounted
// provider. Clear it on every account generation change, including ABA.
subscribeSignedIn(()=>{flow=null;changed();});
export function publishClockFlow(next:NativeClockFlow|null):void {flow=next;changed();}
export function subscribeClockFlow(callback:()=>void):()=>void {listeners.add(callback);return()=>{listeners.delete(callback);};}
export function readClockFlow(profileId:string|null):NativeClockFlow|null {
  const login=signInMark();
  return flow && profileId && flow.ownerId===profileId && flow.loginGeneration===login.generation && stillSignedInAs(login,profileId)?flow:null;
}
