// Boundary mock only. Actual ClockProvider/punch transport is NOT mounted.
import { useSyncExternalStore } from 'react';
import { signInGeneration } from '../../src/lib/signedIn';
const TEST_USER={id:'00000000-0000-4000-8000-0000000000e2'};
const listeners=new Set<()=>void>();let stale=false;
window.addEventListener('fixture-clock-stale',()=>{stale=true;for(const cb of listeners)cb();});
const subscribe=(cb:()=>void)=>{listeners.add(cb);return ()=>{listeners.delete(cb);};};
const observedAt=new Date().toISOString();
const shift={id:'00000000-0000-4000-8000-000000000302',profile_id:TEST_USER.id,project_id:null,cost_code_id:null,status:'open',clock_in_at:new Date(Date.now()-60000).toISOString(),clock_out_at:null,break_seconds:0,break_started_at:null};
export const OPEN_CLOCK_EVENT='infinity:open-clock';
export function openClockGlobally(){const w=window as Window & {__clockDoors?:number};w.__clockDoors=(w.__clockDoors??0)+1;}
export function useClock(){useSyncExternalStore(subscribe,()=>stale);return {loading:false,refresh(){},shift,profileId:TEST_USER.id,isOpen:false,openClock:openClockGlobally,nativeFlow:{ownerId:TEST_USER.id,loginGeneration:signInGeneration(),route:'isolated',nativeRead:'ready',records:[],currentRead:stale?'stale':'ready',canStartDay:false,canRequestSafety:true,current:{kind:'open',observedAt,shift}}};}
