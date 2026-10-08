import { clockTrustStamp } from '../clockSkew';
import { stillSignedInAs, type SignInMark } from '../signedIn';
import { appendActivityCommand, getCurrentActivityCommand, ActivityJournalConflictError, ActivityJournalUnavailableError,
  type ActivityCommandRecord, type JournalOptions } from './journal';
import { planActivityCommand, type ActivityPlan } from './planner';
import { activityJsonClone, activityUuid, parseSnapshot, type Intent, type Snapshot } from './protocol';
export type ActivityTap=Exclude<Intent,{kind:'establish_stream'}>|{kind:'establish_stream'};
export type SaveActivityTapResult={kind:'saved';record:ActivityCommandRecord;login:SignInMark}
  | {kind:'held';reason:Extract<ActivityPlan,{kind:'held'}>['reason']|'authentication_changed'}
  | {kind:'unavailable';reason:'storage'};
/** Original tap and new request IDs are frozen BEFORE reading native storage.
 * The read's login mark must still match; a same-owner logout/login cannot
 * turn an old private snapshot into fresh authority. No mutation RPC is made.
 * Only a completed durable append permits the caller to attempt dispatch. */
export async function saveActivityTap(deviceId:string,source:{value:Snapshot;requestStartedAt:number;login:SignInMark},
  action:ActivityTap,options?:JournalOptions):Promise<SaveActivityTapResult>{
  activityUuid(deviceId);
  const login={...source.login},ownerId=login.userId;
  const current=()=>!!ownerId && stillSignedInAs(login,ownerId);
  const changed=():SaveActivityTapResult=>({kind:'held',reason:'authentication_changed'});
  if(!ownerId || !current())return changed();
  const snapshot=parseSnapshot(source.value,deviceId),requestStartedAt=source.requestStartedAt;
  const original=activityJsonClone(action),stamp=clockTrustStamp(),commandId=crypto.randomUUID();
  const plannedAction=original.kind==='establish_stream'?{kind:'establish_stream' as const,newGeneration:crypto.randomUUID()}:original;
  try{
    const head=await getCurrentActivityCommand(ownerId,deviceId,options);
    if(!current())return changed();
    const plan=planActivityCommand({ownerId,deviceId,commandId,snapshot,elapsedMs:performance.now()-requestStartedAt,head,action:plannedAction,stamp});
    if(plan.kind==='held')return plan;
    const record=await appendActivityCommand({commandId:plan.commandId,ownerId:plan.ownerId,payload:plan.payload},options);
    if(!current())return changed();
    return {kind:'saved',record,login};
  }catch(error){
    if(!current())return changed();
    if(error instanceof ActivityJournalUnavailableError)return {kind:'unavailable',reason:'storage'};
    if(error instanceof ActivityJournalConflictError)return {kind:'held',reason:'needs_reaffirmation'};
    throw error;
  }
}
