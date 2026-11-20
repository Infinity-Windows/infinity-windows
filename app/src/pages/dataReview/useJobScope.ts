import { useQuery } from "@tanstack/react-query";
import { listWorkUnits } from "../../lib/customWork/api";
import { readComparisonOpenings } from "./comparisonInventory";
import { readOpeningContexts } from "./openingReviewContext";
import { comparisonSummary } from "./comparisonSummary";
import { reportOwner, reportQueryPolicy } from "./reportQueries";
export type JobScope = { openings:number; installed:number;installedDates?:string[]; area:number; known:number; complete:boolean; unknownStatus:number;unconfirmed?:number; exclusions?: {id:string;code:string;conflict:boolean;unconfirmed?:boolean;reasons:string[];dimensions:string[]}[] };
/** Same inventory/facts cache as the unit table. Dates scope labor, not inventory. */
export function useJobScope(jobs:string[],active:boolean) {
 const owner=reportOwner(), selected=[...new Set(jobs.filter(Boolean))].sort(), enabled=active&&selected.length>0;
 const inventory=useQuery({...reportQueryPolicy,queryKey:["dataReview",owner,"comparisonInventory",selected,"progress-v3-installed-dates"],queryFn:({signal})=>readComparisonOpenings(selected,signal),enabled});
 const units=useQuery({...reportQueryPolicy,queryKey:["dataReview",owner,"units",selected],queryFn:({signal})=>listWorkUnits(undefined,signal,selected),enabled});
 const ids=(inventory.data??[]).map(o=>o.id).sort();
 const contexts=useQuery({...reportQueryPolicy,queryKey:["dataReview",owner,"openingReview",ids.join(","),"taxonomy-v4-catalog-dimensions"],queryFn:({signal})=>readOpeningContexts(ids,signal),enabled:enabled&&ids.length>0});
 const error = [inventory, units, ...(ids.length ? [contexts] : [])].find(query => query.isLoadingError)?.error;
 const loading=enabled&&(inventory.isPending||units.isPending||(ids.length>0&&contexts.isPending));
 const scopes=new Map<string,JobScope>();
 if(enabled&&!loading&&!error) for(const id of selected){
  const openings=(inventory.data??[]).filter(o=>o.project_id===id);
  const summary=comparisonSummary(id,contexts.data??new Map(),units.data??[],[],[]);
  const complete=summary.completeArea&&summary.inventory.length===openings.length;
  scopes.set(id,{openings:openings.length,installed:openings.filter(o=>o.status==="installed").length,installedDates:openings.filter(o=>o.status==="installed"&&o.work_ended_at).map(o=>o.work_ended_at!),area:summary.area,known:summary.areaCount,complete,unconfirmed:summary.inventory.filter(item=>item.unconfirmed).length,exclusions:openings.filter(o=>!summary.inventory.some(item=>item.id===o.id&&item.area!==null&&!item.unconfirmed)).map(o=>{const item=summary.inventory.find(item=>item.id===o.id);return {id:o.id,code:o.opening_code,conflict:item?.conflict??false,unconfirmed:item?.unconfirmed??false,reasons:item?.unconfirmed?["Catalog-linked measurements; unconfirmed for this job",...(item?.areaReasons??[])]:item?.areaReasons.length?item.areaReasons:["Opening context could not be resolved"],dimensions:item?.dimensions??[]};}),unknownStatus:openings.filter(o=>!["installed","planned","assigned"].includes(o.status)&&!o.work_started_at).length});
 }
 return {scopes,loading,error};
}
