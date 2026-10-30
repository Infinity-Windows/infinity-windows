import type { ActivityRow } from "./activityRows";
import { workAttribution } from "./workAttribution";
export interface OpeningCandidate {id:string;jobId:string;label:string;category?:string|null;material?:string;floor?:string;width?:number|null;height?:number|null}
const mark=(value:string)=>value.trim().toUpperCase().replace(/[–—]/g,"-").replace(/[^A-Z0-9-]/g,"");
const family=(value:string)=>value.trim().replace(/^#\s*/,"").match(/^\d+/)?.[0];
export function possibleOpenings(row:ActivityRow, openings:OpeningCandidate[]) {
 return openings.filter(opening=>!!row.jobId && opening.jobId===row.jobId).flatMap(opening=>{
  const reasons:string[]=[],conflicts:string[]=[];let score=0;
  if(row.openingId===opening.id){reasons.push("Existing opening reference");score+=8;}
  if(mark(row.unit) && mark(row.unit)===mark(opening.label)){reasons.push("Same normalized mark");score+=4;}
  else if(family(row.unit) && family(row.unit)===family(opening.label)){reasons.push("Same numbered mark family · instance unverified");score+=2;}
  const width=row.unitFacts?.dimensionConflict ? null : row.unitFacts?.width,height=row.unitFacts?.dimensionConflict ? null : row.unitFacts?.height;
  if(width && height && opening.width && opening.height){if(Math.abs(width-opening.width)<.125 && Math.abs(height-opening.height)<.125){reasons.push("Dimensions agree within ⅛ in");score+=4;}else conflicts.push("Dimensions disagree");}
  if(!score)return [];
  if(row.category && opening.category){if(row.category===opening.category)reasons.push("Category agrees");else conflicts.push("Category differs or is conflicted");}
  if(row.material && opening.material && !/unknown|conflict/i.test(row.material+opening.material)){if(row.material===opening.material)reasons.push("Material agrees");else conflicts.push("Material differs");}
  return [{...opening,reasons,conflicts,score}];
 }).sort((a,b)=>b.score-a.score || a.label.localeCompare(b.label,undefined,{numeric:true})).slice(0,6);
}
export function reviewQueue(rows:ActivityRow[]) {
 return [...new Map(rows.filter(row=>row.reviewReason || workAttribution(row)==="Missing attribution").map(row=>[row.id,row])).values()].map(row=>({row,reason:row.reviewReason ?? (row.unitFacts?.linkConflict ? "Conflicting job/opening reference" : !row.jobId ? "Missing job reference" : "Missing physical opening reference"),overlaps:rows.filter(other=>other.id!==row.id && row.seconds>0 && other.seconds>0 && !!row.personId && other.personId===row.personId && Date.parse(other.started)<Date.parse(row.ended) && Date.parse(row.started)<Date.parse(other.ended))}));
}
