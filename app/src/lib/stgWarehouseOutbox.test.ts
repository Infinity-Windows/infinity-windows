// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(()=>({actor:'partner-a',send:vi.fn()}));
vi.mock('./signedIn',()=>({signedInId:()=>mocks.actor}));
vi.mock('./stgWarehouse',()=>({sendWarehouseCommand:mocks.send}));
import { queuePartnerCommand, readPartnerOutbox, flushPartnerOutbox, retryPartnerCommand } from './stgWarehouseOutbox';
const command={id:'retry-id',project:'shared-job',action:'checkout' as const,input:{packages:['p'],expected:{p:{status:'stored',version:'v1'}}}};
describe('partner warehouse outbox',()=>{
  beforeEach(()=>{localStorage.clear();mocks.actor='partner-a';mocks.send.mockReset();});
  it('persists the original identity and retry key across a lost response',async()=>{
    mocks.send.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({count:1});
    await queuePartnerCommand(command);expect(await flushPartnerOutbox('partner-a')).toBe(0);
    expect(readPartnerOutbox('partner-a')).toHaveLength(1);
    await flushPartnerOutbox('partner-a');
    expect(mocks.send.mock.calls[0][0]).toEqual(mocks.send.mock.calls[1][0]);
    expect(mocks.send.mock.calls[1][0].input.actor).toBe('partner-a');
    expect(readPartnerOutbox('partner-a')).toEqual([]);
  });
  it('never sends another login\'s saved command',async()=>{
    await queuePartnerCommand(command);mocks.actor='partner-b';
    expect(await flushPartnerOutbox('partner-a')).toBe(0);expect(mocks.send).not.toHaveBeenCalled();
    expect(readPartnerOutbox('partner-b')).toEqual([]);
  });
  it('keeps a server refusal for review and does not silently advance the queue',async()=>{
    await queuePartnerCommand(command);await queuePartnerCommand({...command,id:'second'});
    mocks.send.mockRejectedValue({code:'42501',message:'permission denied'});
    await flushPartnerOutbox('partner-a');await flushPartnerOutbox('partner-a');
    expect(mocks.send).toHaveBeenCalledTimes(1);expect(readPartnerOutbox('partner-a')[0].error).toContain('permission');
    retryPartnerCommand('partner-a',command.id);mocks.send.mockResolvedValue({count:1});
    expect(await flushPartnerOutbox('partner-a')).toBe(2);
  });
  it('serializes simultaneous reconnect and retry drains',async()=>{
    await queuePartnerCommand(command);mocks.send.mockResolvedValue({count:1});
    await Promise.all([flushPartnerOutbox('partner-a'),flushPartnerOutbox('partner-a')]);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('does not send if durable storage fails',async()=>{
    const spy=vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw new Error('full');});
    await expect(queuePartnerCommand(command)).rejects.toThrow('full');expect(mocks.send).not.toHaveBeenCalled();spy.mockRestore();
  });
});
