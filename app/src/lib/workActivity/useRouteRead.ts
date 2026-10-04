import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { signedInUserId, signInGeneration, subscribeSignedIn, stillSignedInAs } from "../signedIn";
import { supabase } from "../supabase";

const online = () => typeof navigator !== "undefined" && navigator.onLine !== false;
let networkRevision = 0;
const networkListeners = new Set<() => void>();
const networkChanged = () => { networkRevision++; for (const cb of networkListeners) cb(); };
const networkSnapshot = () => `${networkRevision}:${online()}`;
function subscribeNetwork(cb: () => void) {
  if (!networkListeners.size) { window.addEventListener("online", networkChanged); window.addEventListener("offline", networkChanged); }
  networkListeners.add(cb);
  return () => { networkListeners.delete(cb); if (!networkListeners.size) {window.removeEventListener("online", networkChanged); window.removeEventListener("offline", networkChanged);} };
}
/** Route-only, memory-only reads. Identity/resource/preview/offline changes hide
 * data synchronously; late results cannot restore it. No persisted query root. */
export function useRouteRead<T>(resource: string, enabled: boolean, read: () => Promise<T>) {
  const owner = useSyncExternalStore(subscribeSignedIn, signedInUserId, () => null);
  const generation = useSyncExternalStore(subscribeSignedIn, signInGeneration, () => 0);
  const network = useSyncExternalStore(subscribeNetwork, networkSnapshot, () => "0:false");
  const connected = network.endsWith(":true");
  const [revision, setRevision] = useState(0);
  const allowed = enabled && connected && Boolean(owner);
  const key = allowed ? `${owner}:${generation}:${resource}:${network}:${revision}` : null;
  const [result, setResult] = useState<{key: string; state: "ready" | "unavailable"; value?: T} | null>(null);
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  useEffect(() => {
    if (!key || !owner) return;
    let active = true;
    const mark = { userId: owner, generation };
    const valid = () => active && online() && stillSignedInAs(mark, owner);
    void (async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (!valid() || error || !data.session?.access_token || data.session.user.id !== owner) throw new Error("unavailable");
        const value = await read();
        if (valid()) setResult({ key, state: "ready", value });
      } catch { if (valid()) setResult({ key, state: "unavailable" }); }
    })();
    return () => { active = false; };
  }, [key, owner, generation, read]);
  const current = key && result?.key === key ? result : null;
  return { data: current?.state === "ready" ? current.value : undefined,
    state: !allowed ? "blocked" as const : current?.state ?? "loading" as const, refresh };
}
