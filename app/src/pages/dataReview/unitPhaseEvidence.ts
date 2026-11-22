import { supabase } from "../../lib/supabase";
import type { UnitPhase } from "./unitOpeningProgress";
export async function readUnitPhases(jobs: string[], signal: AbortSignal) {
 const rows: UnitPhase[] = []; let expected: number | null = null;
 for (let offset = 0;;) {
  const {data,error,count} = await supabase.from("opening_phases").select("id,opening_id,kind,status,started_at,submitted_at,opening:project_openings!inner(project_id)",{count:"exact"}).in("opening.project_id",jobs).order("id").range(offset,offset+499).abortSignal(signal);
  if(error) throw error;
  if(count === null || (expected !== null && expected !== count)) throw new Error("Phase evidence changed while loading.");
  expected=count; const page=(data ?? []) as UnitPhase[]; rows.push(...page);offset+=page.length;
  if(offset === count) return rows;
  if(!page.length) throw new Error("Incomplete phase evidence.");
 }
}
