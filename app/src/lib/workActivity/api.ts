import { clientWithToken, supabase } from '../supabase';
import { signInMark, stillSignedInAs, type SignInMark } from '../signedIn';
import { activityUuid, parsePayload, parseReceiptReply, parseSnapshot, parseUnitBasisReply, type Payload, type ReceiptReply, type Snapshot, type UnitBasisReply } from './protocol';
export class ActivityUnavailableError extends Error {
  constructor(){super('Activity information is unavailable. Refresh before changing work.');this.name='ActivityUnavailableError';}
}
export type CommandAttempt = { kind:'receipt'; reply: ReceiptReply }
  | { kind:'attempt_refused'; sqlState:'23514'|'42501' }
  | { kind:'unknown' };
const online=()=>typeof navigator==='undefined' || navigator.onLine!==false;
async function token(mark:SignInMark):Promise<string> {
  const who=mark.userId;
  if(!who || !online() || !stillSignedInAs(mark,who)) throw new ActivityUnavailableError();
  const {data,error}=await supabase.auth.getSession();
  if(error || !data.session?.access_token || data.session.user.id!==who || !stillSignedInAs(mark,who) || !online()) throw new ActivityUnavailableError();
  return data.session.access_token;
}
function current(mark:SignInMark):boolean{return !!mark.userId && stillSignedInAs(mark,mark.userId);}
/** Fresh owner/auth-generation-bound projection. No cache or offline fallback. */
export async function fetchActivitySnapshot(deviceId:string, login:SignInMark=signInMark()):Promise<Snapshot> {
  try {
    activityUuid(deviceId);const mark={...login};const access=await token(mark);
    const {data,error}=await clientWithToken(access).rpc('work_activity_snapshot',{p_device_id:deviceId});
    if(error || !current(mark) || !online()) throw new ActivityUnavailableError();
    return parseSnapshot(data,deviceId);
  } catch {throw new ActivityUnavailableError();}
}
export async function fetchActivityUnitBasis(unitId:string, login:SignInMark=signInMark()):Promise<UnitBasisReply> {
  try {
    activityUuid(unitId);const mark={...login};const access=await token(mark);
    const {data,error}=await clientWithToken(access).rpc('work_activity_unit_basis',{p_unit_id:unitId});
    if(error || !current(mark) || !online()) throw new ActivityUnavailableError();
    return parseUnitBasisReply(data,unitId);
  } catch {throw new ActivityUnavailableError();}
}
/** Dispatch only the journal's exact durable envelope. A refusal describes this
 * attempt's rollback; it must never clear a prior attempt's uncertainty. */
export async function submitActivityCommand(commandId:string,payload:Payload,login:SignInMark):Promise<CommandAttempt> {
  activityUuid(commandId);const original=parsePayload(payload);const mark={...login}; // clone BEFORE await
  try {
    const access=await token(mark);
    const {data,error}=await clientWithToken(access).rpc('work_activity_command',{
      p_command_id:commandId,p_protocol_version:1,p_payload:original,
    });
    if(!current(mark)) return {kind:'unknown'};
    if(error){
      const code=error.code;
      return code==='23514' || code==='42501' ? {kind:'attempt_refused',sqlState:code} : {kind:'unknown'};
    }
    // A valid immutable receipt may settle independently of current projection
    // availability, or a connection going offline after the response arrived.
    return {kind:'receipt',reply:parseReceiptReply(data,commandId)};
  } catch {return {kind:'unknown'};}
}
export async function lookupActivityReceipt(commandId:string,login:SignInMark):Promise<CommandAttempt> {
  activityUuid(commandId);const mark={...login};
  try {
    const access=await token(mark);
    const {data,error}=await clientWithToken(access).rpc('work_activity_command_receipt',{p_command_id:commandId});
    if(error || !current(mark)) return {kind:'unknown'};
    return {kind:'receipt',reply:parseReceiptReply(data,commandId)};
  } catch {return {kind:'unknown'};}
}
