/** Safe destinations for a reply's "Take me there" button. The model never
 * supplies a URL: the server verifies an exact record and the phone builds a
 * route from these typed IDs. Opening and custom-work units have different
 * screens, so a unit action contains exactly one of those IDs. */
import type { AnthropicToolDef } from "./anthropicTools.ts";
import { isUuid } from "./fieldTools.ts";

export type NavigationAction =
  | { kind: "schedule" }
  | { kind: "unit"; project_id: string; opening_id: string | null; unit_id: string | null; label: string };

export const OFFER_NAVIGATION_TOOL_NAME = "offer_navigation";
export const OFFER_NAVIGATION_TOOL: AnthropicToolDef = {
  name: OFFER_NAVIGATION_TOOL_NAME,
  strict: true,
  description: "Offer a Take me there button when the person asks to open their schedule or a specific unit, or your answer directs them to that screen. Changes nothing. For a unit, give the exact job name/code and unit label/code when known; use null for the job if the current Ask context already names it. Never make up IDs or URLs. If the job or unit cannot be verified, ask the person which one they mean instead of claiming a button exists.",
  input_schema: {
    type: "object",
    properties: {
      destination: { type: "string", enum: ["schedule", "unit"] },
      job: { type: ["string", "null"], description: "Exact job name or code for a unit, or null when the current Ask context names the job or this is Schedule." },
      unit: { type: ["string", "null"], description: "Exact unit label or map code, or null when the current Ask context identifies the unit or this is Schedule." },
    },
    required: ["destination", "job", "unit"],
    additionalProperties: false,
  },
};

export function readNavigationAction(raw: unknown): NavigationAction | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.kind === "schedule") return { kind: "schedule" };
  if (value.kind !== "unit" || !isUuid(value.project_id)) return null;
  const unitId = isUuid(value.unit_id) ? value.unit_id.toLowerCase() : null;
  const openingId = !unitId && isUuid(value.opening_id) ? value.opening_id.toLowerCase() : null;
  const label = typeof value.label === "string" ? value.label.trim().slice(0, 120) : "";
  if ((!unitId && !openingId) || !label) return null;
  return { kind: "unit", project_id: value.project_id.toLowerCase(), opening_id: openingId, unit_id: unitId, label };
}

export function navigationHref(action: NavigationAction): string {
  if (action.kind === "schedule") return "/my-schedule";
  if (action.unit_id) return `/current-work?job=${action.project_id}&unit=${action.unit_id}`;
  return `/projects/${action.project_id}/opening/${action.opening_id}`;
}

export function navigationLabel(action: NavigationAction, es: boolean): string {
  return action.kind === "schedule"
    ? (es ? "Abrir mi horario" : "Open my schedule")
    : (es ? `Abrir unidad ${action.label}` : `Open unit ${action.label}`);
}

export function navigationActivityLine(name: string): string | null {
  return name === OFFER_NAVIGATION_TOOL_NAME ? "Checked a screen link (nothing changed)" : null;
}
