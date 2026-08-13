import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRealProfile } from "./install/api";
import { isOwner, isSupervisorPlus, type CrewRole } from "./install/types";
import { ViewAsRoleContext, type PreviewPerson, type ViewAsRoleValue } from "./viewAsRoleContext";

const STORAGE_KEY = "infinity.viewAsRole";
/** Read by getMyProfile too (outside React) — keep the key in sync there. */
export const PERSON_STORAGE_KEY = "infinity.viewAsPerson";

function readStoredPerson(): PreviewPerson | null {
  try {
    const raw = sessionStorage.getItem(PERSON_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as PreviewPerson;
    return v && typeof v.id === "string" && typeof v.role === "string" ? v : null;
  } catch {
    return null;
  }
}

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
  // The REAL profile: getMyProfile is preview-affected by design, and gating
  // the preview controls on it would lock the owner out of Reset the moment
  // a preview starts (the provider would "become" the previewed installer).
  const me = useQuery({ queryKey: ["myRealProfile"], queryFn: getRealProfile });
  const canPreview = isSupervisorPlus(me.data?.role);
  const canPreviewPerson = isOwner(me.data?.role);
  const [previewRole, setPreviewRoleState] = useState<CrewRole | null>(() => readStored());
  const [previewPerson, setPreviewPersonState] = useState<PreviewPerson | null>(
    () => readStoredPerson(),
  );

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

  const setPreviewPerson = useCallback(
    (p: PreviewPerson | null) => {
      if (!canPreviewPerson) return;
      setPreviewPersonState(p);
      // Person and role previews are mutually exclusive — one lens at a time.
      if (p) setPreviewRoleState(null);
      try {
        if (p) sessionStorage.setItem(PERSON_STORAGE_KEY, JSON.stringify(p));
        else sessionStorage.removeItem(PERSON_STORAGE_KEY);
        if (p) sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        /* in-memory only */
      }
    },
    [canPreviewPerson],
  );

  const value = useMemo<ViewAsRoleValue>(
    () => ({
      previewRole: canPreview ? previewRole : null,
      setPreviewRole,
      canPreview,
      previewPerson: canPreviewPerson ? previewPerson : null,
      setPreviewPerson,
      canPreviewPerson,
    }),
    [canPreview, previewRole, setPreviewRole, canPreviewPerson, previewPerson, setPreviewPerson],
  );

  return <ViewAsRoleContext.Provider value={value}>{children}</ViewAsRoleContext.Provider>;
}
