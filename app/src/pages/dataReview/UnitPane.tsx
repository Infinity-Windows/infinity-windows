import { X } from "lucide-react";
import { UnitDocumentation } from "./UnitDocumentation";
import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { listOpeningInstallEvents } from "../../lib/install/record";
import type { ProjectOpening } from "../../lib/install/types";
import { reportOwner, reportQueryPolicy } from "./reportQueries";
import { UnitDetailCard } from "./UnitDetailCard";
import { UnitWorkflow } from "./UnitWorkflow";

/** Read-only unit reference pane. Additional evidence loads only while mounted. */
export function UnitPane({ onClose, ...unit }: ComponentProps<typeof UnitDetailCard> & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const owner = reportOwner();
  const evidence = useQuery({ ...reportQueryPolicy, queryKey:["dataReview",owner,"unitWorkflow-details-v2",unit.opening.project_id,unit.opening.id], queryFn:async ({signal}) => {
    const {data,error} = await supabase.from("project_openings").select("*,window_types(*)").eq("id",unit.opening.id).eq("project_id",unit.opening.project_id).abortSignal(signal).single();
    if(error) throw error;
    const events = await listOpeningInstallEvents(unit.opening.id);
    const latest = events.filter(event => !event.voided_at).at(-1);
    let photos = 0;
    if(latest) {
      const result = await supabase.from("attachments").select("id",{count:"exact",head:true}).eq("install_event_id",latest.id).eq("kind","photo").abortSignal(signal);
      if(result.error) throw result.error;
      if(result.count == null) throw new Error("Photo evidence unavailable");
      photos=result.count;
    }
    const opening = data as ProjectOpening;
    let inventory: {status:string;window_type_id:string} | null = null;
    if(opening.assigned_window_id) {
      const result = await supabase.from("windows").select("status,window_type_id").eq("id",opening.assigned_window_id).abortSignal(signal).maybeSingle();
      if(result.error) throw result.error;
      inventory=result.data;
    }
    return {opening,events,photos,inventory};
  }});
  useLayoutEffect(() => {
    const pane=dialog.current;
    if(!pane)return;
    const focused=document.activeElement as HTMLElement|null;
    const position={x:window.scrollX,y:window.scrollY};
    const ancestors: {node:HTMLElement;overflow:string;top:number;left:number}[]=[];
    for(let node=pane.parentElement;node;node=node.parentElement){
      ancestors.push({node,overflow:node.style.overflow,top:node.scrollTop,left:node.scrollLeft});
      node.style.overflow="hidden";
    }
    const restorePosition=()=>{for(const saved of ancestors){saved.node.scrollTop=saved.top;saved.node.scrollLeft=saved.left;}window.scrollTo(position.x,position.y);};
    pane.showModal();
    pane.querySelector<HTMLButtonElement>(".unit-pane-close")?.focus({preventScroll:true});
    restorePosition();
    const blockOutside=(event:WheelEvent|TouchEvent)=>{if(!pane.contains(event.target as Node))event.preventDefault();};
    document.addEventListener("wheel",blockOutside,{passive:false});
    document.addEventListener("touchmove",blockOutside,{passive:false});
    return()=>{
      document.removeEventListener("wheel",blockOutside);
      document.removeEventListener("touchmove",blockOutside);
      if(pane.open)pane.close();
      for(const saved of ancestors)saved.node.style.overflow=saved.overflow;
      focused?.focus({preventScroll:true});
      restorePosition();
      requestAnimationFrame(restorePosition);
    };
  }, []);
  const workflow = evidence.isPending ? <p role="status">Loading workflow evidence…</p> : evidence.error ? <p role="alert">Workflow evidence unavailable. Missing reads are not unfinished work.</p> : <UnitWorkflow {...evidence.data} phases={unit.phases} width={unit.conflict ? null : unit.facts.width} height={unit.conflict ? null : unit.facts.height} />;
  return <dialog ref={dialog} className="report-unit-dialog unit-reference-pane" onCancel={event=>{event.preventDefault();onClose();}} aria-label={`Unit ${unit.opening.opening_code}`}>
    <div className="unit-pane-toolbar"><button type="button" className="unit-pane-close" aria-label="Close unit" onClick={onClose}><X size={20} aria-hidden="true"/></button></div><div className="unit-pane-content">
    <UnitDetailCard {...unit} dbOpening={evidence.data?.opening} workflow={workflow} />
    <details><summary>Documentation</summary>{evidence.data ? <UnitDocumentation opening={evidence.data.opening}/> : <p role="status">Loading evidence…</p>}</details>
    <nav className="unit-reference-links" aria-label="Unit references"><h4>References</h4><a href={`/projects/${unit.opening.project_id}`} target="_blank" rel="noreferrer">Job · {unit.job}</a><a href={`/projects/${unit.opening.project_id}/opening/${unit.opening.id}`} target="_blank" rel="noreferrer">Operational unit screen · checks and workflow</a><a href={`/projects/${unit.opening.project_id}/map`} target="_blank" rel="noreferrer">Job plans and opening map</a>{evidence.data?.opening.assigned_window_id && <p>Assigned inventory unit · {evidence.data.opening.assigned_window_id}</p>}</nav>

    </div>
  </dialog>;
}
