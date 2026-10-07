import { cloneJson, postgresInstantMicros } from "../workConfiguration/model";
import { stillSignedInAs, type SignInMark } from "../signedIn";
import { ClockAccountChangedError, ownPaidClockClient } from "./api";
export interface PaidClockCapability {
  protocolVersion:1;asOf:string;clockProtocol:"setup_v1";receiptProtocol:"retained_v1";
  mode:"active"|"closing_only"|"unavailable";canAuthorSetup:boolean;
  setupReason:null|"starts_disabled"|"toolbox_required"|"not_ready";
  canDispatchExistingSetup:boolean;canReadOwnReceipts:boolean;canDispatchPayrollSafety:boolean;
}
const KEYS=["protocolVersion","asOf","clockProtocol","receiptProtocol","mode","canAuthorSetup","setupReason",
  "canDispatchExistingSetup","canReadOwnReceipts","canDispatchPayrollSafety"];
export function parsePaidClockCapability(raw:unknown):PaidClockCapability {
  const value=cloneJson(raw);
  if(!value || typeof value!=="object" || Array.isArray(value))throw Error("Clock capability unavailable");
  const o=value as Record<string,unknown>;
  if(Object.keys(o).length!==KEYS.length || KEYS.some(key=>!Object.hasOwn(o,key)) || o.protocolVersion!==1 ||
    o.clockProtocol!=="setup_v1" || o.receiptProtocol!=="retained_v1" || !["active","closing_only","unavailable"].includes(o.mode as string) ||
    ![null,"starts_disabled","toolbox_required","not_ready"].includes(o.setupReason as null|string) ||
    ["canAuthorSetup","canDispatchExistingSetup","canReadOwnReceipts","canDispatchPayrollSafety"].some(key=>typeof o[key]!=="boolean") ||
    o.canAuthorSetup && (o.mode!=="active" || o.setupReason!==null) ||
    o.canAuthorSetup && (!o.canDispatchExistingSetup || !o.canReadOwnReceipts || !o.canDispatchPayrollSafety) ||
    !o.canAuthorSetup && o.setupReason===null ||
    o.mode==="active" && ![null,"toolbox_required"].includes(o.setupReason as null|string) ||
    o.mode==="closing_only" && (o.canAuthorSetup || o.setupReason!=="starts_disabled") ||
    o.mode==="unavailable" && (o.canAuthorSetup || o.setupReason!=="not_ready"))throw Error("Clock capability unavailable");
  postgresInstantMicros(o.asOf);
  return Object.freeze(o) as unknown as PaidClockCapability;
}
export async function fetchPaidClockCapability(login:SignInMark):Promise<PaidClockCapability> {
  const owner=login.userId;
  if(!owner || !stillSignedInAs(login,owner))throw new ClockAccountChangedError();
  const client=await ownPaidClockClient(login);
  if(!stillSignedInAs(login,owner))throw new ClockAccountChangedError();
  const {data,error}=await client.rpc("work_activity_clock_capability");
  if(!stillSignedInAs(login,owner))throw new ClockAccountChangedError();
  if(error)throw error;
  return parsePaidClockCapability(data);
}
