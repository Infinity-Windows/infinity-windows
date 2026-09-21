import { describe,it,expect,vi } from 'vitest';
import { openaiAsk, type OpenAIAskOptions } from '../../../supabase/functions/_shared/openaiAsk.ts';
const call={type:'function_call',call_id:'call1',name:'get_hours',arguments:'{}'};
const finish={type:'message',content:[{type:'output_text',text:'24.5 hours'}]};
const response=(output:unknown[],status='completed')=>new Response(JSON.stringify({status,output,usage:{input_tokens:10,output_tokens:5}}));
const base:OpenAIAskOptions={apiKey:'test-only',model:'gpt-5.6-terra',system:'Follow Forge rules',messages:[{role:'user',content:'Hours?'}],tools:[{name:'get_hours',description:'Read verified hours',input_schema:{type:'object',properties:{}}}],executeTool:async()=>({content:'24.5'})};
describe('OpenAI tool loop',()=>{
 it('executes a real tool contract and retains reasoning without provider storage',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(response([{type:'reasoning',encrypted_content:'opaque'},call])).mockResolvedValueOnce(response([finish]));const executeTool=vi.fn(base.executeTool);
  const result=await openaiAsk({...base,fetcher,executeTool});
  expect(result.text).toBe('24.5 hours');expect(result.usage).toEqual({inputTokens:20,outputTokens:10});expect(executeTool).toHaveBeenCalledWith('get_hours',{});
  const payload=JSON.parse(fetcher.mock.calls[1][1].body);expect(payload.store).toBe(false);expect(payload.input).toContainEqual({type:'reasoning',encrypted_content:'opaque'});expect(payload.input).toContainEqual({type:'function_call_output',call_id:'call1',output:'24.5'});expect(payload.instructions).toBe(base.system);
 });
 it('does not execute a tool on the last allowed round',async()=>{
  const executeTool=vi.fn(base.executeTool);const result=await openaiAsk({...base,maxRounds:1,executeTool,fetcher:vi.fn().mockResolvedValue(response([call]))});expect(result.truncated).toBe(true);expect(executeTool).not.toHaveBeenCalled();
 });
 it('rejects invented tools and invalid JSON without executing',async()=>{
  for(const bad of [{...call,name:'delete_payroll'},{...call,arguments:'not json'}]){
   const fetcher=vi.fn().mockResolvedValueOnce(response([bad])).mockResolvedValueOnce(response([finish]));const executeTool=vi.fn(base.executeTool);await openaiAsk({...base,fetcher,executeTool});expect(executeTool).not.toHaveBeenCalled();
  }
 });
 it('reports usage from successful rounds even when a later request fails',async()=>{
  const onUsage=vi.fn();
  const fetcher=vi.fn().mockResolvedValueOnce(response([call])).mockResolvedValueOnce(new Response('unavailable',{status:503}));
  await expect(openaiAsk({...base,fetcher,onUsage})).rejects.toThrow('failed (503)');
  expect(onUsage).toHaveBeenLastCalledWith({inputTokens:10,outputTokens:5});
 });
 it('does not expose upstream bodies or treat incomplete output as success',async()=>{
  await expect(openaiAsk({...base,fetcher:vi.fn().mockResolvedValue(new Response('secret upstream content',{status:403}))})).rejects.toThrow('failed (403)');
  await expect(openaiAsk({...base,fetcher:vi.fn().mockResolvedValue(response([finish],'incomplete'))})).rejects.toThrow('did not complete');
 });
});
