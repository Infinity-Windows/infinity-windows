import { unitDefinitionPresets } from "./unitDefinitionDiagram";
import type { UnitKind } from "./unitDetails";

/**
 * The words this company uses for a unit's material and configuration.
 *
 * They were free text, so the same thing arrived as "Aluminum", "aluminium"
 * and "Thermal Break Aluminum Fixed Window", and units could not be grouped
 * or batch-edited by them. A short list is offered first, in the forms and to
 * the AI that reads shop drawings; a value outside it can still be added,
 * because a new job will sooner or later bring a material nobody listed.
 */
export const UNIT_MATERIALS: readonly string[] = [
  "Aluminum", "Vinyl", "Fiberglass", "Wood", "Aluminum-clad wood", "Steel",
];

/** Configurations with a diagram, for one type or (type unknown) for all of them. */
export const unitConfigurations = (kind?: UnitKind | "" | null): string[] =>
  kind ? unitDefinitionPresets(kind) : [...unitDefinitionPresets("window"), ...unitDefinitionPresets("door")];

// Spelling and punctuation are not a different option. Neither is "thermal
// break": every aluminum frame this manufacturer draws is thermally broken, so
// it is one material here, Aluminum (Matt, 2026-11-20).
const plain = (text: string) => text.toLowerCase().replace(/aluminium/g, "aluminum").replace(/[^a-z0-9]+/g, " ")
  .replace(/\bthermal(ly)? brok?en?\b|\bthermal break\b/g, " ").replace(/ +/g, " ").trim();

/** The listed wording for a value that means the same thing, or the value itself, trimmed. */
export function matchOption(options: readonly string[], value: string | null | undefined) {
  const text = value?.trim() ?? "";
  return options.find(option => plain(option) === plain(text)) ?? text;
}

/** The short list, then any other values already in use, each once. */
export function optionsWith(list: readonly string[], ...used: readonly (string | null | undefined)[]) {
  const all = [...list];
  for (const value of used) {
    const text = matchOption(all, value);
    if (text && !all.includes(text)) all.push(text);
  }
  return all;
}
