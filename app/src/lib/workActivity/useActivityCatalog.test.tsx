// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot,type Root } from 'react-dom/client';
import { QueryClient,QueryClientProvider,onlineManager } from '@tanstack/react-query';
import { beforeEach,afterEach,describe,expect,it,vi } from 'vitest';
import { rememberSignedIn,signInGeneration } from '../signedIn';
import type { ActivityCatalog } from './catalog';
const fetch=vi.fn();vi.mock('./catalogApi',()=>({fetchActivityCatalog:(...args:unknown[])=>fetch(...args)}));
const {useActivityCatalog}=await import('./useActivityCatalog');
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`,ME=id(1),JOB=id(2),OTHER=id(3),UNIT=id(4);
const value:ActivityCatalog={protocolVersion:1,asOf:'2026-10-04T06:00:00.000001Z',availability:'available',projectId:JOB,unit:null,selection:null,totals:{availability:'unavailable',reasonCode:'not_ready'}};
let qc:QueryClient,root:Root,host:HTMLDivElement,connected=true,latest:ReturnType<typeof useActivityCatalog>;
function View({job=JOB,unit=null,enabled=true}:{job?:string;unit?:string|null;enabled?:boolean}){latest=useActivityCatalog(job,unit,enabled);return <div>{latest.state}</div>;}
async function render(props:Parameters<typeof View>[0]={}){await act(async()=>{root.render(<QueryClientProvider client={qc}><View {...props}/></QueryClientProvider>);await new Promise(r=>setTimeout(r,10));});}
async function flush(){await act(async()=>{await new Promise(r=>setTimeout(r,10));});}
beforeEach(()=>{onlineManager.setOnline(true);connected=true;Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>connected});rememberSignedIn({user:{id:ME}});fetch.mockReset().mockResolvedValue(value);qc=new QueryClient({defaultOptions:{queries:{retry:false}}});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());qc.clear();host.remove();rememberSignedIn(null);onlineManager.setOnline(true);delete (navigator as unknown as {onLine?:boolean}).onLine;});
describe('private current job catalog',()=>{
  it('reads exact job/unit and erases the former selection context on navigation',async()=>{await render();await flush();expect(fetch).toHaveBeenCalledWith(JOB,null,{userId:ME,generation:signInGeneration()});await render({unit:UNIT});await flush();expect(fetch).toHaveBeenCalledWith(JOB,UNIT,{userId:ME,generation:signInGeneration()});expect(qc.getQueryCache().getAll()).toHaveLength(1);expect(qc.getQueryCache().getAll()[0].queryKey.at(-1)).toBe(UNIT);await render({job:OTHER});await flush();expect(qc.getQueryCache().getAll().some(q=>q.queryKey.includes(JOB))).toBe(false);});
  it('never keeps prior private choices after a refused refresh, disable, or offline transition',async()=>{await render();await flush();fetch.mockRejectedValue(Error('revoked'));await act(async()=>{await latest.refresh();});await flush();expect(latest.data).toBeUndefined();expect(latest.state).toBe('unavailable');await render({enabled:false});expect(qc.getQueryCache().getAll().filter(q=>q.queryKey.includes(ME)||q.queryKey.includes(JOB)||q.queryKey.includes(UNIT))).toHaveLength(0);expect(qc.getQueryCache().getAll().every(q=>q.state.data===undefined)).toBe(true);fetch.mockResolvedValue(value);await render();await flush();await act(async()=>{connected=false;window.dispatchEvent(new Event('offline'));});await flush();expect(latest.data).toBeUndefined();expect(qc.getQueryCache().getAll().filter(q=>q.queryKey.includes(ME)||q.queryKey.includes(JOB)||q.queryKey.includes(UNIT))).toHaveLength(0);expect(qc.getQueryCache().getAll().every(q=>q.state.data===undefined)).toBe(true);});
  it('does not revive late old job evidence after same-owner login ABA',async()=>{let resolve!:(v:ActivityCatalog)=>void;fetch.mockImplementationOnce(()=>new Promise< ActivityCatalog >(yes=>{resolve=yes;}));await render();const old=signInGeneration();await act(async()=>{rememberSignedIn(null);rememberSignedIn({user:{id:ME}});});await flush();await act(async()=>{resolve({...value,availability:'unavailable',projectId:null});});await flush();expect(latest.data?.value.availability).toBe('available');expect(qc.getQueryCache().getAll().some(q=>q.queryKey.includes(old))).toBe(false);});
  it('blocks malformed job/unit and preview without any RPC',async()=>{await render({job:'opaque'});await render({unit:'opaque'});await render({enabled:false});expect(fetch).not.toHaveBeenCalled();expect(latest.state).toBe('blocked');});
});
