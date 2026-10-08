// @vitest-environment happy-dom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFocusTrap } from './useFocusTrap';
let root:Root;let host:HTMLDivElement;let opener:HTMLButtonElement;
const extra:HTMLElement[]=[];
const flush=()=>act(()=>vi.advanceTimersByTime(2));
function button(key?:string){const value=document.createElement('button');if(key)value.dataset.focusReturnKey=key;document.body.append(value);extra.push(value);return value;}
function Dialog({open=true,onClose,canRestore,fallback}:{open?:boolean;onClose:()=>void;canRestore?:()=>boolean;fallback?:()=>HTMLElement|null}) {
 const ref=useRef<HTMLDivElement>(null);useFocusTrap(ref,open,onClose,{canRestore,fallback});
 return open?<div ref={ref}><button>Close</button><input aria-label="Search"/><button>Export</button></div>:null;
}
function setup(onClose:()=>void){
 vi.useFakeTimers();vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>setTimeout(()=>fn(0),1));vi.stubGlobal('cancelAnimationFrame',(id:number)=>clearTimeout(id));
 opener=document.createElement('button');document.body.append(opener);opener.focus();host=document.createElement('div');document.body.append(host);root=createRoot(host);
 act(()=>{root.render(<Dialog onClose={onClose}/>);});act(()=>vi.advanceTimersByTime(2));
}
afterEach(()=>{act(()=>root?.unmount());host?.remove();opener?.remove();for(const el of extra.splice(0))el.remove();vi.useRealTimers();vi.unstubAllGlobals();});
describe('dialog focus lifetime',()=>{
 it('keeps the current input focused across timer renders and uses the latest Escape callback',()=>{
  const old=vi.fn(),latest=vi.fn();setup(old);const input=host.querySelector('input')!;input.focus();
  act(()=>root.render(<Dialog onClose={latest}/>));act(()=>vi.advanceTimersByTime(2));expect(document.activeElement).toBe(input);
  act(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));expect(latest).toHaveBeenCalledOnce();expect(old).not.toHaveBeenCalled();
 });
 it('restores the original opener only on close, without moving the page scroll',()=>{
  setup(()=>{});const restore=vi.spyOn(opener,'focus');host.querySelector('input')!.focus();
  act(()=>root.render(<Dialog onClose={()=>{}}/>));act(()=>vi.advanceTimersByTime(2));expect(restore).not.toHaveBeenCalled();
  act(()=>root.render(<Dialog open={false} onClose={()=>{}}/>));flush();expect(document.activeElement).toBe(opener);expect(restore).toHaveBeenCalledWith({preventScroll:true});
 });
 it('restores only a visible exact-key replacement after its opener is detached',()=>{
  setup(()=>{});opener.dataset.focusReturnKey='owner:login:shift';
  // Reopen so this lifetime captures the explicit identity.
  act(()=>root.render(<Dialog open={false} onClose={()=>{}}/>));flush();opener.focus();
  act(()=>root.render(<Dialog onClose={()=>{}}/>));flush();
  const replacement=button('owner:login:shift'),other=button('another-owner:login:shift');
  const hidden=button('owner:login:shift');hidden.hidden=true;opener.remove();
  act(()=>root.render(<Dialog open={false} onClose={()=>{}}/>));flush();
  expect(document.activeElement).toBe(replacement);expect(document.activeElement).not.toBe(other);
 });
 it('uses a stable fallback when the launcher is gone or exact replacement is ambiguous',()=>{
  setup(()=>{});act(()=>root.render(<Dialog open={false} onClose={()=>{}}/>));flush();
  opener.dataset.focusReturnKey='owner:login:shift';opener.focus();
  const main=document.createElement('main');document.body.append(main);extra.push(main);
  act(()=>root.render(<Dialog onClose={()=>{}} fallback={()=>main}/>));flush();opener.remove();
  button('owner:login:shift');button('owner:login:shift');
  act(()=>root.render(<Dialog open={false} onClose={()=>{}}/>));flush();
  expect(document.activeElement).toBe(main);expect(main.tabIndex).toBe(-1);
  const next=button();next.focus();expect(main.hasAttribute('tabindex')).toBe(false);
 });
 it('does not restore to a hidden or disabled replacement or a different identity',()=>{
  setup(()=>{});act(()=>root.render(<Dialog open={false} onClose={()=>{}}/>));flush();
  opener.dataset.focusReturnKey='owner:login:shift';opener.focus();act(()=>root.render(<Dialog onClose={()=>{}}/>));flush();
  opener.remove();const disabled=button('owner:login:shift');disabled.disabled=true;
  const hidden=button('owner:login:shift');hidden.style.display='none';button('other-owner:login:shift');
  act(()=>root.render(<Dialog open={false} onClose={()=>{}}/>));flush();expect(document.activeElement).toBe(document.body);
 });
 it('preserves a deliberate live focus choice made before deferred restoration',()=>{
  setup(()=>{});const chosen=button();
  act(()=>root.render(<Dialog open={false} onClose={()=>{}}/>));chosen.focus();flush();expect(document.activeElement).toBe(chosen);
 });
 it('checks the opening generation guard at restoration, not the last timer render',()=>{
  setup(()=>{});act(()=>root.render(<Dialog open={false} onClose={()=>{}}/>));flush();let sameLogin=true;opener.focus();
  act(()=>root.render(<Dialog onClose={()=>{}} canRestore={()=>sameLogin}/>));flush();
  act(()=>root.render(<Dialog onClose={()=>{}} canRestore={()=>true}/>));sameLogin=false;
  act(()=>root.render(<Dialog open={false} onClose={()=>{}}/>));flush();expect(document.activeElement).toBe(document.body);
 });
 it('lets only the top nested trap handle Escape and restores inside its surviving parent',()=>{
  setup(()=>{});const parentClose=vi.fn(),childClose=vi.fn();
  function Nested({child}:{child:boolean}){const ref=useRef<HTMLDivElement>(null);useFocusTrap(ref,true,parentClose);return <div ref={ref}><button>Parent</button>{child&&<Dialog onClose={childClose}/>}</div>;}
  act(()=>root.render(<Nested child={false}/>));flush();const parent=host.querySelector('button')!;parent.focus();
  act(()=>root.render(<Nested child/>));flush();
  act(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  expect(childClose).toHaveBeenCalledOnce();expect(parentClose).not.toHaveBeenCalled();
  act(()=>root.render(<Nested child={false}/>));flush();expect(document.activeElement).toBe(parent);
 });
 it('an older trap unmount cannot steal focus from a newer surviving dialog',()=>{
  setup(()=>{});
  function Pair({older}:{older:boolean}){return <>{older&&<Dialog key="older" onClose={()=>{}}/>}<Dialog key="newer" onClose={()=>{}}/></>;}
  act(()=>root.render(<Pair older/>));flush();const newest=host.querySelectorAll('input')[1];newest.focus();
  act(()=>root.render(<Pair older={false}/>));flush();expect(document.activeElement).toBe(newest);
 });
 it('cancels obsolete restoration when another dialog opens before its frame runs',()=>{
  setup(()=>{});const restore=vi.spyOn(opener,'focus');
  act(()=>root.render(<Dialog open={false} onClose={()=>{}}/>));
  act(()=>root.render(<Dialog key="new" onClose={()=>{}}/>));flush();
  expect(restore).not.toHaveBeenCalled();expect(document.activeElement).toBe(host.querySelector('button'));
 });

 it('keeps a simultaneously mounted nested child above its containing parent',()=>{
  setup(()=>{});const parentClose=vi.fn(),childClose=vi.fn();
  function Nested(){const ref=useRef<HTMLDivElement>(null);useFocusTrap(ref,true,parentClose);return <div ref={ref}><button>Parent</button><Dialog onClose={childClose}/></div>;}
  act(()=>root.render(<Nested/>));flush();
  expect(document.activeElement).toBe(host.querySelectorAll('button')[1]);
  act(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  expect(childClose).toHaveBeenCalledOnce();expect(parentClose).not.toHaveBeenCalled();
 });

});
