import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { signedInUserId, signInGeneration, subscribeSignedIn } from "../signedIn";
import { uuid } from "../workConfiguration/model";
import { fetchUnitFactSnapshot } from "./api";

const online = () => typeof navigator === "undefined" || navigator.onLine !== false;
function subscribeOnline(callback: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("online", callback); window.addEventListener("offline", callback);
  return () => { window.removeEventListener("online", callback); window.removeEventListener("offline", callback); };
}
function validId(value: string | null): boolean { try { uuid(value); return true; } catch { return false; } }

/** Callers disable in preview. Offline, logout and navigation hide and clear private evidence. */
export function useUnitFactSnapshot(projectId: string | null, unitId: string | null, enabled: boolean) {
  const owner=useSyncExternalStore(subscribeSignedIn,signedInUserId,()=>null);
  const generation=useSyncExternalStore(subscribeSignedIn,signInGeneration,()=>0);
  const connected=useSyncExternalStore(subscribeOnline,online,()=>false);
  const queryClient=useQueryClient();
  const allowed=enabled && connected && !!owner && validId(projectId) && validId(unitId);
  // A disabled mounted observer can recreate an empty query after removal.
  // Its anonymous key must not retain the former owner or source identities.
  const key=useMemo(()=>["workUnitFactCurrent",allowed?owner:null,allowed?generation:0,allowed?projectId:null,allowed?unitId:null],[owner,generation,projectId,unitId,allowed]);
  const query=useQuery({queryKey:key,queryFn:async()=>{
    try { return {status:"ready" as const,snapshot:await fetchUnitFactSnapshot(unitId!,{userId:owner,generation})}; }
    // A failed fresh read replaces earlier private details with an explicit
    // unavailable state. It never means that no measurements were recorded.
    catch { return {status:"unavailable" as const}; }
  },enabled:allowed,retry:false,staleTime:0,gcTime:0,refetchOnWindowFocus:"always",refetchOnReconnect:"always"});
  useEffect(()=>{
    const clear=()=>{
      void queryClient.cancelQueries({queryKey:key,exact:true});
      queryClient.removeQueries({queryKey:key,exact:true});
    };
    if (!allowed) { clear(); return; }
    return clear;
  },[queryClient,key,allowed]);
  return { state: !allowed ? "blocked" as const : query.isPending ? "loading" as const : query.isError || query.data?.status === "unavailable" ? "unavailable" as const : "ready" as const,
    snapshot:allowed && !query.isError && query.data?.status === "ready" ? query.data.snapshot : undefined,
    refresh:()=>allowed ? query.refetch() : Promise.resolve(undefined) };
}
