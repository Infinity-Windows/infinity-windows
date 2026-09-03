// The React half of the language layer: one provider at the app root. This file
// exports ONLY the component (the context and hooks live in context.ts) so it
// stays fast-refresh clean. Everything hard lives in translate.ts / cache.ts
// (pure, unit-tested); this only wires those to the profile query and setState.

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRealProfile, setMyLanguage } from "../install/api";
import type { Profile } from "../install/types";
import { toastError } from "../toast";
import { CATALOG } from "./catalog";
import { readCachedLang, writeCachedLang } from "./cache";
import { normalizeLang, resolveLanguage, translate, type Lang } from "./translate";
import { LanguageContext, type LanguageContextValue } from "./context";

export function LanguageProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // Shares the ["myRealProfile"] cache entry with useEffectiveRole, so reading
  // the language costs no extra request. Language keys off the REAL profile, not
  // the view-as-person preview: it is the viewer's own reading preference, so an
  // owner previewing an installer keeps their own language.
  const me = useQuery({ queryKey: ["myRealProfile"], queryFn: getRealProfile });
  const [cached, setCached] = useState<Lang | null>(() => readCachedLang());

  const profileLang = me.data ? normalizeLang((me.data as Profile).language) : null;
  // Profile wins once loaded; the cache carries the first paint before it does;
  // English is the floor. (translate.resolveLanguage, unit-tested.)
  const lang = resolveLanguage(profileLang, cached);

  const setLang = useCallback(
    (next: Lang) => {
      writeCachedLang(next);
      setCached(next);
      // Patch the cached profile so the resolved language flips this instant —
      // the profile is the winning source, so it has to reflect the choice
      // before the RPC round-trips or the paint would snap back to the old one.
      const patch = (old: Profile | null | undefined) =>
        old ? { ...old, language: next } : old;
      queryClient.setQueryData<Profile | null>(["myRealProfile"], patch);
      queryClient.setQueryData<Profile | null>(["myProfile"], patch);
      void setMyLanguage(next)
        .then(() => queryClient.invalidateQueries({ queryKey: ["myRealProfile"] }))
        .catch((e) => toastError(e));
    },
    [queryClient],
  );

  const value = useMemo<LanguageContextValue>(
    () => ({
      lang,
      t: (key, vars) => translate(CATALOG, lang, key, vars),
      setLang,
      needsChoice: cached === null,
    }),
    [lang, setLang, cached],
  );

  return (
    <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
  );
}
