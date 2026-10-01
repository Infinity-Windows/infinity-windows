import { isUuid, type AskContextTag } from "../_shared/fieldTools.ts";
import { OFFER_NAVIGATION_TOOL_NAME, type NavigationAction } from "../_shared/askNavigation.ts";

/** The existing caller-scoped RPC checks job visibility. A second check keeps
 * a unit link within this person's crew jobs; no service-role read is used. */
interface NavigationClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface NavigationState { action: NavigationAction | null }
export const newNavigationState = (): NavigationState => ({ action: null });

const record = (raw: unknown): Record<string, unknown> | null => raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
const rows = (raw: unknown): Record<string, unknown>[] => Array.isArray(raw) ? raw.map(record).filter((r): r is Record<string, unknown> => !!r) : [];
const word = (raw: unknown): string => typeof raw === "string" ? raw.trim().slice(0, 100) : "";
const same = (left: unknown, right: string): boolean => typeof left === "string" && left.trim().toLowerCase() === right.toLowerCase();
const unavailable = (reason: string) => ({ content: JSON.stringify({ offered: false, reason, guidance: "No button was offered. Ask the person for the exact job and unit; do not claim a screen was opened." }) });

export function navigationExecutor(client: NavigationClient, userId: string, context: AskContextTag | null, state: NavigationState) {
  return async (name: string, input: unknown): Promise<{ content: string; is_error?: boolean }> => {
    if (name !== OFFER_NAVIGATION_TOOL_NAME) return { content: "Unknown navigation tool.", is_error: true };
    state.action = null;
    const args = record(input);
    if (args?.destination === "schedule") {
      state.action = { kind: "schedule" };
      return { content: JSON.stringify({ offered: true, button: "Open my schedule", guidance: "Nothing changed. Tell the person to tap the button to open Schedule." }) };
    }
    if (args?.destination !== "unit") return unavailable("Choose Schedule or a unit.");
    const job = word(args.job);
    const unit = word(args.unit);
    let projectId: string | null = !job ? context?.project_id ?? null : null;
    try {
      if (job && isUuid(job)) projectId = job.toLowerCase();
      else if (job) {
        const lookup = await client.rpc("ai_field_context", { p_job: null, p_search: job });
        if (lookup.error) return unavailable("The job could not be checked.");
        const matches = rows(record(lookup.data)?.jobs).filter((r) => isUuid(r.id) && (same(r.name, job) || same(r.job_code, job)));
        if (matches.length !== 1) return unavailable("The job name or code did not identify one exact job.");
        projectId = String(matches[0].id).toLowerCase();
      }
      if (!projectId) return unavailable("Which job is the unit on?");
      const access = await client.rpc("can_access_project_chat", { p_project_id: projectId, p_uid: userId });
      if (access.error || access.data !== true) return unavailable("That job is not available to this account.");
      const lookup = await client.rpc("ai_field_context", { p_job: projectId, p_search: unit || context?.unit_label || "" });
      if (lookup.error) return unavailable("The unit could not be checked.");
      const unitRows = rows(record(lookup.data)?.units);
      const candidates = unit
        ? unitRows.filter((r) => same(r.label, unit) || same(r.map_code, unit))
        : context?.project_id === projectId && (context.unit_id || context.opening_id)
          ? unitRows.filter((r) => r.unit_id === context.unit_id || r.opening_id === context.opening_id)
          : context?.project_id === projectId && context.unit_label
            ? unitRows.filter((r) => same(r.label, context.unit_label!) || same(r.map_code, context.unit_label!))
            : [];
      if (candidates.length !== 1) return unavailable("The unit did not identify one exact record.");
      const matched = candidates[0];
      const action: Extract<NavigationAction, { kind: "unit" }> = {
        kind: "unit", project_id: projectId,
        unit_id: isUuid(matched.unit_id) ? matched.unit_id.toLowerCase() : null,
        opening_id: isUuid(matched.opening_id) ? matched.opening_id.toLowerCase() : null,
        label: word(matched.label) || word(matched.map_code),
      };
      if ((!action.unit_id && !action.opening_id) || !action.label) return unavailable("That unit has no available screen.");
      state.action = action;
      return { content: JSON.stringify({ offered: true, button: `Open unit ${action.label}`, guidance: "Nothing changed. Tell the person to tap the button to open that unit. The voice cannot press it." }) };
    } catch {
      return unavailable("The job or unit could not be checked right now.");
    }
  };
}
