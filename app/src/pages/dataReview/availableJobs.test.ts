import {it,expect,vi} from "vitest";
vi.mock("../../lib/supabase",()=>({supabase:{from:vi.fn()}}));
import {supabase} from "../../lib/supabase";
import {readAvailableJobs,includedJobs} from "./availableJobs";
it("discovers job references across clocked, custom, opening timers and phases with bounded reads",async()=>{
 const queries:any[]=[];
 vi.mocked(supabase.from).mockImplementation((table:string)=>{
  const data=table==="time_shifts"?[{id:"a",project_id:"clocked"}]:table==="custom_work_sessions"?[{id:"b",unit:{project_id:"unit-job"}}]:table==="unit_sessions"?[{id:"c",opening:{project_id:"opening-job"}}]:[{id:"d",opening:{project_id:"phase-job"}}];
  const q:any={then:(resolve:any)=>resolve({data,count:1,error:null})};
  for(const method of ["select","order","range","lt","or","is","neq","abortSignal"])q[method]=vi.fn(()=>q);
  queries.push(q);return q;
 });
 expect(await readAvailableJobs(0,86400000)).toEqual(["clocked","opening-job","phase-job","unit-job"]);
 for(const q of queries){expect(q.lt).toHaveBeenCalled();expect(q.or).toHaveBeenCalled();}
 expect(includedJobs(["a","b"],null)).toEqual(["a","b"]);
 expect(includedJobs(["a","b"],["b","stale"])).toEqual(["b"]);
});
it("fails visibly on incomplete discovery instead of presenting a partial job list",async()=>{
 const q:any={then:(resolve:any)=>resolve({data:[],count:1,error:null})};
 for(const method of ["select","order","range","is","neq"])q[method]=()=>q;
 vi.mocked(supabase.from).mockReturnValue(q);
 await expect(readAvailableJobs(-Infinity,Infinity)).rejects.toThrow("completely");
});
