import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRealProfile } from "./install/api";
import { isOwner, isSupervisorPlus, type CrewRole } from "./install/types";
import { createSensitivePreviewLifetime, ViewAsRoleContext, type PreviewPerson, type ViewAsRoleValue } from "./viewAsRoleContext";

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
  const queryClient = useQueryClient();
  const canPreview = isSupervisorPlus(me.data?.role);
  const canPreviewPerson = isOwner(me.data?.role);
  const [previewRole, setPreviewRoleState] = useState<CrewRole | null>(() => readStored());
  const [previewPerson, setPreviewPersonState] = useState<PreviewPerson | null>(
    () => readStoredPerson(),
  );

  // Raw preview survives presentation suppression when the real role changes.
  // Sensitive work must never mistake that suppression for leaving preview.
  const rawPreview = useRef({ role: previewRole, person: previewPerson });
  const [sensitiveLifetime] = useState(() => createSensitivePreviewLifetime(() => {
    const state = queryClient.getQueryState<Awaited<ReturnType<typeof getRealProfile>>>(["myRealProfile"]);
    return { stamp: JSON.stringify([state?.dataUpdateCount, state?.errorUpdateCount, state?.status, state?.isInvalidated]),
      ownerId: state?.data?.id ?? null, role: state?.data?.role ?? null,
      ready: state?.status === "success" && !state.isInvalidated && !!state.data && !state.data.retired_at };
  }, !!previewRole || !!previewPerson));
  useLayoutEffect(() => {
    sensitiveLifetime.authorityChanged();
    return queryClient.getQueryCache().subscribe(event => {
      if (event.query.queryKey.length === 1 && event.query.queryKey[0] === "myRealProfile") sensitiveLifetime.authorityChanged();
    });
  }, [queryClient, sensitiveLifetime]);

  const setPreviewRole = useCallback(
    (role: CrewRole | null) => {
      if (!canPreview) return;
      rawPreview.current.role = role;
      sensitiveLifetime.previewChanged(!!role || !!rawPreview.current.person);
      setPreviewRoleState(role);
      try {
        if (role) sessionStorage.setItem(STORAGE_KEY, role);
        else sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        /* sessionStorage unavailable (private mode) — keep in-memory only */
      }
    },
    [canPreview, sensitiveLifetime],
  );

  const setPreviewPerson = useCallback(
    (p: PreviewPerson | null) => {
      if (!canPreviewPerson) return;
      rawPreview.current.person = p;
      if (p) rawPreview.current.role = null;
      sensitiveLifetime.previewChanged(!!rawPreview.current.role || !!p);
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
    [canPreviewPerson, sensitiveLifetime],
  );

  const returnAsYourself = useCallback(() => {
    // Clearing one's stale session lens needs no permission to start a preview.
    // Advance first: callbacks from the old lifetime must never revive.
    sensitiveLifetime.previewChanged(true);
    try {
      sessionStorage.removeItem(STORAGE_KEY); sessionStorage.removeItem(PERSON_STORAGE_KEY);
      if (sessionStorage.getItem(STORAGE_KEY) !== null || sessionStorage.getItem(PERSON_STORAGE_KEY) !== null) return;
    } catch { return; } // A stored person lens may still affect other reads.
    rawPreview.current = { role: null, person: null };
    setPreviewRoleState(null); setPreviewPersonState(null);
    sensitiveLifetime.previewChanged(false);
  }, [sensitiveLifetime]);

  const value = useMemo<ViewAsRoleValue>(
    () => ({
      sensitiveLifetime,
      returnAsYourself,
      previewRole: canPreview ? previewRole : null,
      setPreviewRole,
      canPreview,
      previewPerson: canPreviewPerson ? previewPerson : null,
      setPreviewPerson,
      canPreviewPerson,
    }),
    [canPreview, previewRole, setPreviewRole, canPreviewPerson, previewPerson, setPreviewPerson, sensitiveLifetime, returnAsYourself],
  );

  return <ViewAsRoleContext.Provider value={value}>{children}</ViewAsRoleContext.Provider>;
}
