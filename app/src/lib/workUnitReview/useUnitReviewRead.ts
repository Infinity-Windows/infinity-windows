import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { signedInUserId, signInGeneration, stillSignedInAs, subscribeSignedIn, type SignInMark } from "../signedIn";
import { useViewAsRole } from "../viewAsRoleContext";
import { uuid } from "../workConfiguration/model";
import { fetchUnitReview } from "./api";
import type { ReviewReply } from "./protocol";

const online = () => typeof navigator !== "undefined" && navigator.onLine !== false;
const visible = () => typeof document !== "undefined" && document.visibilityState !== "hidden";
function subscribeEnvironment(callback: () => void) {
  window.addEventListener("online", callback); window.addEventListener("offline", callback);
  document.addEventListener("visibilitychange", callback);
  return () => {
    window.removeEventListener("online", callback); window.removeEventListener("offline", callback);
    document.removeEventListener("visibilitychange", callback);
  };
}
const foregroundOnline = () => online() && visible();
function validId(value: string | null): boolean { try { uuid(value); return true; } catch { return false; } }
interface Identity { key: string; login: SignInMark; unitId: string }
type ReadState = { identity: Identity; request: number; state: "loading" | "unavailable" }
  | { identity: Identity; request: number; state: "ready"; value: ReviewReply; requestStartedAt: number };

/** Permission-checked inspection data stays in this mounted hook's RAM only.
 * contextKey must identify the selected job/route lifetime, including a fresh
 * key when that lifetime ends and is reopened. No disk/query cache or writes.
 * Refresh hides the previous view while the server checks current permissions.
 */
export function useUnitReviewRead(unitId: string | null, contextKey: string | null, enabled: boolean) {
  const owner = useSyncExternalStore(subscribeSignedIn, signedInUserId, () => null);
  const generation = useSyncExternalStore(subscribeSignedIn, signInGeneration, () => 0);
  const connected = useSyncExternalStore(subscribeEnvironment, foregroundOnline, () => false);
  const preview = useViewAsRole();
  const allowed = enabled && connected && !!owner && validId(unitId) && !!contextKey?.trim()
    && !preview.previewRole && !preview.previewPerson;
  const key = allowed ? JSON.stringify([owner, generation, unitId, contextKey]) : "blocked";
  const active = useRef<Identity | null>(null);
  // The render fence hides an old identity before effects run. Re-entry gets a
  // new object, so an earlier response cannot revive even an identical key.
  if (active.current?.key !== key) active.current = allowed ? { key, login: { userId: owner, generation }, unitId: unitId! } : null;
  const identity = active.current;
  const request = useRef(0);
  const [result, setResult] = useState<ReadState | null>(null);
  const refresh = useCallback(async () => {
    if (!identity || active.current !== identity || !foregroundOnline() || !stillSignedInAs(identity.login, identity.login.userId!)) return;
    const sequence = ++request.current, requestStartedAt = performance.now();
    const admission = () => active.current === identity && request.current === sequence && foregroundOnline()
      && stillSignedInAs(identity.login, identity.login.userId!);
    setResult({ identity, request: sequence, state: "loading" });
    try {
      const value = await fetchUnitReview(identity.unitId, identity.login, admission);
      if (!admission()) return;
      setResult(value.availability === "available"
        ? { identity, request: sequence, state: "ready", value, requestStartedAt }
        : { identity, request: sequence, state: "unavailable" });
    } catch {
      if (admission()) setResult({ identity, request: sequence, state: "unavailable" });
    }
  }, [identity]);
  useEffect(() => {
    if (!identity) { setResult(null); return; }
    active.current = identity;
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(onFocus, 30_000);
    return () => {
      window.removeEventListener("focus", onFocus); window.clearInterval(timer);
      if (active.current === identity) { active.current = null; ++request.current; }
    };
  }, [identity, refresh]);
  const current = identity && result?.identity === identity && result.request === request.current ? result : null;
  return {
    state: !identity ? "blocked" as const : current?.state ?? "loading" as const,
    data: current?.state === "ready" ? { value: current.value, login: identity!.login, requestStartedAt: current.requestStartedAt } : undefined,
    refresh,
  };
}
