import { useCallback, useLayoutEffect, useReducer, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { signInGeneration, signInMark, stillSignedInAs, subscribeSignedIn } from "../signedIn";
import { useViewAsRole } from "../viewAsRoleContext";
import { REVIEW_FRESH_MS, type UnitReviewSelectionSource } from "../workUnitReview/selection";
import type { getRealProfile } from "../install/api";
import { fetchUnitContributors, type UnitContributorsScope } from "./api";
import type { UnitContributorsView } from "./protocol";

let environment = 0, hidden = false;
const listeners = new Set<() => void>();
const changed = () => { environment++; for (const listener of listeners) listener(); };
const hide = () => { hidden = true; changed(); };
const show = () => { hidden = false; changed(); };
const foreground = () => !hidden && document.visibilityState !== "hidden" && navigator.onLine !== false;
function subscribeEnvironment(listener: () => void) {
  if (!listeners.size) {
    hidden = document.visibilityState === "hidden";
    window.addEventListener("online", changed); window.addEventListener("offline", changed);
    window.addEventListener("pagehide", hide); window.addEventListener("pageshow", show);
    document.addEventListener("visibilitychange", changed);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener("online", changed); window.removeEventListener("offline", changed);
      window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show);
      document.removeEventListener("visibilitychange", changed);
    }
  };
}
const environmentSnapshot = () => environment;
const noop = () => () => {};
const missing = () => -1;
const zero = () => 0;
type Profile = Awaited<ReturnType<typeof getRealProfile>>;
interface ReadSession {
  scope: UnitContributorsScope;
  current: () => boolean;
  startedAt: number;
  state: "loading" | "ready" | "unavailable";
  data: UnitContributorsView | null;
}

/** Mount only after a deliberate Check on independently fresh unit/catalog
 * sources. This hook keeps one frozen server snapshot in RAM and never grows
 * its live tail, persists it, polls or replays a read after reconnect. Keep
 * this hook mounted across basis/selection changes: a real unmount/remount
 * starts a new lifetime, so the parent must retain its deliberate Check gate.
 * Once an RPC starts, layout cleanup consumes its Check, including Suspense
 * reactivation. Startup waits one microtask so a discarded StrictMode effect
 * never sends an RPC. A replaced QueryClient also consumes the current Check. */
export function useUnitContributors(scope: UnitContributorsScope | null,
  source: UnitReviewSelectionSource, admitted: () => boolean, admissionRevision: string | number) {
  const selected = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const preview = useViewAsRole().sensitiveLifetime;
  const previewRevision = useSyncExternalStore(preview?.subscribe ?? noop, preview?.getSnapshot ?? missing, missing);
  const auth = useSyncExternalStore(subscribeSignedIn, signInGeneration, zero);
  const network = useSyncExternalStore(subscribeEnvironment, environmentSnapshot, zero);
  const qc = useQueryClient();
  const profileStamp = useCallback(() => {
    const state = qc.getQueryState(["myRealProfile"]);
    return JSON.stringify([state?.dataUpdateCount, state?.errorUpdateCount, state?.status,
      state?.fetchStatus, state?.isInvalidated, state?.dataUpdatedAt]);
  }, [qc]);
  const profileSubscribe = useCallback((listener: () => void) => qc.getQueryCache().subscribe(event => {
    if ((event.type === "updated" || event.type === "removed")
      && JSON.stringify(event.query.queryKey) === '["myRealProfile"]') listener();
  }), [qc]);
  const profile = useSyncExternalStore(profileSubscribe, profileStamp, () => "");
  const admission = useRef(admitted);
  useLayoutEffect(() => { admission.current = admitted; });
  const active = useRef<ReadSession | null>(null);
  const lifetime = useRef<{
    revision: string | number; key: string; qc: typeof qc; source: UnitReviewSelectionSource; selected: typeof selected;
    preview: typeof preview; previewRevision: number; auth: number; network: number; profile: string; blocked: boolean;
  } | null>(null);
  const [, paint] = useReducer(n => n + 1, 0);
  const projectId = scope?.projectId, unitId = scope?.unitId, incarnation = scope?.unitIncarnation;

  useLayoutEffect(() => {
    let alive = true;
    const key = JSON.stringify([projectId, unitId, incarnation]), prior = lifetime.current;
    const blocked = !!prior && prior.revision === admissionRevision && (prior.blocked || prior.key !== key || prior.qc !== qc || prior.source !== source
      || prior.selected !== selected || prior.preview !== preview || prior.previewRevision !== previewRevision
      || prior.auth !== auth || prior.network !== network || prior.profile !== profile);
    if (projectId === undefined || unitId === undefined || incarnation === undefined) {
      // A temporary missing basis consumes an existing Check rather than
      // forgetting it. An initial null scope has not opened a read yet.
      if (prior) prior.blocked = true;
    } else {
      lifetime.current = { revision: admissionRevision, key, qc, source, selected, preview, previewRevision, auth, network, profile, blocked };
    }
    const login = signInMark(), profileData = qc.getQueryData<Profile>(["myRealProfile"]);
    const role = profileData?.role;
    const requestScope = projectId && unitId && incarnation !== undefined
      ? { projectId, unitId, unitIncarnation: incarnation } : null;
    const current = () => {
      try {
        const state = qc.getQueryState<Profile>(["myRealProfile"]), selection = selected.selection;
        return alive && !!requestScope && source.getSnapshot() === selected && !!selection
          && !!login.userId && stillSignedInAs(login, login.userId) && foreground()
          && environmentSnapshot() === network && !!preview && preview.getSnapshot() === previewRevision
          && (role === "owner" || role === "supervisor") && preview.admitted(login.userId, role)
          && profileStamp() === profile && state?.status === "success" && state.fetchStatus === "idle"
          && !state.isInvalidated && state.data === profileData && state.data?.id === login.userId && !state.data.retired_at
          && Date.now() >= state.dataUpdatedAt && Date.now() - state.dataUpdatedAt < REVIEW_FRESH_MS
          && selection.selectedJobId === requestScope.projectId.toLowerCase()
          && selection.selectedUnitId === requestScope.unitId.toLowerCase() && selection.realRole === role
          && stillSignedInAs(selection.login, login.userId) && selection.admitted() && admission.current();
      } catch { return false; }
    };
    active.current = null;
    if (blocked || !requestScope || !current()) {
      if (lifetime.current) lifetime.current.blocked = true;
      paint(); return () => { alive = false; };
    }
    const session: ReadSession = { scope: requestScope, current, startedAt: performance.now(), state: "loading", data: null };
    active.current = session; paint();
    const profileDeadline = (qc.getQueryState(["myRealProfile"])?.dataUpdatedAt ?? 0) + REVIEW_FRESH_MS - Date.now();
    const timer = window.setTimeout(() => {
      if (active.current === session) {
        session.data = null; session.state = "unavailable";
        if (lifetime.current) lifetime.current.blocked = true;
        window.clearInterval(tick); paint();
      }
    }, Math.max(0, Math.min(REVIEW_FRESH_MS, profileDeadline)));
    const checkLifetime = lifetime.current;
    let readStarted = false;
    void Promise.resolve().then(() => {
      if (!current() || active.current !== session || lifetime.current !== checkLifetime) {
        // A live startup whose authority closes consumes Check. A discarded
        // effect (StrictMode cleanup before this microtask) sends nothing.
        if (alive && active.current === session && lifetime.current === checkLifetime) {
          if (checkLifetime) checkLifetime.blocked = true;
          session.state = "unavailable"; paint();
        }
        return;
      }
      readStarted = true;
      return fetchUnitContributors(requestScope, login, current);
    }).then(reply => {
      if (!reply) return;
      if (!current() || active.current !== session || performance.now() - session.startedAt >= REVIEW_FRESH_MS) return;
      session.data = reply.availability === "available" ? reply.contributors : null;
      session.state = session.data ? "ready" : "unavailable"; paint();
    }).catch(() => {
      if (current() && active.current === session) { session.data = null; session.state = "unavailable"; paint(); }
    });
    const tick = window.setInterval(() => { if (active.current === session && session.data) paint(); }, 1000);
    return () => {
      alive = false; session.data = null; window.clearTimeout(timer); window.clearInterval(tick);
      if (readStarted && checkLifetime) checkLifetime.blocked = true;
      if (active.current === session) active.current = null;
    };
  }, [projectId, unitId, incarnation, source, selected, preview, previewRevision, auth, network, qc,
    profile, profileStamp, admissionRevision]);

  const session = active.current;
  const valid = !!session && session.scope.projectId === projectId && session.scope.unitId === unitId
    && session.scope.unitIncarnation === incarnation && session.current()
    && performance.now() - session.startedAt < REVIEW_FRESH_MS;
  if (session && !valid) {
    session.data = null;
    if (lifetime.current) lifetime.current.blocked = true;
  }
  return { state: valid ? session.state : "held" as const, data: valid ? session.data : null };
}
