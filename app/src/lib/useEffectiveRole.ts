import { useQuery } from "@tanstack/react-query";
import { getRealProfile } from "./install/api";
import type { CrewRole } from "./install/types";
import { effectiveRole, useViewAsRole } from "./viewAsRoleContext";

export interface EffectiveRole {
  /** The real signed-in user's role — always use this for anything about identity. */
  realRole: CrewRole | string | null | undefined;
  /** The role the UI should render as: previewRole when previewing, else realRole. */
  effectiveRole: CrewRole | string | null | undefined;
  /** True when a supervisor+ is previewing another role (banner + faithful gating). */
  isPreviewing: boolean;
  /**
   * True while the profile is still loading, when the role reads as null but
   * nothing is known yet. Route guards must wait on this rather than treat the
   * null as "no permissions", which would flash a denial at every allowed user.
   */
  isLoading: boolean;
}

/**
 * Single hook for faithful "view-as-role": pages gate their UI on `effectiveRole`
 * so an owner previewing "installer" sees the installer UI faithfully, while all
 * server mutations and data queries stay keyed to the real signed-in user. When
 * not previewing, `effectiveRole === realRole` so behavior is identical.
 */
export function useEffectiveRole(): EffectiveRole {
  const me = useQuery({ queryKey: ["myRealProfile"], queryFn: getRealProfile });
  const view = useViewAsRole();
  const realRole = me.data?.role ?? null;
  const isPreviewing =
    (view.canPreview && view.previewRole != null) ||
    (view.canPreviewPerson && view.previewPerson != null);
  return {
    realRole,
    effectiveRole: effectiveRole(realRole, view),
    isPreviewing,
    isLoading: me.isLoading,
  };
}
