export const PAID_CLOCK_EVENT = "forge:paid-clock-chain";
const CHANNEL = "forge-paid-clock-chain-wake-v1";

/** Wake messages contain no account, request, source or credential data. Each
 * reader obtains its own authorized records again; this is never a resolver. */
export function notifyPaidClockChanges(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PAID_CLOCK_EVENT));
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage(null); channel.close();
  } catch { /* focus/reconnect reads still recover when channels are unavailable */ }
}
export function subscribePaidClockChanges(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(PAID_CLOCK_EVENT, callback);
  window.addEventListener("focus", callback);
  window.addEventListener("online", callback);
  const visible = () => { if (document.visibilityState === "visible") callback(); };
  document.addEventListener("visibilitychange", visible);
  let channel: BroadcastChannel | undefined;
  try { channel = new BroadcastChannel(CHANNEL); channel.onmessage = () => callback(); }
  catch { /* native store and owner checks do not depend on cross-tab messages */ }
  return () => {
    window.removeEventListener(PAID_CLOCK_EVENT, callback);
    window.removeEventListener("focus", callback);
    window.removeEventListener("online", callback);
    document.removeEventListener("visibilitychange", visible); channel?.close();
  };
}
