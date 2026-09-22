// @vitest-environment happy-dom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFocusTrap } from './useFocusTrap';
let root:Root;let host:HTMLDivElement;let opener:HTMLButtonElement;
function Dialog({open=true,onClose}:{open?:boolean;onClose:()=>void}) {
 const ref=useRef<HTMLDivElement>(null);useFocusTrap(ref,open,onClose);
 return open?<div ref={ref}><button>Close</button><input aria-label="Search"/><button>Export</button></div>:null;
}
function setup(onClose:()=>void){
 vi.useFakeTimers();vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>setTimeout(()=>fn(0),1));vi.stubGlobal('cancelAnimationFrame',(id:number)=>clearTimeout(id));
 opener=document.createElement('button');document.body.append(opener);opener.focus();host=document.createElement('div');document.body.append(host);root=createRoot(host);
 act(()=>{root.render(<Dialog onClose={onClose}/>);});act(()=>vi.advanceTimersByTime(2));
}
afterEach(()=>{act(()=>root?.unmount());host?.remove();opener?.remove();vi.useRealTimers();vi.unstubAllGlobals();});
describe('dialog focus lifetime',()=>{
 it('keeps the current input focused across timer renders and uses the latest Escape callback',()=>{
  const old=vi.fn(),latest=vi.fn();setup(old);const input=host.querySelector('input')!;input.focus();
  act(()=>root.render(<Dialog onClose={latest}/>));act(()=>vi.advanceTimersByTime(2));expect(document.activeElement).toBe(input);
  act(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));expect(latest).toHaveBeenCalledOnce();expect(old).not.toHaveBeenCalled();
 });
 it('restores the original opener only on close, without moving the page scroll',()=>{
  setup(()=>{});const restore=vi.spyOn(opener,'focus');host.querySelector('input')!.focus();
  act(()=>root.render(<Dialog onClose={()=>{}}/>));act(()=>vi.advanceTimersByTime(2));expect(restore).not.toHaveBeenCalled();
  act(()=>root.render(<Dialog open={false} onClose={()=>{}}/>));expect(document.activeElement).toBe(opener);expect(restore).toHaveBeenCalledWith({preventScroll:true});
 });
});
