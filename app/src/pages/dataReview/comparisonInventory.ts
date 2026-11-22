import { isMissingColumn } from "../../lib/schemaErrors";
import { supabase } from "../../lib/supabase";
import type { ReviewOpening } from "./openingReviewContext";

/** Current job inventory, independent of whether an opening has a timer. */
export async function readComparisonOpenings(jobs: string[], signal?: AbortSignal) {
  if (!jobs.length) return [];
  const rows: ReviewOpening[] = [];
  let expected: number | null = null;
  let extended = true;
  for (let offset = 0; offset < 1000000;) {
    let query = supabase.from("project_openings").select("id,project_id,opening_code,signature,flag_kind,status,window_type_id,needs_flashing,work_started_at,condition" + (extended ? ",ro_check,planset_id,page_number,work_ended_at" : ""), { count: "exact" })
      .in("project_id", jobs).is("removed_at", null).order("id").range(offset, offset + 499);
    if (signal) query = query.abortSignal(signal);
    const { data, count, error } = await query;
    if (error && extended && isMissingColumn(error)) { extended = false; continue; }
    if (error) throw error;
    if (count === null || (expected !== null && expected !== count)) throw new Error("Opening inventory changed while loading. Refresh.");
    expected = count;
    const page = (data ?? []) as unknown as ReviewOpening[];
    rows.push(...page); offset += page.length;
    if (offset === count) {
      if (new Set(rows.map(row => row.id)).size !== count) throw new Error("Repeated opening inventory. Refresh.");
      return rows;
    }
    if (!page.length) throw new Error("Opening inventory is incomplete.");
  }
  throw new Error("Choose fewer jobs to compare.");
}
