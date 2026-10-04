import { beforeEach, describe, expect, it, vi } from 'vitest';
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const ME=id(1),OTHER=id(2),JOB=id(3),UNIT=id(4);
let user:string|null=ME,sessionUser:string|null=ME,generation=0,afterSession:(()=>void)|null=null,afterRpc:(()=>void)|null=null,error:unknown=null;
let response:unknown;const calls:{token:string;name:string;args:unknown}[]=[];
vi.mock('../supabase',()=>({supabase:{auth:{getSession:async()=>{const session=sessionUser?{access_token:'checked-token',user:{id:sessionUser}}:null;afterSession?.();return{data:{session},error:null};}}},clientWithToken:(token:string)=>({rpc:async(name:string,args:unknown)=>{calls.push({token,name,args});afterRpc?.();return{data:response,error};}})}));
vi.mock('../signedIn',()=>({signInMark:()=>({userId:user,generation}),stillSignedInAs:(mark:{userId:string|null;generation:number},who:string)=>mark.userId===who && mark.generation===generation && user===who}));
const {fetchActivityCatalog}=await import('./catalogApi');
beforeEach(()=>{user=ME;sessionUser=ME;generation=0;afterSession=null;afterRpc=null;error=null;calls.length=0;response={protocolVersion:1,asOf:'2026-10-04T06:00:00.000001Z',availability:'available',projectId:JOB,unit:null,selection:null,totals:{availability:'unavailable',reasonCode:'not_ready'}};});
describe('fresh crew catalog transport',()=>{
  it('uses one narrow read RPC and exact checked token/job/optional unit',async()=>{await fetchActivityCatalog(JOB,null);response={...(response as object),availability:'unavailable',projectId:null};await fetchActivityCatalog(JOB,UNIT);expect(calls).toEqual([{token:'checked-token',name:'work_activity_catalog',args:{p_project_id:JOB,p_unit_id:null}},{token:'checked-token',name:'work_activity_catalog',args:{p_project_id:JOB,p_unit_id:UNIT}}]);});
  it('holds a stale login and same-owner ABA at both asynchronous boundaries',async()=>{await expect(fetchActivityCatalog(JOB,null,{userId:ME,generation:1})).rejects.toThrow();afterSession=()=>{generation+=2;};await expect(fetchActivityCatalog(JOB,null)).rejects.toThrow();expect(calls).toHaveLength(0);afterSession=null;afterRpc=()=>{generation+=2;};await expect(fetchActivityCatalog(JOB,null)).rejects.toThrow();});
  it('refuses absent/foreign sessions, malformed IDs, server errors and malformed replies',async()=>{for(const who of [null,OTHER]){sessionUser=who;await expect(fetchActivityCatalog(JOB,null)).rejects.toThrow();}sessionUser=ME;await expect(fetchActivityCatalog('opaque',null)).rejects.toThrow();expect(calls).toHaveLength(0);error={code:'42501'};await expect(fetchActivityCatalog(JOB,null)).rejects.toThrow();error=null;response={};await expect(fetchActivityCatalog(JOB,null)).rejects.toThrow();});
});
