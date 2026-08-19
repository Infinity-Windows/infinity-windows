// Keeping stored signatures true to their inputs. The PURE planner
// decides what changed; the sync fetches project state, plans, and pushes
// each change through the set_unit_signature RPC (the server re-derives
// the canonical key and validates the shape — a client can never store a
// malformed or mislabeled signature).
//
// Recompute moments (spec: .scratch/signature/spec.md): spec confirm,
// Re-read specs completing, a Studio unit save / catalog link, and a
// trace submit that changes stories. All call syncProjectSignatures,
// fire-and-forget — signature freshness must never block field work.

import {
  buildAuthoredJob,
  buildFitViewJob,
  fitviewCalibration,
  fitviewModel,
  normalizeMarkCode,
  preferModelOutline,
} from "../fitview/adapter";
import { listOpenings, listPlanOutlines, listMarkSpecs } from "../install/api";
import {
  indexSpecsByMark,
  specForOpeningCode,
  type ProjectMarkSpec,
} from "../install/specs";
import { listStudioUnits, specToUnitConfig, type UnitConfig } from "../modelstudio/units";
import { markKeyOf } from "../modelstudio/fromProject";
import { supabase } from "../supabase";
import { computeSignature, type UnitFacts } from "./signature";

export interface SignatureUpdate {
  openingId: string;
  signature: ReturnType<typeof computeSignature>["signature"];
  sigKey: string;
}

/**
 * Catalog beats spec — same priority `config` selection above already
 * uses. A hand-built unit's 3-way control (UnitConfig.insetOutset, #23)
 * writes straight to the config-of-record, so it wins here too; a spec
 * import never sets that field, so it falls straight through to
 * `extra.inset_outset` exactly as before #23 existed.
 */
function insetOutsetOf(
  spec: ProjectMarkSpec | null,
  config: UnitConfig | null,
): UnitFacts["insetOutset"] {
  if (config?.insetOutset === "inset" || config?.insetOutset === "outset") {
    return config.insetOutset;
  }
  const v = (spec?.extra as { inset_outset?: unknown } | null)?.inset_outset;
  return v === "inset" || v === "outset" ? v : null;
}

/**
 * PURE: which openings need their stored signature replaced. Config
 * priority is the pull's exact rule — refined catalog unit for the mark,
 * else the spec row through specToUnitConfig; no config, no signature.
 */
export function planSignatureUpdates(input: {
  openings: { id: string; opening_code: string; sig_key?: string | null }[];
  specs: ProjectMarkSpec[];
  catalogByMark: Map<string, UnitConfig>;
  storyByMark: Map<string, number>;
}): SignatureUpdate[] {
  const specIndex = indexSpecsByMark(input.specs);
  const updates: SignatureUpdate[] = [];
  for (const o of input.openings) {
    const mark = normalizeMarkCode(o.opening_code);
    const spec = specForOpeningCode(specIndex, mark);
    const config =
      input.catalogByMark.get(markKeyOf(mark)) ??
      (spec ? specToUnitConfig(spec) : null);
    if (!config) continue;
    const { signature, sigKey } = computeSignature(config, {
      story: input.storyByMark.get(mark) ?? null,
      insetOutset: insetOutsetOf(spec, config),
    });
    if (sigKey !== o.sig_key) {
      updates.push({ openingId: o.id, signature, sigKey });
    }
  }
  return updates;
}

/** Mark → story from the same job source the map renders (authored trace
 * model when one exists, pin-derived otherwise). */
export function storyByMarkFrom(job: {
  windows: { id: string; story?: number }[];
} | null): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of job?.windows ?? []) {
    m.set(normalizeMarkCode(String(w.id)), w.story ?? 1);
  }
  return m;
}

/**
 * Fetch, plan, push. Fire-and-forget at every call site: returns counts
 * for toasts/logging, never throws (signature freshness must not block
 * field work).
 */
export async function syncProjectSignatures(
  projectId: string,
): Promise<{ updated: number; failed: number }> {
  try {
    const [openings, specs, outlines, units] = await Promise.all([
      listOpenings(projectId),
      listMarkSpecs(projectId),
      listPlanOutlines(projectId),
      listStudioUnits(),
    ]);

    const outline = preferModelOutline(outlines);
    let job: { windows: { id: string; story?: number }[] } | null = null;
    if (outline) {
      const meta = { projectId, projectName: "", projectAddress: null };
      const authored = fitviewModel(outline.features);
      if (authored) {
        job = buildAuthoredJob(authored, meta, openings) as never;
      } else if (Array.isArray(outline.points) && outline.points.length >= 3) {
        job = buildFitViewJob({
          ...meta,
          outline: {
            points: outline.points,
            pageAspect: outline.page_aspect,
            pageNumber: outline.page_number,
          },
          openings,
          specs,
          ...fitviewCalibration(outline.features),
        }) as never;
      }
    }

    const catalogByMark = new Map<string, UnitConfig>();
    for (const u of units) {
      const m = /^(?:Window|Door)\s+([^\s·]+)/.exec(u.name);
      if (m) catalogByMark.set(m[1].toUpperCase(), u.config);
    }

    const updates = planSignatureUpdates({
      openings,
      specs,
      catalogByMark,
      storyByMark: storyByMarkFrom(job),
    });

    let updated = 0;
    let failed = 0;
    for (const u of updates) {
      const { error } = await supabase.rpc("set_unit_signature", {
        p_opening_id: u.openingId,
        p_signature: u.signature,
      });
      if (error) failed += 1;
      else updated += 1;
    }
    return { updated, failed };
  } catch {
    return { updated: 0, failed: 0 };
  }
}
