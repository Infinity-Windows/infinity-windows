import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { stillSignedInAs, type SignInMark } from "../../lib/signedIn";
import type { UnitBasisReply } from "../../lib/workActivity/protocol";
import type { ActivityCatalog } from "../../lib/workActivity/catalog";
import { createUnitReviewSelectionSource } from "../../lib/workUnitReview/useUnitReviewCoordinator";
import { uuid } from "../../lib/workConfiguration/model";
import { REVIEW_FRESH_MS } from "../../lib/workUnitReview/coordinator";
import type { getRealProfile } from "../../lib/install/api";
const Panel = lazy(async () => ({ default: (await import("../../components/work/UnitReviewPanel")).UnitReviewPanel }));
export type SelectedUnitReviewSource = ReturnType<typeof createUnitReviewSelectionSource>;
type FreshRead<T> = { status: "ready"; requestStartedAt: number; value: T; login: SignInMark };
const queryStamp = (query: ReturnType<QueryClient["getQueryState"]>) => JSON.stringify([
  query?.status, query?.fetchStatus, query?.isInvalidated, query?.dataUpdateCount, query?.errorUpdateCount,
]);
export interface SelectedUnitReviewProps {
 source: SelectedUnitReviewSource; login: SignInMark; projectId: string; unitId: string;
 /** Parent callback reads its live selected ID/lifetime, never captured true. */
 admitted: () => boolean;
 /** Same monotonic performance.now() base as useActivityRead, never Date.now(). */
 unitRequestStartedAt: number; catalogRequestStartedAt: number;
 onRefresh: () => Promise<void>; locale: "en" | "es";
}
/** Review binding is derived from the actual private query results, never the
 * route choices or eligibleForCapture. Its admission reads those sources again
 * at every await, including refetch/invalidation and equal-ID selection ABA. */
export function SelectedUnitReview(props: SelectedUnitReviewProps) {
 const qc = useQueryClient();
 const canonical = (value: string) => { try { return uuid(value).toLowerCase(); } catch { return ""; } };
 const unitId = canonical(props.unitId), projectId = canonical(props.projectId);
 const admitted = useRef(props.admitted), refresh = useRef(props.onRefresh), closeCurrent = useRef(() => {});
 const [refreshError, setRefreshError] = useState(false);
 const refreshLifetime = useRef(0);
 const invalidateRefresh = useCallback(() => { refreshLifetime.current++; }, []);
 // Equivalent inline callbacks do not restart the binding; final awaits read
 // the latest committed parent authority instead of a render-time boolean.
 useLayoutEffect(() => { admitted.current = props.admitted; refresh.current = props.onRefresh; });
 const subscribeProfile = useCallback((listener: () => void) => qc.getQueryCache().subscribe(event => {
  if (event.query.queryKey.length === 1 && event.query.queryKey[0] === "myRealProfile") listener();
 }), [qc]);
 const getProfileStamp = useCallback(() => queryStamp(qc.getQueryState(["myRealProfile"])), [qc]);
 const profileStamp = useSyncExternalStore(subscribeProfile, getProfileStamp, getProfileStamp);
 const unitKey = ["workActivityPrivate", props.login.userId, props.login.generation, "unit", unitId];
 const catalogKey = ["workActivityPrivate", props.login.userId, props.login.generation, "catalog", projectId, unitId];
 const unitKeyText = JSON.stringify(unitKey), catalogKeyText = JSON.stringify(catalogKey);
 useLayoutEffect(() => {
  props.source.invalidate(); invalidateRefresh();
  return () => { invalidateRefresh(); props.source.invalidate(); };
 }, [invalidateRefresh, props.source, props.login.userId, props.login.generation, projectId, unitId, profileStamp,
  props.unitRequestStartedAt, props.catalogRequestStartedAt]);
 // Parent layout effects commit the live admission before this opens access.
 useEffect(() => {
  const login = { userId: props.login.userId, generation: props.login.generation };
  props.source.invalidate();
  let alive = true;
  const unitKey = JSON.parse(unitKeyText) as unknown[], catalogKey = JSON.parse(catalogKeyText) as unknown[];
  const unitState = qc.getQueryState<FreshRead<UnitBasisReply>>(unitKey);
  const catalogState = qc.getQueryState<FreshRead<ActivityCatalog>>(catalogKey);
  const unitRead = unitState?.data, catalogRead = catalogState?.data;
  const unitStamp = queryStamp(unitState), catalogStamp = queryStamp(catalogState);
  const role = qc.getQueryData<Awaited<ReturnType<typeof getRealProfile>>>(["myRealProfile"])?.role;
  const current = () => {
   try {
    const u = qc.getQueryState<FreshRead<UnitBasisReply>>(unitKey), c = qc.getQueryState<FreshRead<ActivityCatalog>>(catalogKey);
    const elapsed = performance.now() - Math.min(props.unitRequestStartedAt, props.catalogRequestStartedAt);
    const profile = qc.getQueryState<Awaited<ReturnType<typeof getRealProfile>>>(["myRealProfile"]);
    return alive && !!login.userId && stillSignedInAs(login, login.userId) && admitted.current()
     && elapsed >= 0 && elapsed < REVIEW_FRESH_MS && u?.status === "success" && c?.status === "success"
     && u.fetchStatus === "idle" && c.fetchStatus === "idle" && !u.isInvalidated && !c.isInvalidated
     && queryStamp(u) === unitStamp && queryStamp(c) === catalogStamp && u.data === unitRead && c.data === catalogRead
     && unitRead?.status === "ready" && catalogRead?.status === "ready"
     && unitRead.requestStartedAt === props.unitRequestStartedAt && catalogRead.requestStartedAt === props.catalogRequestStartedAt
     && stillSignedInAs(unitRead.login, login.userId) && stillSignedInAs(catalogRead.login, login.userId)
     && unitRead.value.availability === "available" && catalogRead.value.availability === "available"
     && unitRead.value.unit.id.toLowerCase() === unitId && unitRead.value.unit.projectId?.toLowerCase() === projectId
     && catalogRead.value.projectId?.toLowerCase() === projectId && JSON.stringify(unitRead.value.unit) === JSON.stringify(catalogRead.value.unit)
     && queryStamp(profile) === profileStamp && profile?.status === "success" && profile.fetchStatus === "idle" && !profile.isInvalidated && profile.data?.id === login.userId
     && profile.data.role === role && !profile.data.retired_at;
   } catch { return false; }
  };
  // Cache subscription invalidates synchronously before React can reuse a
  // completed result through source A->B->A or a same-ID background refetch.
  const unsubscribe = qc.getQueryCache().subscribe(event => {
   if (event.type !== "updated" && event.type !== "removed") return;
   const key = JSON.stringify(event.query.queryKey);
   if ((key === unitKeyText || key === catalogKeyText || key === '["myRealProfile"]') && !current()) props.source.invalidate();
  });
  const close = () => { alive = false; props.source.invalidate(); };
  closeCurrent.current = close;
  const start = Math.min(props.unitRequestStartedAt, props.catalogRequestStartedAt);
  const age = performance.now() - start;
  const deadline = Number.isFinite(age) && age >= 0 && age < REVIEW_FRESH_MS ? window.setTimeout(close, REVIEW_FRESH_MS - age + 1) : undefined;
  window.addEventListener("popstate", close);
  if (role && current()) props.source.select({ login: login, realRole: role, selectedJobId: projectId,
   selectedUnitId: unitId, binding: { unitId, projectId }, admitted: current });
  return () => { close(); window.clearTimeout(deadline); unsubscribe(); window.removeEventListener("popstate", close); };
 }, [qc, props.source, props.login.userId, props.login.generation, projectId, unitId, profileStamp,
  props.unitRequestStartedAt, props.catalogRequestStartedAt, unitKeyText, catalogKeyText]);
 return <section aria-label={props.locale === "es" ? "Revisión de unidad" : "Unit review"}>
  <button type="button" className="ws-btn" onClick={() => {
   closeCurrent.current(); props.source.invalidate(); setRefreshError(false);
   const lifetime = ++refreshLifetime.current, run = refresh.current;
   void Promise.resolve().then(run).catch(() => { if (refreshLifetime.current === lifetime) setRefreshError(true); });
  }}>
   {props.locale === "es" ? "Actualizar datos de unidad" : "Refresh unit details"}
  </button>
  {refreshError && <p role="status">{props.locale === "es" ? "No se pudieron actualizar los datos. Inténtalo de nuevo." : "Unit details could not refresh. Try again."}</p>}
  <Suspense fallback={<p role="status">{props.locale === "es" ? "Cargando revisión…" : "Loading review…"}</p>}><Panel source={props.source} /></Suspense>
 </section>;
}
