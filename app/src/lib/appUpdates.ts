import { supabase } from './supabase';
import { BUILD_ID } from './pwa/buildInfo';

// Only announcements included in THIS client build may appear. A backend-first
// rollout must not advertise a feature the phone has not downloaded yet.
export const INCLUDED_UPDATE_IDS = [
  '2026-09-21-photos', '2026-09-21-voice', '2026-09-21-time-off',
  '2026-09-21-team-reports', '2026-09-21-leave-review',
  '2026-09-22-update-popup', '2026-09-22-ask-text', '2026-09-22-export-scroll',
] as const;
export interface AppUpdate {
  id: string; published_on: string; audience: number[]; kind: 'fix' | 'improvement';
  title_en: string; title_es: string; body_en: string; body_es: string; href: string | null;
}
export function updateRoleRank(role: string | null | undefined): number | null {
  if (role === 'installer') return 0;
  if (role === 'foreman' || role === 'lead') return 1;
  if (role === 'supervisor' || role === 'admin') return 2;
  if (role === 'owner' || role === 'big_boss') return 3;
  return null;
}
export function visibleUpdates(rows: AppUpdate[], role: string | null | undefined): AppUpdate[] {
  const rank = updateRoleRank(role);
  if (rank === null) return [];
  return rows.filter(r => INCLUDED_UPDATE_IDS.includes(r.id as typeof INCLUDED_UPDATE_IDS[number]) && r.audience.includes(rank))
    .sort((a,b) => b.published_on.localeCompare(a.published_on) || a.id.localeCompare(b.id));
}
export const updateBuildReceipt = (buildId = BUILD_ID) => `build:${buildId || 'unversioned'}`;
export async function listAppUpdates(): Promise<{rows: AppUpdate[]; allowed: boolean}> {
  const {data,error} = await supabase.from('app_release_notes')
    .select('id,published_on,audience,kind,title_en,title_es,body_en,body_es,href')
    .in('id', [...INCLUDED_UPDATE_IDS]).order('published_on', {ascending:false});
  if (error) throw error;
  // An empty, role-filtered feed alone does not distinguish another-role
  // release from a partner or revoked account. Do not show those a crew popup.
  const access = await supabase.rpc('can_read_app_update', {p_audience:[0,1,2,3]});
  if (access.error) throw access.error;
  return {rows: data ?? [], allowed: access.data === true};
}
export function safeUpdateLink(href: string | null): string | null {
  return href && /^\/[a-z0-9][a-z0-9/-]*$/.test(href) ? href : null;
}
const EVENT = 'forge-updates-read';
const key = (userId:string) => `forge.updates.read.${userId}`;
const memory = new Map<string,string>();
export function readUpdateReceipt(userId:string): string {
  try { return memory.get(userId) ?? localStorage.getItem(key(userId)) ?? '[]'; }
  catch { return memory.get(userId) ?? '[]'; }
}
export function receiptIds(raw:string): string[] {
  try { const v:unknown = JSON.parse(raw); return Array.isArray(v) ? v.filter((id):id is string => typeof id==='string') : []; }
  catch { return []; }
}
export function markUpdatesRead(userId:string, ids:string[]): void {
  const raw=JSON.stringify([...new Set([...receiptIds(readUpdateReceipt(userId)),...ids])]);
  memory.set(userId,raw);
  try { localStorage.setItem(key(userId),raw); } catch { /* Session dismissal still works when storage is unavailable. */ }
  window.dispatchEvent(new Event(EVENT));
}
export function subscribeUpdateReceipts(callback:()=>void):()=>void {
  const storage=(event:StorageEvent)=>{if(event.key?.startsWith('forge.updates.read.')){memory.delete(event.key.slice('forge.updates.read.'.length));callback();}};
  window.addEventListener(EVENT,callback);window.addEventListener('storage',storage);
  return ()=>{window.removeEventListener(EVENT,callback);window.removeEventListener('storage',storage);};
}
