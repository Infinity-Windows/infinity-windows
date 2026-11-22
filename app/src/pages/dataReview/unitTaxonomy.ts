import type { WorkUnit } from "../../lib/customWork/model";
import { unitKindFromDescription } from "../../lib/install/specKinds.mjs";
import type { OpeningContext } from "./openingReviewContext";
export type FactEvidence = { source: string; raw: string; value: string | null };
export type ResolvedClassification = { value: string | null; status: "known" | "unknown" | "conflict"; evidence: FactEvidence[] };
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const title = (value: string) => value.replace(/(^|[ -])\S/g, letter => letter.toUpperCase());
const kind = (value: unknown) => { const raw = text(value); if (/\bcombination assembly\b/i.test(raw)) return "Combination assembly"; const result = unitKindFromDescription(raw); return result === "window" ? "Window" : result === "door" ? "Door" : null; };
function subtype(value: string, category: string | null) {
  if (!value) return null;
  const found = [
    [/\b(fixed|picture)\b/i, "Fixed"], [/\bcasement\b/i, "Casement"], [/\bawning\b/i, "Awning"],
    [/\b(slid(?:er|ing)?(?:x\d+)?|horizontal slider)\b/i, "Sliding"], [/\bbi[ -]?fold(?:ing)?\b/i, "Folding"],
    [/\b(?:single[ -]?hung|double[ -]?hung|hung)\b/i, "Hung"], [/\b(?:pivot|french|inward opening|outward opening|hinged?|swing)\b/i, "Hinged"],
  ].filter(([pattern]) => (pattern as RegExp).test(value)).map(([, label]) => label as string);
  const moving = [...new Set(found.filter(label => label !== "Fixed"))];
  if (moving.length > 1) return "Mixed mechanisms";
  if (moving.length) return category === "Door" && moving[0] === "Casement" ? "Hinged" : moving[0];
  if (found.length) return "Fixed";
  return /^(?=.*x)(?=.*o)[xo\s/-]+$/i.test(value) ? "Sliding" : null;
}
const material = (raw: string, explicit: boolean) => {
  const found = [...new Set([[/\balumin(?:um|ium)\b/i, "Aluminum"], [/\bvinyl\b|\bu?pvc\b/i, "Vinyl"], [/\bwood(?:en)?\b/i, "Wood"], [/\bfib(?:er|re)glass\b/i, "Fiberglass"], [/\bsteel\b/i, "Steel"], [/\bcomposite\b/i, "Composite"]]
    .filter(([pattern]) => (pattern as RegExp).test(raw)).map(([, label]) => label as string))];
  if (found.length === 1) return found[0];
  if (found.length > 1) return found.sort().join(" / ");
  return explicit && raw && !/^(unknown|unsure|n\/a|not recorded)$/i.test(raw) ? title(raw.toLowerCase()) : null;
};
function resolve(evidence: FactEvidence[]): ResolvedClassification {
  const values = [...new Set(evidence.map(item => item.value).filter((value): value is string => !!value))];
  return { value: values.length === 1 ? values[0] : null, status: values.length > 1 ? "conflict" : values.length ? "known" : "unknown", evidence };
}
// Configuration features can supplement each other. Only contradictory values
// for the same feature (such as track count) constitute a conflict.
function configuration(raw: string) {
  const labels: string[] = [];
  if (/\bfrench\b/i.test(raw)) labels.push("French");
  if (/\b(?:paired|pair|double leaf)\b/i.test(raw)) labels.push("Pair");
  if (/\bpivot\b/i.test(raw)) labels.push("Pivot");
  if (/\bsidel(?:ights|ites)\b/i.test(raw)) labels.push("Sidelights");
  if (/\binward[ -]opening\b/i.test(raw)) labels.push("Inward-opening");
  if (/\boutward[ -]opening\b/i.test(raw)) labels.push("Outward-opening");
  if (/\btransom\b/i.test(raw)) labels.push("Transom");
  for (const match of raw.matchAll(/\b(\d+)\s*[- ]?\s*(tracks?|panels?)\b/gi)) {
    const fixed = /^\s*fixed\b/i.test(raw.slice(match.index! + match[0].length));
    const feature = match[2].toLowerCase().startsWith("track") ? "tracks" : fixed ? "fixed panels" : "panels";
    labels.push(`${match[1]} ${match[1] === "1" ? feature.replace(/s$/, "") : feature}`);
  }
  return [...new Set(labels)].sort().join(" · ") || null;
}
function resolveConfiguration(evidence: FactEvidence[]): ResolvedClassification {
  const labels = [...new Set(evidence.flatMap(item => item.value?.split(" · ") ?? []))].sort();
  const conflict = ["tracks", "panels", "fixed panels"].some(feature => labels.filter(label => label.replace(/^\d+ /, "").replace(/s$/, "") === feature.replace(/s$/, "")).length > 1) || (labels.includes("Inward-opening") && labels.includes("Outward-opening"));
  return { value: conflict ? null : labels.join(" · ") || null, status: conflict ? "conflict" : labels.length ? "known" : "unknown", evidence };
}
const system = (raw: string) => {
  const found = [[/\bstorefront\b/i, "Storefront"], [/\bcurtain[ -]?wall\b/i, "Curtain wall"]]
    .filter(([pattern]) => (pattern as RegExp).test(raw)).map(([, label]) => label as string);
  return found;
};
/** Read only explicit links and a bounded vocabulary. Never infer from brand,
 * color, dimensions, unit labels, or fuzzy matches across jobs. */
export function resolveUnitTaxonomy(unit?: WorkUnit, context?: OpeningContext) {
  const categories: FactEvidence[] = [], subtypes: FactEvidence[] = [], materials: FactEvidence[] = [], configurations: FactEvidence[] = [], systems: FactEvidence[] = [];
  const addKind = (source: string, raw: unknown) => { const value = text(raw); if (value) categories.push({ source, raw: value, value: kind(value) }); };
  const addSubtype = (source: string, raw: unknown, category: string | null) => { const value = text(raw); if (value) subtypes.push({ source, raw: value, value: subtype(value, category) }); };
  const addMaterial = (source: string, raw: unknown, explicit = false) => { const value = text(raw); if (value) materials.push({ source, raw: value, value: material(value, explicit) }); };
  const signature = context?.opening.signature, spec = context?.spec, catalog = context?.catalogType;
  addKind("Opening signature", signature?.kind);
  addKind("Job spec unit_kind", spec?.unit_kind);
  addKind("Job spec style", spec?.style);
  addKind("Custom type label", unit?.type_label);
  addKind("Linked catalog category", catalog?.category);
  addKind("Linked catalog name", catalog?.name);
  const category = resolve(categories);
  const mechanisms = [...new Set(signature?.tiers?.flatMap(tier => Object.entries(tier.mix ?? {}).filter(([, count]) => count > 0).map(([name]) => name)) ?? [])];
  if (mechanisms.length) addSubtype("Opening signature mechanisms", mechanisms.join(" "), signature?.kind === "door" ? "Door" : "Window");
  const doorNames: Record<string, string> = { slider: "Sliding", french: "Hinged", bifold: "Folding", swing: "Hinged" };
  if (spec?.door_kind && doorNames[spec.door_kind]) subtypes.push({ source: "Job spec door_kind", raw: spec.door_kind, value: doorNames[spec.door_kind] });
  addSubtype("Job spec operation", spec?.operation, kind(spec?.style) ?? kind(spec?.unit_kind) ?? category.value);
  addSubtype("Job spec style", spec?.style, kind(spec?.style));
  addSubtype("Custom type label", unit?.type_label, kind(unit?.type_label));
  addSubtype("Linked catalog category", catalog?.category, kind(catalog?.category));
  addSubtype("Linked catalog name", catalog?.name, kind(catalog?.name));
  addMaterial("Custom material", unit?.facts.material, true);
  addMaterial("Job spec frame_material", spec?.extra?.frame_material, true);
  addMaterial("Job spec style (derived)", spec?.style);
  addMaterial("Linked catalog name (derived)", catalog?.name);
  for (const [source, raw] of [
    ["Job spec style", spec?.style], ["Job spec operation", spec?.operation],
    ["Job spec door_kind", spec?.door_kind], ["Job spec product line", spec?.product_line],
    ["Custom type label", unit?.type_label], ["Linked catalog category", catalog?.category], ["Linked catalog name", catalog?.name],
  ]) {
    const value = text(raw);
    if (!value) continue;
    configurations.push({ source: source!, raw: value, value: configuration(value) });
    const values = system(value);
    if (values.length) for (const label of values) systems.push({ source: source!, raw: value, value: label });
    else systems.push({ source: source!, raw: value, value: null });
  }
  return { category, subtype: resolve(subtypes), configuration: resolveConfiguration(configurations), system: resolve(systems), material: resolve(materials) };
}
