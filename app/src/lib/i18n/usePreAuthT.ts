// A language hook for screens that render BEFORE a session exists — SignIn
// and JoinCrew. LanguageProvider only mounts once App.tsx has a session (it
// reads the profile), so those two screens cannot use useT()/useLanguage()
// and get anything but English: the no-provider fallback in context.ts is
// pinned to "en" on purpose, for tests that render an isolated component
// with no provider and no storage. A pre-login screen is a different case —
// it is a real device that may already carry a recorded choice — so it reads
// the same per-device cache (cache.ts) the rest of the app uses for instant
// first paint, kept reactive with its own small bit of state.
import { useCallback, useState } from "react";
import { CATALOG, type TKey } from "./catalog";
import { readCachedLang, writeCachedLang } from "./cache";
import { translate, type Lang, type TVars } from "./translate";

export interface PreAuthLanguage {
  lang: Lang;
  t: (key: TKey, vars?: TVars) => string;
  setLang: (lang: Lang) => void;
  /** True when this device had no recorded choice when the screen mounted. */
  hadNoChoice: boolean;
}

export function usePreAuthT(): PreAuthLanguage {
  const [lang, setLangState] = useState<Lang>(() => readCachedLang() ?? "en");
  const [hadNoChoice] = useState(() => readCachedLang() === null);
  const t = useCallback(
    (key: TKey, vars?: TVars) => translate(CATALOG, lang, key, vars),
    [lang],
  );
  const setLang = useCallback((next: Lang) => {
    writeCachedLang(next);
    setLangState(next);
  }, []);
  return { lang, t, setLang, hadNoChoice };
}
