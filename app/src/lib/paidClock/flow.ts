import type { ClockPunch } from "../clockPunch";
import type { TimeShift } from "../timeclock";
import { stillSignedInAs, type SignInMark } from "../signedIn";
import type { QueuedClockAction } from "../clockQueueView";
import type { ClockIntent } from "./protocol";
import type { OwnPaidClockCurrent } from "./current";
import {getCurrentLoginCommittedHead,isCurrentLoginCommittedHead,type PaidClockRecord} from "./storage";
import { paidSetupIntent, submitPaidClockIntent, type PaidClockSubmission } from "./coordinator";
import { trackPaidClockOperation } from "./reloadGuard";
import type { PaidClockCapability } from "./capability";

export type ClockFlowRoute="legacy"|"isolated"|"recovery_only"|"activation_blocked";
export interface NativeClockFlow {
  ownerId:string|null;
  loginGeneration:number;
  route:ClockFlowRoute;
  nativeRead:"loading"|"ready"|"blocked"|"unavailable";
  records:readonly PaidClockRecord[];
  currentRead:"loading"|"ready"|"blocked"|"unavailable"|"stale";
  current:OwnPaidClockCurrent|null;
  canStartDay:boolean;
  canRequestSafety:boolean;
  setupReason?:PaidClockCapability["setupReason"];
  pendingSafetyAction?:ClockIntent["action"]|null;
  authorStart:(punch:ClockPunch)=>Promise<PaidClockSubmission>;
  authorSafety:(intent:ClockIntent)=>Promise<PaidClockSubmission>;
  refresh:()=>void;
}
export interface ClockFlowInput {
  releaseAuthorized:boolean;
  backendReady:boolean;
  nativeRead:NativeClockFlow["nativeRead"];
  records:readonly PaidClockRecord[];
  currentRead:NativeClockFlow["currentRead"];
  current:OwnPaidClockCurrent|null;
  legacyReady:boolean;
  legacyShift:TimeShift|null;
  legacyPending:QueuedClockAction|null;
}
/** Capability and rollout are separate. Delivery history never supplies
 * current payroll state, and unread native storage never means empty. */
export function projectClockFlow(input:ClockFlowInput) {
  const ownsNative=input.records.length>0;
  const nativeReady=input.nativeRead==="ready";
  const nativeSafetyAdmitted=input.releaseAuthorized || nativeReady && ownsNative;
  const currentNeeded=input.releaseAuthorized || ownsNative || !nativeReady;
  const currentReady=input.currentRead==="ready" && !!input.current;
  const unresolvedStart=input.records.some(row=>row.intent.action==="clock_in" && row.delivery.status!=="acknowledged");
  const pendingLegacyStart=input.legacyPending?.kind==="clock_in";
  const route:ClockFlowRoute=!nativeReady?"activation_blocked":input.releaseAuthorized?
    input.backendReady?"isolated":"activation_blocked":ownsNative?"recovery_only":"legacy";
  const paidOff=currentNeeded?currentReady && input.current?.kind==="off":input.legacyReady && input.legacyShift===null;
  return {route,canStartDay:(route==="legacy" || route==="isolated") && paidOff && !unresolvedStart && !pendingLegacyStart,
    canRequestSafety:currentNeeded?nativeSafetyAdmitted && (currentReady || input.currentRead==="stale") && input.current?.kind==="open":input.legacyReady && input.legacyShift?.status==="open"};
}
export async function authorNativeClockStart(punch:ClockPunch,login:SignInMark,allowed:boolean):Promise<PaidClockSubmission> {
  const intent=paidSetupIntent(punch);
  if(!allowed || !login.userId || !stillSignedInAs(login,login.userId))return {kind:"held",clientId:intent.clientId,reason:"basis_unavailable"};
  return trackPaidClockOperation(()=>submitPaidClockIntent(login,intent,null));
}
export async function authorNativeClockSafety(intent:ClockIntent,login:SignInMark,current:OwnPaidClockCurrent|null):Promise<PaidClockSubmission> {
  if(intent.action==="clock_in" || intent.shiftRef.kind!=="shift" || current?.kind!=="open" || current.shift.id!==intent.shiftRef.id ||
    current.shift.profile_id!==login.userId || !login.userId || !stillSignedInAs(login,login.userId)) {
    return {kind:"held",clientId:intent.clientId,reason:"basis_unavailable"};
  }
  const head=getCurrentLoginCommittedHead(login,current.shift.id);
  if(head && isCurrentLoginCommittedHead(head,login,current.shift.id)) {
    if(head.action==="clock_out" || head.action===intent.action)return {kind:"held",clientId:intent.clientId,reason:"basis_unavailable"};
    // This predecessor exists only because this login committed the original.
    // Preserve its exact origin; an old uncertain head is never adopted here.
    return trackPaidClockOperation(()=>submitPaidClockIntent(login,{...intent,shiftRef:head.origin},head.clientId));
  }
  return trackPaidClockOperation(()=>submitPaidClockIntent(login,intent,null));
}
