import { stillSignedInAs, type SignInMark } from "../signedIn";
import { dispatchPaidClockRequest } from "./dispatch";
import { readPaidClockRecords } from "./storage";
import { trackPaidClockOperation } from "./reloadGuard";

/** One bounded receipt-only pass. This includes never-attempted saved starts:
 * reconnect is not renewed authorization to send their old tap. No recursion,
 * native notification subscription, exhausted retry or ancestor resend. */
export async function checkSavedPaidClockReceipts(login:SignInMark):Promise<"checked"|"held"> {
  const current=()=>!!login.userId && stillSignedInAs(login,login.userId);
  if(!current() || navigator.onLine===false)return "held";
  const until=Date.now()+25_000;
  const actual=trackPaidClockOperation(async()=>{
    const rows=await readPaidClockRecords(login);
    if(!current())return "held" as const;
    const ids=rows.filter(row=>row.delivery.status!=="acknowledged")
      .sort((a,b)=>Date.parse(a.intent.tappedAt)-Date.parse(b.intent.tappedAt) || a.clientId.localeCompare(b.clientId))
      .slice(0,4).map(row=>row.clientId);
    for(const id of ids) {
      if(!current() || navigator.onLine===false || Date.now()>=until)return "held" as const;
      await dispatchPaidClockRequest(id,login,"check_only");
      if(!current())return "held" as const;
    }
    return "checked" as const;
  });
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {return await Promise.race([actual,new Promise<"held">(resolve=>{timer=setTimeout(()=>resolve("held"),25_000);})]);}
  catch {return "held";}
  finally {if(timer)clearTimeout(timer);}
  // The underlying actual promise retains its own in-flight hold if the
  // deadline returned first. A timeout is not transport cancellation.
}
