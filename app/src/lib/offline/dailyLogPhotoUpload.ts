// Immutable daily-log uploads. Never use the generic gallery schema fallbacks.
import type { OutboxClient } from './outboxHandlers';
import type { OutboxEntry, OpHandler } from './outbox-core';
import { readPhotoBytes } from './readPhotoBytes';

const PHOTO_COLUMNS = 'id,client_id,project_id,daily_log_id,storage_path,kind';
function aborted(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('Upload interrupted','AbortError'); }
function alreadyExists(error: unknown): boolean {
  const e=error as {statusCode?: string|number;message?:string};
  return String(e?.statusCode)==='409' || /already exists|duplicate/i.test(e?.message??'');
}
export async function sendDailyLogPhoto(client: OutboxClient, entry: OutboxEntry, ctx: Parameters<OpHandler>[1]): Promise<void> {
  const p=entry.payload;
  const project=typeof p.projectId==='string'?p.projectId:null;
  const log=typeof p.dailyLogId==='string'?p.dailyLogId:null;
  const path=typeof p.path==='string'?p.path:null;
  if (!entry.ownerId || !project || !log || p.bucket!=='install-media' || p.kind!=='photo' ||
      path!==`${project}/daily-logs/${log}/${entry.ownerId}/${entry.id}.jpg` || p.contentType!=='image/jpeg')
    throw new Error('Daily log photo identity is incomplete; the photo remains on this phone.');
  const storagePath=`install-media/${path}`;
  async function confirmed(): Promise<boolean> {
    const result=await client.from('attachments').select(PHOTO_COLUMNS).eq('client_id',entry.id).maybeSingle();
    if(result.error)throw result.error;
    if(!result.data)return false;
    const a=result.data;
    if(a.client_id!==entry.id || a.daily_log_id!==log || a.storage_path!==storagePath || a.kind!=='photo' ||
       (a.project_id!==project && a.project_id!==null)) throw new Error('This upload ID belongs to a different photo.');
    return true; // Includes confirmed trash/history. Do not rewrite or restore it.
  }
  if(await confirmed())return;
  aborted(ctx.signal);
  const blob=await ctx.getBlob();
  if(!blob || blob.size===0 || blob.size>25*1024*1024)throw new Error('Saved daily log photo is empty or too large.');
  const bytes=await readPhotoBytes(blob,ctx.signal);
  if(bytes.byteLength!==blob.size)throw new Error('Saved daily log photo could not be fully read.');
  aborted(ctx.signal);
  const upload=await client.storage.from('install-media').upload(path,bytes,{contentType:'image/jpeg',upsert:false});
  if(upload.error && !alreadyExists(upload.error))throw upload.error;
  aborted(ctx.signal);
  // The database checks completed object ownership/MIME/size. list()/info()
  // cannot prove ownership. A lost reply is reconciled by the exact row read.
  const result=await client.from('attachments').insert({
    client_id:entry.id,project_id:project,daily_log_id:log,kind:'photo',storage_path:storagePath,
    created_by:typeof p.createdBy==='string'?p.createdBy:null,
    lat:p.lat??null,lng:p.lng??null,accuracy_m:p.accuracyM??null,taken_at:p.takenAt??null,caption:p.caption??null,
  });
  aborted(ctx.signal);
  if(await confirmed())return;
  if(result.error)throw result.error;
  throw new Error('Photo association could not be confirmed; the photo remains on this phone.');
}
