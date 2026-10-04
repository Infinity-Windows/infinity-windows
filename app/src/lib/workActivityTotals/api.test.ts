import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSignedIn, signInMark } from "../signedIn";
const transport = vi.hoisted(() => ({ rpc: vi.fn(), session: vi.fn(), client: vi.fn() }));
vi.mock("../supabase", () => ({ supabase: { auth: { getSession: transport.session } }, clientWithToken: transport.client }));
import { fetchActivityTotals } from "./api";
import { TotalsUnavailableError } from "./protocol";
const OWNER="00000000-0000-4000-8000-000000250001", PROJECT="00000000-0000-4000-8000-000000250010", UNIT="00000000-0000-4000-8000-000000250020";
const unavailable={protocolVersion:1,availability:"unavailable",totals:null};
const session=()=>({data:{session:{access_token:"fixture-checked-token",user:{id:OWNER}}},error:null});
function held<T>() { let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {resolve,promise}; }
beforeEach(()=>{ rememberSignedIn({user:{id:OWNER}});vi.stubGlobal("navigator",{onLine:true}); transport.rpc.mockReset().mockResolvedValue({data:unavailable,error:null});transport.session.mockReset().mockResolvedValue(session());transport.client.mockReset().mockReturnValue({rpc:transport.rpc}); });
afterEach(()=>{rememberSignedIn(null);vi.unstubAllGlobals();});
describe("fresh read-only totals transport",()=>{
 it("keeps unavailable distinct from zero and sends only exact scope with checked token",async()=>{
  expect(await fetchActivityTotals(PROJECT,UNIT)).toEqual(unavailable);
  expect(transport.client).toHaveBeenCalledWith("fixture-checked-token");
  expect(transport.rpc).toHaveBeenCalledOnce(); expect(transport.rpc).toHaveBeenCalledWith("work_activity_totals_read",{p_project_id:PROJECT,p_unit_id:UNIT});
 });
 it("general selection passes null rather than inventing a unit",async()=>{
  await fetchActivityTotals(PROJECT,null);expect(transport.rpc).toHaveBeenCalledWith("work_activity_totals_read",{p_project_id:PROJECT,p_unit_id:null});
 });
 it.each(["offline","preview","invalid scope"])("refuses %s before session or RPC",async kind=>{
  if(kind==="offline")vi.stubGlobal("navigator",{onLine:false});
  await expect(fetchActivityTotals(kind==="invalid scope"?"bad":PROJECT,UNIT,signInMark(),()=>kind!=="preview")).rejects.toThrow(TotalsUnavailableError);
  expect(transport.session).not.toHaveBeenCalled();expect(transport.rpc).not.toHaveBeenCalled();
 });
 it.each(["owner ABA","preview ABA","offline","foreign session"])("fences %s across held token refresh",async kind=>{
  const token=held<ReturnType<typeof session>>();let admitted=true;transport.session.mockReturnValueOnce(token.promise);
  const read=fetchActivityTotals(PROJECT,UNIT,signInMark(),()=>admitted);
  if(kind==="owner ABA"){rememberSignedIn(null);rememberSignedIn({user:{id:OWNER}});}
  if(kind==="preview ABA")admitted=false;
  if(kind==="offline")vi.stubGlobal("navigator",{onLine:false});
  const reply=session();if(kind==="foreign session")reply.data.session.user.id=UNIT;token.resolve(reply);
  await expect(read).rejects.toThrow(TotalsUnavailableError);expect(transport.rpc).not.toHaveBeenCalled();
 });
 it.each(["owner ABA","scope lifetime","offline","malformed","network"])("drops late %s without cached fallback or repeat RPC",async kind=>{
  const response=held<{data:unknown,error:unknown}>();let admitted=true;transport.rpc.mockReturnValueOnce(response.promise);
  const read=fetchActivityTotals(PROJECT,UNIT,signInMark(),()=>admitted);await vi.waitFor(()=>expect(transport.rpc).toHaveBeenCalledOnce());
  if(kind==="owner ABA"){rememberSignedIn(null);rememberSignedIn({user:{id:OWNER}});}
  if(kind==="scope lifetime")admitted=false;
  if(kind==="offline")vi.stubGlobal("navigator",{onLine:false});
  response.resolve({data:kind==="malformed"?{...unavailable,totals:0}:unavailable,error:kind==="network"?{code:"NETWORK"}:null});
  await expect(read).rejects.toThrow(TotalsUnavailableError);expect(transport.rpc).toHaveBeenCalledOnce();
 });
});
