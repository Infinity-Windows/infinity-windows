import {describe,it,expect,vi} from 'vitest';
import {sendDailyLogPhoto} from './dailyLogPhotoUpload';
import type {OutboxClient} from './outboxHandlers';
import type {OutboxEntry,OpHandler} from './outbox-core';
const project='job',log='log',owner='owner',id='operation';
const path=`${project}/daily-logs/${log}/${owner}/${id}.jpg`;
const row={id:'row',client_id:id,project_id:project,daily_log_id:log,storage_path:`install-media/${path}`,kind:'photo'};
function fixture({existing=null,readError=null,uploadError=null,insertError=null,commits=true}: {existing?:unknown;readError?:unknown;uploadError?:unknown;insertError?:unknown;commits?:boolean}={}){
 let saved=existing;
 const upload=vi.fn().mockResolvedValue({error:uploadError});
 const insert=vi.fn().mockImplementation(async()=>{if(commits)saved=row;return {error:insertError};});
 const read=vi.fn().mockImplementation(async()=>({data:saved,error:readError}));
 const query={select:vi.fn(),eq:vi.fn(),maybeSingle:read,insert};query.select.mockReturnValue(query);query.eq.mockReturnValue(query);
 const client={from:vi.fn().mockReturnValue(query),storage:{from:vi.fn().mockReturnValue({upload})}} as unknown as OutboxClient;
 const entry={id,createdAt:0,attemptCount:0,lastError:null,status:'queued',nextAttemptAt:0,ownerId:owner,op:'photo_upload',payload:{projectId:project,dailyLogId:log,bucket:'install-media',path,contentType:'image/jpeg',kind:'photo',createdBy:'owner@test.example'}} as OutboxEntry;
 const getBlob=vi.fn().mockResolvedValue(new Blob(['jpeg'],{type:'image/jpeg'}));
 const ctx={getBlob} as unknown as Parameters<OpHandler>[1];
 return {client,entry,ctx,getBlob,upload,insert,read};
}
describe('immutable daily log photo protocol',()=>{
 it('uploads once without overwrite and confirms exact association',async()=>{const f=fixture();await sendDailyLogPhoto(f.client,f.entry,f.ctx);expect(f.upload).toHaveBeenCalledWith(path,expect.any(ArrayBuffer),{contentType:'image/jpeg',upsert:false});expect(f.insert).toHaveBeenCalledWith(expect.objectContaining({client_id:id,daily_log_id:log,created_by:'owner@test.example'}));});
 it.each([row,{...row,project_id:null}])('lost reply or historical original confirms without any rewrite',async(existing)=>{const f=fixture({existing});await sendDailyLogPhoto(f.client,f.entry,f.ctx);expect(f.upload).not.toHaveBeenCalled();expect(f.insert).not.toHaveBeenCalled();expect(f.getBlob).not.toHaveBeenCalled();});
 it('already-existing immutable object may associate through server ownership guard',async()=>{const f=fixture({uploadError:{statusCode:'409',message:'Already exists'}});await sendDailyLogPhoto(f.client,f.entry,f.ctx);expect(f.insert).toHaveBeenCalledTimes(1);});
 it('lost association response confirms the committed exact row',async()=>{const f=fixture({insertError:new TypeError('Network lost')});await sendDailyLogPhoto(f.client,f.entry,f.ctx);expect(f.read).toHaveBeenCalledTimes(2);});
 it.each(['client_id','daily_log_id','storage_path','kind','project_id'])('conflicting %s never acknowledges or overwrites',async(field)=>{const f=fixture({existing:{...row,[field]:'foreign'}});await expect(sendDailyLogPhoto(f.client,f.entry,f.ctx)).rejects.toThrow('different photo');expect(f.upload).not.toHaveBeenCalled();expect(f.insert).not.toHaveBeenCalled();});
 it('unknown read refuses before touching object',async()=>{const f=fixture({readError:new Error('Cannot verify')});await expect(sendDailyLogPhoto(f.client,f.entry,f.ctx)).rejects.toThrow('Cannot verify');expect(f.upload).not.toHaveBeenCalled();});
 it('missing association schema never peels off the log tag',async()=>{const f=fixture({insertError:{code:'42703',message:'daily_log_id missing'},commits:false});await expect(sendDailyLogPhoto(f.client,f.entry,f.ctx)).rejects.toMatchObject({code:'42703'});expect(f.insert).toHaveBeenCalledTimes(1);expect(f.insert.mock.calls[0][0].daily_log_id).toBe(log);});
 it('unconfirmed successful response retains upload for retry',async()=>{const f=fixture({commits:false});await expect(sendDailyLogPhoto(f.client,f.entry,f.ctx)).rejects.toThrow('could not be confirmed');});
 it('server refusal on foreign object never becomes success',async()=>{const f=fixture({uploadError:{statusCode:409},insertError:new Error('Original JPEG required'),commits:false});await expect(sendDailyLogPhoto(f.client,f.entry,f.ctx)).rejects.toThrow('Original JPEG');});
 it('malformed filename or owner refuses before any network',async()=>{const f=fixture();f.entry.ownerId='other';await expect(sendDailyLogPhoto(f.client,f.entry,f.ctx)).rejects.toThrow('identity');expect(f.read).not.toHaveBeenCalled();});
 it('aborted send leaves object and association alone',async()=>{const f=fixture();const control=new AbortController();control.abort();f.ctx.signal=control.signal;await expect(sendDailyLogPhoto(f.client,f.entry,f.ctx)).rejects.toMatchObject({name:'AbortError'});expect(f.upload).not.toHaveBeenCalled();});
});
