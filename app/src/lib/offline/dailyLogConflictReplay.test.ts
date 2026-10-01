// @vitest-environment happy-dom
import {beforeEach,expect,it,vi} from 'vitest';
import {emptyProgressFields} from '../dailyLogStages';
import {loadProgressConflicts,saveProgressConflicts,type DailyLogProgressConflictRecord} from '../dailyLogProgressConflicts';
import type {OutboxEntry,OpHandler} from './outbox-core';
const m=vi.hoisted(()=>({get:vi.fn(),rpc:vi.fn()}));
vi.mock('../supabase',()=>({supabase:{}}));
vi.mock('../dailyLogs',()=>({getDailyLog:m.get,isStaleDailyLogError:(e:{code?:string})=>e?.code==='40001'}));
vi.mock('./dailyLogPhotoUploader',()=>({dailyLogPhotoUploader:vi.fn()}));
const {createSupabaseHandlers,createShiftResolver}=await import('./outboxHandlers');
const fields={...emptyProgressFields(),unitsToday:12,unitsToDate:12,unitsRemaining:2};
const server={id:'log',project_id:'job',log_date:'2026-10-01',revision:2,headline:null,notes:'Windows finished',day_flow:null,reflection:null,weather:null,...fields};
const original:DailyLogProgressConflictRecord={version:1,ownerId:'author',projectId:'job',logDate:'2026-10-01',serverRevision:2,sourceEntryId:'original-entry',conflicts:[{field:'unitsToday',queuedValue:7}],queuedSnapshot:{...fields,unitsToday:7},detectedAt:'2026-10-01'};
function entry():OutboxEntry{return {id:'review-entry',op:'daily_log',ownerId:'author',createdAt:0,attemptCount:0,status:'queued',lastError:null,nextAttemptAt:0,payload:{projectId:'job',logDate:'2026-10-01',baseRevision:2,progressProvided:true,reviewedConflict:JSON.stringify(original),headline:null,notes:'Windows finished',dayFlow:null,reflection:null,weather:null,...fields}};}
function handler(){return createSupabaseHandlers(createShiftResolver(),{rpc:m.rpc} as unknown as Parameters<typeof createSupabaseHandlers>[1]).daily_log!;}
const context={getBlob:async()=>null} as Parameters<OpHandler>[1];
beforeEach(()=>{localStorage.clear();m.get.mockReset();m.rpc.mockReset();m.rpc.mockResolvedValue({data:server,error:null});saveProgressConflicts(original);});
it('confirmed reviewed offline snapshot clears only its exact original record',async()=>{m.get.mockResolvedValue(server);await handler()(entry(),context);expect(loadProgressConflicts('author','job','2026-10-01')).toBeNull();expect(m.rpc.mock.calls[0][1].p_progress_provided).toBe(true);});
it('new conflict arriving during awaited confirmation survives the older replay',async()=>{
 let resolve!:(v:unknown)=>void;m.get.mockResolvedValueOnce(server).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 const sending=handler()(entry(),context);await vi.waitFor(()=>expect(m.get).toHaveBeenCalledTimes(2));
 const newer={...original,sourceEntryId:'newer-entry',detectedAt:'later',queuedSnapshot:{...fields,unitsToday:99}};saveProgressConflicts(newer);resolve(server);await sending;
 expect(loadProgressConflicts('author','job','2026-10-01')).toEqual(newer);
});
it('changed server revision keeps restored snapshot and original conflict for fresh review',async()=>{
 m.get.mockResolvedValue({...server,revision:3,unitsToday:44});
 await expect(handler()(entry(),context)).rejects.toThrow('Review');
 expect(m.rpc).not.toHaveBeenCalled();expect(loadProgressConflicts('author','job','2026-10-01')).toEqual(original);
});
