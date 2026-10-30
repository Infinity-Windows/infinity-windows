import { useQuery } from "@tanstack/react-query";
import { UnitRecordCard } from "../../components/install/UnitRecordCard";
import { supabase } from "../../lib/supabase";
import type { OpeningPhase } from "../../lib/install/phases";
import type { ProjectOpening } from "../../lib/install/types";
import { reportOwner, reportQueryPolicy } from "./reportQueries";

/** Existing evidence only: no capture controls or inferred completion. */
export function UnitDocumentation({ opening }: { opening: ProjectOpening }) {
  const phases = useQuery({...reportQueryPolicy,queryKey:["dataReview",reportOwner(),"unitDocumentation",opening.project_id,opening.id],queryFn:async ({signal})=>{
    const {data,error}=await supabase.from("opening_phases").select("*").eq("opening_id",opening.id).abortSignal(signal);
    if(error) throw error;
    return data as OpeningPhase[];
  }});
  const flash = phases.data?.filter(phase=>phase.kind === "flashing").find(phase=>phase.status === "submitted") ?? phases.data?.find(phase=>phase.kind === "flashing") ?? null;
  return <section aria-label="Documentation review" className="unit-documentation-review">
    <details open><summary>Rough-opening checks</summary>
      <dl className="unit-ro-measurements">{(["widths","heights","diagonals"] as const).map(key=>{
        const values=opening.ro_check?.[key]?.map(value=>value!=null&&value!==""?`${value}″`:"--");
        const known=opening.ro_check?.[key]?.some(value=>value!=null&&value!=="");
        return <div key={key}><dt>{key==="widths"?"Width":key==="heights"?"Height":"Diagonals"}</dt><dd data-known={known||undefined}>{values?.length?values.join(" / "):"--"}</dd></div>;
      })}</dl>
      {!!Object.keys(opening.ro_check?.judgments??{}).length&&<dl className="unit-ro-judgments">{Object.entries(opening.ro_check?.judgments??{}).map(([key,value])=><div key={key}><dt data-complete={value==="good"||undefined}>{key.replace(/_/g," ").replace(/^./,letter=>letter.toUpperCase())}</dt><dd data-state={value??"unknown"}>{value==="good"?"✓":value==="bad"?"Needs attention":"--"}</dd></div>)}</dl>}
      {opening.ro_quick_ok&&<div className="unit-ro-quick">Quick fit check <span>✓</span></div>}
      {opening.ro_measured_at&&<small className="unit-ro-date">{new Date(opening.ro_measured_at).toLocaleDateString("en-US",{month:"numeric",day:"numeric"})}</small>}
    </details>
    {phases.isPending ? <p role="status">Loading phase evidence…</p> : phases.error ? <p role="alert">Phase evidence unavailable; this is not a missing-work finding.</p> : <><p>{flash ? `Flashing · ${flash.status}${flash.submitted_at ? ` · ${new Date(flash.submitted_at).toLocaleString()}` : ""}` : "No flashing record found."}</p><UnitRecordCard openingId={opening.id} flashing={flash} initiallyOpen /></>}
  </section>;
}
