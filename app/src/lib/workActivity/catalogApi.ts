import { clientWithToken, supabase } from '../supabase';
import { signInMark, stillSignedInAs, type SignInMark } from '../signedIn';
import { activityUuid } from './protocol';
import { ActivityCatalogUnavailableError, parseActivityCatalog, type ActivityCatalog } from './catalog';

/** Exact job and optional selected unit only, bound to the current login.
 * No management graph, offline cache, or mutation RPC is used. */
export async function fetchActivityCatalog(projectId:string,unitId:string|null,login:SignInMark=signInMark()):Promise<ActivityCatalog>{
  try{
    activityUuid(projectId);if(unitId!==null)activityUuid(unitId);
    const mark={...login},who=mark.userId;
    const allowed=()=>!!who && stillSignedInAs(mark,who) && (typeof navigator==='undefined' || navigator.onLine!==false);
    if(!allowed())throw new ActivityCatalogUnavailableError();
    const {data:auth,error:authError}=await supabase.auth.getSession();
    if(authError || !auth.session?.access_token || auth.session.user.id!==who || !allowed())throw new ActivityCatalogUnavailableError();
    const {data,error}=await clientWithToken(auth.session.access_token).rpc('work_activity_catalog',{p_project_id:projectId,p_unit_id:unitId});
    if(error || !allowed())throw new ActivityCatalogUnavailableError();
    return parseActivityCatalog(data,projectId,unitId);
  }catch{throw new ActivityCatalogUnavailableError();}
}
