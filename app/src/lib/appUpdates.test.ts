// @vitest-environment happy-dom
import {describe,it,expect,vi} from 'vitest';
vi.mock('./supabase',()=>({supabase:{}}));
import {visibleUpdates,receiptIds,safeUpdateLink,updateRoleRank,readUpdateReceipt,markUpdatesRead,type AppUpdate} from './appUpdates';
const note=(id:string,audience:number[]):AppUpdate=>({id,audience,published_on:'2026-09-21',kind:'fix',title_en:'Title',title_es:'Título',body_en:'Fixed',body_es:'Corregido',href:null});
const rows=[note('2026-09-21-photos',[0,1,2,3]),note('2026-09-21-team-reports',[1,2,3]),note('2026-09-21-leave-review',[2,3]),note('future-build',[0,1,2,3])];
describe('role-specific app improvements',()=>{
 it('keeps higher-role announcements and future-build announcements out of installer views',()=>{expect(visibleUpdates(rows,'installer').map(n=>n.id)).toEqual(['2026-09-21-photos']);});
 it('respects explicit audiences rather than assuming every role inherits every update',()=>{expect(visibleUpdates(rows,'foreman')).toHaveLength(2);expect(visibleUpdates(rows,'owner')).toHaveLength(3);expect(visibleUpdates([note('2026-09-21-photos',[0])],'owner')).toEqual([]);});
 it('fails closed for unknown roles and matches legacy roles',()=>{expect(visibleUpdates(rows,'partner')).toEqual([]);expect(visibleUpdates(rows,null)).toEqual([]);expect(updateRoleRank('admin')).toBe(2);expect(updateRoleRank('lead')).toBe(1);});
 it('handles corrupted read receipts without marking unseen changes as read',()=>{expect(receiptIds('broken')).toEqual([]);expect(receiptIds('{"all":true}')).toEqual([]);expect(receiptIds('["note",4,null]')).toEqual(['note']);});
 it('keeps read receipts separate for people sharing a device',()=>{markUpdatesRead('crew-one',['2026-09-21-photos']);expect(receiptIds(readUpdateReceipt('crew-one'))).toContain('2026-09-21-photos');expect(receiptIds(readUpdateReceipt('crew-two'))).toEqual([]);});
 it('allows only simple internal destinations',()=>{expect(safeUpdateLink('/my-schedule')).toBe('/my-schedule');for(const href of ['//elsewhere.com','https://elsewhere.com','javascript:alert(1)','/\\outside','/path?redirect=bad'])expect(safeUpdateLink(href)).toBeNull();});
});
