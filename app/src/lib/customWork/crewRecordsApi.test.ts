import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), session: vi.fn() }));
vi.mock("../supabase", () => ({supabase:{rpc:mocks.rpc,auth:{getSession:mocks.session}}}));
import { sendWorkCommand } from "./api";
beforeEach(() => {vi.clearAllMocks();mocks.session.mockResolvedValue({data:{session:{user:{id:"foreman"}}},error:null});mocks.rpc.mockResolvedValue({data:"unit",error:null});});
it("routes crew attribution to the atomic RPC without start/finish payroll calls", async () => {
  const data={unit:{id:"unit"},people:["installer"]};
  expect(await sendWorkCommand({id:"retry-id",userId:"foreman",action:"crew_record",data})).toBe("unit");
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("record_crew_work",{p_id:"retry-id",p_data:data});
});
it("rejects syncing another account's attribution",async()=>{
  await expect(sendWorkCommand({id:"r",userId:"other",action:"crew_record",data:{}})).rejects.toThrow("account that recorded");
  expect(mocks.rpc).not.toHaveBeenCalled();
});
