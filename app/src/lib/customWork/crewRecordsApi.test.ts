import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), session: vi.fn(), boundClient: vi.fn() }));
vi.mock("../supabase", () => ({supabase:{rpc:mocks.rpc,auth:{getSession:mocks.session}}, clientWithToken:mocks.boundClient}));
import { rememberSignedIn } from "../signedIn";
import { getStageContributorSummary, sendWorkCommand } from "./api";
beforeEach(() => {vi.clearAllMocks();rememberSignedIn({user:{id:"foreman"}});mocks.boundClient.mockReturnValue({rpc:mocks.rpc});mocks.session.mockResolvedValue({data:{session:{access_token:"foreman-token",user:{id:"foreman"}}},error:null});mocks.rpc.mockResolvedValue({data:"unit",error:null});});
it("routes crew attribution to the atomic RPC without start/finish payroll calls", async () => {
  const data={unit:{id:"unit"},people:["installer"]};
  expect(await sendWorkCommand({id:"retry-id",userId:"foreman",action:"crew_record",data})).toBe("unit");
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("record_crew_work",{p_id:"retry-id",p_data:data});
});
it("rejects syncing another account's attribution",async()=>{
  await expect(sendWorkCommand({id:"r",userId:"other",action:"crew_record",data:{}})).rejects.toThrow("account that recorded");
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("routes the compact contributor action to its own narrow RPC", async () => {
  const data={unit_id:"unit",stage:"RO checked",work_date:"2026-09-29",outcome:"finished",people:["installer"]};
  expect(await sendWorkCommand({id:"retry-id",userId:"foreman",action:"stage_contributors",data})).toBe("unit");
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("record_stage_contributors",{p_id:"retry-id",p_data:data});
});
it("routes a correction to correct_stage_contributors", async () => {
  const data={unit_id:"unit",stage:"RO checked",work_date:"2026-09-29",expected_digest:"abc",reason:"Left early",remove:["installer"]};
  expect(await sendWorkCommand({id:"retry-id",userId:"foreman",action:"correct_stage_contributors",data})).toBe("unit");
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("correct_stage_contributors",{p_id:"retry-id",p_data:data});
});
it("reads the contributor summary", async () => {
  mocks.rpc.mockResolvedValueOnce({data:[{stage:"RO checked",work_date:"2026-09-29",profile_id:"installer",digest:"abc"}],error:null});
  expect(await getStageContributorSummary("unit")).toEqual([{stage:"RO checked",work_date:"2026-09-29",profile_id:"installer",digest:"abc"}]);
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("stage_contributor_summary",{p_unit:"unit"});
});
it("preserves a missing summary RPC as unavailable rather than an empty successful record", async () => {
  mocks.rpc.mockResolvedValueOnce({data:null,error:{code:"PGRST202",message:"function stage_contributor_summary does not exist"}});
  await expect(getStageContributorSummary("unit")).rejects.toMatchObject({ code: "PGRST202" });
});
