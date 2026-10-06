// The React half of the design switch (K-X2): one provider inside the
// authenticated tree. Exports ONLY the component; the hook lives in context.ts.
//
// The owner pilot requires a fresh account-specific server admission as well
// as the person's own preference. It stamps `data-design` on <html> so CSS can
// tell the two designs apart without every component asking.

import { useCallback, useEffect, useLayoutEffect, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRealProfile, setMyUiDesign } from "../install/api";
import type { Profile } from "../install/types";
import { toastError } from "../toast";
import { DesignContext, type DesignContextValue } from "./context";
import { DESIGN_CACHE_KEY, normalizeDesign, resolveDesign, type UiDesign } from "./design";
import { useRedesignPilotState } from "./useRedesignPilot";
import { signInMark, signedInUserId, stillSignedInAs } from "../signedIn";
import { forgetOfflinePilotProof } from "./offlinePilotProof";
import { useT } from "../i18n";

export function DesignProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const queryClient = useQueryClient();
  // Keys off the REAL profile, not the view-as-person preview: which front
  // door renders is the viewer's own preference, the same rule the language
  // provider follows — an owner previewing an installer keeps their own design.
  const me = useQuery({ queryKey: ["myRealProfile"], queryFn: getRealProfile });
  const pilot = useRedesignPilotState();
  const pilotAdmitted = pilot.admitted;
  useEffect(() => {
    try { localStorage.removeItem(DESIGN_CACHE_KEY); } catch { /* storage denied */ }
  }, []);

  // A fresh real-profile Classic answer must beat an older offline New copy.
  // Cached profile data from a prior login cannot beat the login-bound proof.
  const currentProfileChoice = me.data?.id === signedInUserId()
    ? normalizeDesign((me.data as Profile).ui_design) : null;
  const choice: UiDesign | null = pilot.serverChoice
    ?? (me.isFetchedAfterMount ? currentProfileChoice : null)
    ?? pilot.offlineChoice ?? currentProfileChoice;
  // The crew reveal switch remains separate. During the owner pilot, only a
  // fresh, account-bound server admission can show the new front door. Never
  // use the old shared-device cache or an unknown company setting to admit.
  const design = pilotAdmitted
    ? resolveDesign({ personChoice: choice, masterOn: true, cached: null })
    : "classic";

  // Never remember admission or a rendered new design on a shared device.
  useLayoutEffect(() => {
    document.documentElement.dataset.design = design;
    return () => {
      delete document.documentElement.dataset.design;
    };
  }, [design]);

  const setChoice = useCallback(
    (next: UiDesign) => {
      if (next === "new" && !pilotAdmitted) return;
      const mark = signInMark();
      if (!mark.userId) return;
      const patch = (old: Profile | null | undefined) =>
        old ? { ...old, ui_design: next } : old;
      void setMyUiDesign(next)
        .then(() => {
          if (!stillSignedInAs(mark, mark.userId!)) return;
          if (next === "classic") forgetOfflinePilotProof();
          queryClient.setQueryData<Profile | null>(["myRealProfile"], patch);
          queryClient.setQueryData<Profile | null>(["myProfile"], patch);
          queryClient.setQueriesData<{ kind: "answered"; profile: Profile | null } | { kind: "unreachable" }>(
            { queryKey: ["redesignPilotProfile", mark.userId] },
            (old) => old?.kind === "answered" && old.profile?.id === mark.userId
              ? { kind: "answered", profile: { ...old.profile, ui_design: next } }
              : old,
          );
          void queryClient.invalidateQueries({ queryKey: ["myRealProfile"] });
          void queryClient.invalidateQueries({ queryKey: ["redesignPilotProfile", mark.userId] });
        })
        .catch((e) => {
          toastError(e);
          void queryClient.invalidateQueries({ queryKey: ["redesignPilot"] });
        });
    },
    [pilotAdmitted, queryClient],
  );

  const value = useMemo<DesignContextValue>(
    () => ({ design, choice, masterOn: pilotAdmitted ? true : pilot.ready ? false : null, setChoice }),
    [design, choice, pilotAdmitted, pilot.ready, setChoice],
  );

  // When the phone claims it is online but its saved pilot proof is still
  // awaiting this boot's server answer, show a neutral wait rather than a
  // brief Classic screen that jumps to New seven seconds later.
  return <DesignContext.Provider value={value}>
    {pilot.pendingProof ? <div className="page" role="status">{t("design.pilot.opening")}</div> : children}
  </DesignContext.Provider>;
}
