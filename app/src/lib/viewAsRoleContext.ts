import { createContext, useContext } from "react";
import type { CrewRole } from "./install/types";

/**
 * "View as role" preview. IMPORTANT: this override is READ-ONLY for the client's
 * navigation, landing, and route guards. It NEVER changes what the server
 * authorizes — every data mutation still runs as the real signed-in user and is
 * enforced by Supabase RLS. It only lets a supervisor+ experience how another
 * role's app is laid out from a single login.
 */
export interface ViewAsRoleValue {
  /** The previewed role, or null when viewing as yourself. */
  previewRole: CrewRole | null;
  /** Set/clear the preview. No-op unless the real role is supervisor+. */
  setPreviewRole: (role: CrewRole | null) => void;
  /** Whether the current user is allowed to use the preview at all. */
  canPreview: boolean;
}

export const ViewAsRoleContext = createContext<ViewAsRoleValue>({
  previewRole: null,
  setPreviewRole: () => {},
  canPreview: false,
});

export function useViewAsRole(): ViewAsRoleValue {
  return useContext(ViewAsRoleContext);
}

/**
 * Effective role = previewed role (only if the caller may preview) else the real
 * role. Feeds navForRole / canAccess / RoleLanding so the whole shell re-renders
 * as the previewed role without touching server authorization.
 */
export function effectiveRole(
  realRole: CrewRole | string | null | undefined,
  view: Pick<ViewAsRoleValue, "previewRole" | "canPreview">,
): CrewRole | string | null | undefined {
  if (view.canPreview && view.previewRole) return view.previewRole;
  return realRole;
}
