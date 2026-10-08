import { createContext, useContext } from "react";
import { roleRank, type CrewRole } from "./install/types";

/**
 * "View as role" preview. IMPORTANT: this override is READ-ONLY for the client's
 * navigation, landing, and route guards. It NEVER changes what the server
 * authorizes — every data mutation still runs as the real signed-in user and is
 * enforced by Supabase RLS. It only lets a supervisor+ experience how another
 * role's app is laid out from a single login.
 */
/** A person being previewed (owner-only): enough to render as them. */
export interface PreviewPerson {
  id: string;
  name: string;
  role: CrewRole | string;
}

/** Additive authority seam for sensitive mounted work. Legacy consumers keep
 * their presentation-only preview values. A missing seam must fail closed. */
export interface SensitivePreviewLifetime {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
  admitted: (ownerId: string, realRole: string) => boolean;
  hasPreview: () => boolean;
}
export function createSensitivePreviewLifetime(readAuthority: () => { stamp: string; ownerId: string | null; role: string | null; ready: boolean }, initialBlocked: boolean) {
  let version = 0, blocked = initialBlocked, stamp = readAuthority().stamp;
  const listeners = new Set<() => void>();
  const sync = () => { const next = readAuthority().stamp; if (next !== stamp) { stamp = next; version++; return true; } return false; };
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => { sync(); return version; },
    hasPreview: () => blocked,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    admitted: (ownerId: string, realRole: string) => { sync(); const a = readAuthority(); return !blocked && a.ready && a.ownerId === ownerId && a.role === realRole; },
    // Always advance, including batched preview A -> B -> A and Reset.
    previewChanged: (active: boolean) => { blocked = active; version++; notify(); },
    authorityChanged: () => { if (sync()) notify(); },
  };
}

export interface ViewAsRoleValue {
  sensitiveLifetime?: SensitivePreviewLifetime;
  /** Explicitly clear this session's own preview, even after losing the right
   * to start a preview. Never grants permission to create another preview. */
  returnAsYourself?: () => void;
  /** The previewed role, or null when viewing as yourself. */
  previewRole: CrewRole | null;
  /** Set/clear the preview. No-op unless the real role is supervisor+. */
  setPreviewRole: (role: CrewRole | null) => void;
  /** Whether the current user is allowed to use the preview at all. */
  canPreview: boolean;
  /**
   * Person preview (owner-only): reads render THEIR data (queue, timecard,
   * schedule) via the getMyProfile seam; writes still run as the real user —
   * the server stamps auth.uid(), so acting mid-preview acts as YOU.
   */
  previewPerson: PreviewPerson | null;
  setPreviewPerson: (p: PreviewPerson | null) => void;
  canPreviewPerson: boolean;
}

export const ViewAsRoleContext = createContext<ViewAsRoleValue>({
  previewRole: null,
  setPreviewRole: () => {},
  canPreview: false,
  previewPerson: null,
  setPreviewPerson: () => {},
  canPreviewPerson: false,
});

export function useViewAsRole(): ViewAsRoleValue {
  return useContext(ViewAsRoleContext);
}

/**
 * Effective role = previewed role (only if the caller may preview) else the real
 * role. Feeds navForRole / canAccess / RoleLanding so the whole shell re-renders
 * as the previewed role without touching server authorization.
 *
 * THE CEILING (owner bug report, 2026-09-01): "the only roles people should be
 * able to preview is their same rank and below, that's it." `canPreview` /
 * `canPreviewPerson` only gate WHETHER a preview may be attempted, never WHICH
 * role it reaches — a stale sessionStorage value, a direct storage edit, or a
 * future picker bug could otherwise hand back a role that outranks the real
 * user. So this function itself re-checks rank on every path and falls back to
 * realRole rather than trust the caller checked first — this is the one place
 * every route guard, nav, and page gates on via useEffectiveRole, so the clamp
 * here closes the hole everywhere at once.
 */
export function effectiveRole(
  realRole: CrewRole | string | null | undefined,
  view: Pick<ViewAsRoleValue, "previewRole" | "canPreview"> &
    Partial<Pick<ViewAsRoleValue, "previewPerson" | "canPreviewPerson">>,
): CrewRole | string | null | undefined {
  // Person preview wins: seeing Maria's app means seeing it at HER role.
  if (view.canPreviewPerson && view.previewPerson) {
    return roleRank(view.previewPerson.role) <= roleRank(realRole)
      ? view.previewPerson.role
      : realRole;
  }
  if (view.canPreview && view.previewRole) {
    return roleRank(view.previewRole) <= roleRank(realRole) ? view.previewRole : realRole;
  }
  return realRole;
}

/** Fixed low-to-high display order shared by the picker and its filter. */
const PREVIEW_ROLE_ORDER: CrewRole[] = ["installer", "foreman", "supervisor", "owner"];

/**
 * The roles a picker should OFFER: realRole's own rank and below, that's it
 * (owner ask, 2026-09-01 — the view-as ceiling). This is the second layer —
 * `effectiveRole` above clamps even if a bad option reaches state, but the UI
 * should never show a chip that leads nowhere. Whether a picker exists at all
 * stays whatever the caller already decides (supervisor+ only, today).
 */
export function previewableRoles(realRole: CrewRole | string | null | undefined): CrewRole[] {
  return PREVIEW_ROLE_ORDER.filter((r) => roleRank(r) <= roleRank(realRole));
}
