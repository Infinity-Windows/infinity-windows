import { supabase } from "../../lib/supabase";
import { canonicalJson, type SignatureV1 } from "../../lib/estimate/signature";
import { isMissingColumn } from "../../lib/schemaErrors";
import { markBase } from "../../lib/install/extract";

export interface ReviewOpening { id: string; project_id: string; opening_code: string; signature: SignatureV1 | null; flag_kind: string | null; status: string; window_type_id?: string | null }
export interface ReviewSpec { planset_id?: string | null; id: string; project_id: string; mark_code: string; width_in: number | null; height_in: number | null; confirmed: boolean; source: string; style: string | null; operation?: string | null; product_line?: string | null; extra?: Record<string, unknown> | null; unit_kind?: string | null; door_kind?: string | null }
export interface ReviewCatalogType { id: string; name: string; category: string | null }
export interface OpeningContext { catalogType?: ReviewCatalogType | null; opening: ReviewOpening; spec: ReviewSpec | null; specConflict: boolean }

export function openingContexts(openings: ReviewOpening[], specs: ReviewSpec[], catalog: ReviewCatalogType[] = []) {
  return new Map(openings.map(opening => {
    const matching = specs.filter(spec => spec.project_id === opening.project_id && spec.mark_code.toUpperCase() === markBase(opening.opening_code).toUpperCase());
    return [opening.id, { opening, catalogType: catalog.find(type => type.id === opening.window_type_id) ?? null, spec: matching.length === 1 ? matching[0] : null, specConflict: matching.length > 1 }];
  }));
}
export function structuralKey(context?: OpeningContext) {
  const signature = context?.opening.signature;
  return signature?.v === 1 && signature.kind && Array.isArray(signature.tiers) ? canonicalJson(signature) : null;
}
export async function readOpeningContexts(ids: string[], signal?: AbortSignal) {
  if (!ids.length) return new Map<string, OpeningContext>();
  const read = async <T,>(table: string, columns: string, field: string, values: string[]) => {
    const rows: T[] = [];
    // Bound URL length as well as PostgREST's row cap.
    for (let chunk = 0; chunk < values.length; chunk += 100) {
      let expected: number | null = null;
      for (let offset = 0; offset < 1000000;) {
        let query = supabase.from(table).select(columns, { count: "exact" }).in(field, values.slice(chunk, chunk + 100)).order("id").range(offset, offset + 499);
        if (signal) query = query.abortSignal(signal);
        const { data, count, error } = await query;
        if (error) throw error;
        if (count === null || (expected !== null && count !== expected)) throw new Error("Opening context changed while loading. Refresh.");
        expected = count;
        const page = (data ?? []) as T[]; rows.push(...page); offset += page.length;
        if (offset === count) break;
        if (!page.length) throw new Error("Opening context is incomplete.");
      }
    }
    if (new Set(rows.map(row => (row as { id: string }).id)).size !== rows.length) throw new Error("Repeated opening context. Refresh.");
    return rows;
  };
  const openings = await read<ReviewOpening>("project_openings", "id,project_id,opening_code,signature,flag_kind,status,window_type_id", "id", ids);
  const projects = [...new Set(openings.map(opening => opening.project_id))];
  const specColumns = "id,project_id,mark_code,width_in,height_in,confirmed,source,style,operation,product_line,extra,planset_id";
  let specs: ReviewSpec[] = [];
  if (projects.length) {
    try { specs = await read<ReviewSpec>("project_mark_specs", `${specColumns},unit_kind,door_kind`, "project_id", projects); }
    catch (error) { if (!isMissingColumn(error)) throw error; specs = await read<ReviewSpec>("project_mark_specs", specColumns, "project_id", projects); }
  }
  const typeIds = [...new Set(openings.map(opening => opening.window_type_id).filter((id): id is string => !!id))];
  const catalog = typeIds.length ? await read<ReviewCatalogType>("window_types", "id,name,category", "id", typeIds) : [];
  return openingContexts(openings, specs, catalog);
}
