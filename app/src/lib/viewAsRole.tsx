import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getMyProfile } from "./install/api";
import { isSupervisorPlus, type CrewRole } from "./install/types";
import { ViewAsRoleContext, type ViewAsRoleValue } from "./viewAsRoleContext";

const STORAGE_KEY = "infinity.viewAsRole";

function readStored(): CrewRole | null {
  try {
    const v = sessionStorage.getItem(STORAGE_KEY);
    return v === "installer" || v === "foreman" || v === "supervisor" || v === "owner"
      ? v
      : null;
  } catch {
    return null;
  }
}

/**
 * Holds the session-only preview role. Only supervisors+ may set it, and it is
 * used purely for read-only client presentation (nav/landing/guards) — server
 * authorization always uses the real user.
 */
export function ViewAsRoleProvider({ children }: { children: ReactNode }) {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const canPreview = isSupervisorPlus(me.data?.role);
  const [previewRole, setPreviewRoleState] = useState<CrewRole | null>(() => readStored());

  const setPreviewRole = useCallback(
    (role: CrewRole | null) => {
      if (!canPreview) return;
      setPreviewRoleState(role);
      try {
        if (role) sessionStorage.setItem(STORAGE_KEY, role);
        else sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        /* sessionStorage unavailable (private mode) — keep in-memory only */
      }
    },
    [canPreview],
  );

  const value = useMemo<ViewAsRoleValue>(
    () => ({ previewRole: canPreview ? previewRole : null, setPreviewRole, canPreview }),
    [canPreview, previewRole, setPreviewRole],
  );

  return <ViewAsRoleContext.Provider value={value}>{children}</ViewAsRoleContext.Provider>;
}
