import { useQuery } from "@tanstack/react-query";
import { getMyProfile } from "./install/api";
import type { CrewRole } from "./install/types";
import { effectiveRole, useViewAsRole } from "./viewAsRoleContext";

export interface EffectiveRole {
  /** The real signed-in user's role — always use this for anything about identity. */
  realRole: CrewRole | string | null | undefined;
  /** The role the UI should render as: previewRole when previewing, else realRole. */
  effectiveRole: CrewRole | string | null | undefined;
  /** True when a supervisor+ is previewing another role (banner + faithful gating). */
  isPreviewing: boolean;
}

/**
 * Single hook for faithful "view-as-role": pages gate their UI on `effectiveRole`
 * so an owner previewing "installer" sees the installer UI faithfully, while all
 * server mutations and data queries stay keyed to the real signed-in user. When
 * not previewing, `effectiveRole === realRole` so behavior is identical.
 */
export function useEffectiveRole(): EffectiveRole {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const view = useViewAsRole();
  const realRole = me.data?.role ?? null;
  const isPreviewing = view.canPreview && view.previewRole != null;
  return {
    realRole,
    effectiveRole: effectiveRole(realRole, view),
    isPreviewing,
  };
}
