import { useCallback } from 'react';
import type { SignInMark } from '../signedIn';
import { fetchActivityCatalog } from './catalogApi';
import { useActivityRead } from './useActivityReads';

/** Private current-job selection material shares the snapshot's login,
 * navigation/offline cleanup. Selected unit is part of the exact query key. */
export function useActivityCatalog(projectId:string|null,unitId:string|null,enabled:boolean){
  const read=useCallback((project:string,mark:SignInMark)=>fetchActivityCatalog(project,unitId,mark),[unitId]);
  return useActivityRead('catalog',projectId,enabled,read,unitId);
}
