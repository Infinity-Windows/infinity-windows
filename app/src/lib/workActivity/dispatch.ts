import { stillSignedInAs, type SignInMark } from '../signedIn';
import { lookupActivityReceipt, submitActivityCommand, type CommandAttempt } from './api';
import { getActivityCommand, getActivityDispatchReadiness, markActivityAttempt, recordActivityReceipt, type DispatchReadiness, type JournalOptions } from './journal';
import { activityUuid, type Receipt } from './protocol';
export type DispatchResult={kind:'settled';receipt:Receipt}
  | {kind:'held';reason:Exclude<DispatchReadiness,{ready:true}>['reason']|'authentication_changed'|'receipt_unknown'}
  | {kind:'unknown';sqlState?:'23514'|'42501'};
/** A new action is saved separately before calling this function. A recovery
 * read never sends a second attempt unless the worker explicitly retries the
 * ORIGINAL request. Neither path creates IDs, rebases payloads or uses payroll. */
export async function dispatchSavedActivityCommand(
  deviceId:string,commandId:string,login:SignInMark,
  policy:'first_attempt'|'retry_original'='first_attempt',options?:JournalOptions,
):Promise<DispatchResult>{
  activityUuid(deviceId);activityUuid(commandId);const mark={...login},ownerId=mark.userId;
  const current=()=>!!ownerId && stillSignedInAs(mark,ownerId);
  const changed=():DispatchResult=>({kind:'held',reason:'authentication_changed'});
  if(!ownerId || !current())return changed();
  let row=await getActivityCommand(ownerId,deviceId,commandId,options);
  if(!current())return changed();
  if(!row)throw Error('The saved activity request is unavailable.');
  if(row.receipt)return {kind:'settled',receipt:row.receipt};
  async function settle(attempt:CommandAttempt):Promise<DispatchResult|null>{
    if(!current())return changed();
    if(attempt.kind!=='receipt' || attempt.reply.availability!=='available')return null;
    const saved=await recordActivityReceipt(ownerId!,deviceId,commandId,row!.payload,attempt.reply,options);
    if(!current())return changed();
    if(!saved.receipt)throw Error('The activity receipt could not be saved.');
    return {kind:'settled',receipt:saved.receipt};
  }
  if(row.uncertain){
    // Receipts remain authoritative after a lease or current projection expires.
    const known=await settle(await lookupActivityReceipt(commandId,mark));
    if(known)return known;
    if(!current())return changed();
    if(policy!=='retry_original')return {kind:'held',reason:'receipt_unknown'};
  }
  const readiness=await getActivityDispatchReadiness(ownerId,deviceId,commandId,options);
  if(!current())return changed();
  if(!readiness.ready)return {kind:'held',reason:readiness.reason};
  // Native completion of this save is the boundary before ANY mutation RPC.
  row=await markActivityAttempt(ownerId,deviceId,commandId,row.payload,options);
  if(!current())return changed();
  if(row.receipt)return {kind:'settled',receipt:row.receipt};
  const attempt=await submitActivityCommand(commandId,row.payload,mark);
  const known=await settle(attempt);
  if(known)return known;
  if(!current())return changed();
  return attempt.kind==='attempt_refused'?{kind:'unknown',sqlState:attempt.sqlState}:{kind:'unknown'};
}
