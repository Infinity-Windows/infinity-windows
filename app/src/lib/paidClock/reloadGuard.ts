import { signInMark, stillSignedInAs } from "../signedIn";

// Deliberately small: the shell imports this flag, never the payroll API or
// native request store. A deadline in a caller does not cancel its RPC.
let operations = 0;
export const PAID_CLOCK_BUSY_EVENT = "forge:paid-clock-in-flight";
function changed() { if (typeof window !== "undefined") window.dispatchEvent(new Event(PAID_CLOCK_BUSY_EVENT)); }
export function paidClockOperationInFlight(): boolean { return operations > 0; }
export function beginPaidClockOperation(): () => void {
  operations++;
  changed();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    operations--;
    changed();
  };
}
export async function trackPaidClockOperation<T>(run: () => Promise<T>): Promise<T> {
  const finish = beginPaidClockOperation();
  try { return await run(); } finally { finish(); }
}

/** Unknown authorized storage holds automatic reload. No request is sent or
 * changed here; dead-tab sending rows remain unresolved delivery evidence. */
export async function readPaidClockReloadHold(userId: string | null): Promise<number> {
  if (!userId) return 0;
  const login = signInMark();
  if (!stillSignedInAs(login, userId)) return 1;
  try {
    const { readPaidClockRecords } = await import("./storage");
    if (!stillSignedInAs(login, userId)) return 1;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const rows = await Promise.race([
      readPaidClockRecords(login),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("Native clock storage unread")),2_000);}),
    ]).finally(()=>clearTimeout(timer));
    if (!stillSignedInAs(login, userId) || rows.some(row => row.ownerId !== userId)) return 1;
    return rows.filter(row => ["queued", "sending", "uncertain"].includes(row.delivery.status)).length;
  } catch { return 1; }
}
