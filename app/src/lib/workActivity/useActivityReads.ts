import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { signedInUserId, signInGeneration, subscribeSignedIn, type SignInMark } from '../signedIn';
import { fetchActivitySnapshot, fetchActivityUnitBasis } from './api';
import { activityUuid } from './protocol';
const online=()=>typeof navigator==='undefined' || navigator.onLine!==false;
function subscribeOnline(callback:()=>void){
  if(typeof window==='undefined')return()=>{};
  window.addEventListener('online',callback);window.addEventListener('offline',callback);
  return()=>{window.removeEventListener('online',callback);window.removeEventListener('offline',callback);};
}
function validId(value:string|null){try{activityUuid(value);return true;}catch{return false;}}
type ReadResult<T>={status:'ready';requestStartedAt:number;value:T;login:SignInMark}|{status:'unavailable'};
/** Both roots are private (not in the offline query allowlist). Logout, preview,
 * offline and navigation erase them. A failed fresh read replaces old details. */
export function useActivityRead<T>(kind:'snapshot'|'unit'|'catalog',id:string|null,enabled:boolean,read:(id:string,mark:SignInMark)=>Promise<T>,selectedUnitId?:string|null){
  const owner=useSyncExternalStore(subscribeSignedIn,signedInUserId,()=>null);
  const generation=useSyncExternalStore(subscribeSignedIn,signInGeneration,()=>0);
  const connected=useSyncExternalStore(subscribeOnline,online,()=>false),qc=useQueryClient();
  const allowed=enabled && connected && !!owner && validId(id) && (selectedUnitId==null || validId(selectedUnitId));
  // A mounted disabled QueryObserver may recreate an empty cache entry after
  // removeQueries. Give that observer an anonymous key, never the former
  // person's or unit's identity. Cleanup still cancels/removes the old key.
  const key=useMemo(()=>['workActivityPrivate',allowed?owner:null,allowed?generation:0,kind,allowed?id:null,...(selectedUnitId===undefined?[]:[allowed?selectedUnitId:null])],[owner,generation,kind,id,selectedUnitId,allowed]);
  const query=useQuery({queryKey:['workActivityPrivate',allowed?owner:null,allowed?generation:0,kind,allowed?id:null,...(selectedUnitId===undefined?[]:[allowed?selectedUnitId:null])],queryFn:async():Promise<ReadResult<T>>=>{
    const requestStartedAt=performance.now();
    const login={userId:owner,generation};
    try{return {status:'ready' as const,requestStartedAt,value:await read(id!,login),login};}
    catch{return {status:'unavailable' as const};}
  },enabled:allowed,retry:false,staleTime:0,gcTime:0,refetchOnWindowFocus:'always',refetchOnReconnect:'always'});
  useEffect(()=>{
    const clear=()=>{void qc.cancelQueries({queryKey:key,exact:true});qc.removeQueries({queryKey:key,exact:true});};
    if(!allowed){clear();return;}return clear;
  },[qc,key,allowed]);
  const result=query.data;
  const data:{requestStartedAt:number;value:T;login:SignInMark}|undefined=allowed && !query.isError && result?.status==='ready'
    ? {requestStartedAt:result.requestStartedAt,value:result.value,login:result.login}:undefined;
  return {state:!allowed?'blocked' as const:query.isPending?'loading' as const:!data?'unavailable' as const:'ready' as const,
    data,refresh:()=>allowed?query.refetch():Promise.resolve(undefined)};
}
export function useActivitySnapshot(deviceId:string|null,enabled:boolean){return useActivityRead('snapshot',deviceId,enabled,fetchActivitySnapshot);}
export function useActivityUnitBasis(unitId:string|null,enabled:boolean){return useActivityRead('unit',unitId,enabled,fetchActivityUnitBasis);}
