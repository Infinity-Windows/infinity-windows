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
import { signInMark, stillSignedInAs } from "../signedIn";

export function DesignProvider({ children }: { children: ReactNode }) {
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

  const choice: UiDesign | null = me.data
    ? normalizeDesign((me.data as Profile).ui_design)
    : null;
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
          queryClient.setQueryData<Profile | null>(["myRealProfile"], patch);
          queryClient.setQueryData<Profile | null>(["myProfile"], patch);
          void queryClient.invalidateQueries({ queryKey: ["myRealProfile"] });
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

  return <DesignContext.Provider value={value}>{children}</DesignContext.Provider>;
}
