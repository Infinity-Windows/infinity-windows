// The React half of the design switch (K-X2): one provider inside the
// authenticated tree. Exports ONLY the component; the hook lives in context.ts.
//
// It reads two things the app already fetches — the real profile (the
// person's own `ui_design`) and the company settings row (the owner's master
// switch) — and resolves them through the pure rule in design.ts. It also
// stamps `data-design` on <html> so CSS can tell the two designs apart without
// every component asking.

import { useCallback, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getCompanySettings } from "../companySettings";
import { getRealProfile, setMyUiDesign } from "../install/api";
import type { Profile } from "../install/types";
import { toastError } from "../toast";
import { DesignContext, type DesignContextValue } from "./context";
import {
  normalizeDesign,
  readCachedDesign,
  resolveDesign,
  writeCachedDesign,
  type UiDesign,
} from "./design";

export function DesignProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // Keys off the REAL profile, not the view-as-person preview: which front
  // door renders is the viewer's own preference, the same rule the language
  // provider follows — an owner previewing an installer keeps their own design.
  const me = useQuery({ queryKey: ["myRealProfile"], queryFn: getRealProfile });
  const settings = useQuery({ queryKey: ["companySettings"], queryFn: getCompanySettings });
  const [cached, setCached] = useState<UiDesign | null>(() => readCachedDesign());

  const choice: UiDesign | null = me.data
    ? normalizeDesign((me.data as Profile).ui_design)
    : null;
  // Three states on purpose: true / false / "we do not know". A settings row
  // from a database that predates the column reads `undefined`, which is
  // "unknown" — and unknown never sends anybody back to classic.
  const masterOn: boolean | null =
    settings.data == null ? null : (settings.data.new_design_r1_enabled ?? null);

  const design = resolveDesign({ personChoice: choice, masterOn, cached });

  // Keep the device cache equal to what actually rendered, so the next cold
  // load paints this design first. Written from the resolved answer, so a
  // master switch flipped off is cached as classic too.
  useLayoutEffect(() => {
    document.documentElement.dataset.design = design;
    if (me.data) writeCachedDesign(design);
    return () => {
      delete document.documentElement.dataset.design;
    };
  }, [design, me.data]);

  const setChoice = useCallback(
    (next: UiDesign) => {
      writeCachedDesign(next);
      setCached(next);
      // Patch the cached profile so the switch flips this instant — the
      // profile is the winning source, so it has to say the new answer before
      // the RPC round-trips or the paint would snap back.
      const patch = (old: Profile | null | undefined) =>
        old ? { ...old, ui_design: next } : old;
      queryClient.setQueryData<Profile | null>(["myRealProfile"], patch);
      queryClient.setQueryData<Profile | null>(["myProfile"], patch);
      void setMyUiDesign(next)
        .then(() => queryClient.invalidateQueries({ queryKey: ["myRealProfile"] }))
        .catch((e) => toastError(e));
    },
    [queryClient],
  );

  const value = useMemo<DesignContextValue>(
    () => ({ design, choice, masterOn, setChoice }),
    [design, choice, masterOn, setChoice],
  );

  return <DesignContext.Provider value={value}>{children}</DesignContext.Provider>;
}
