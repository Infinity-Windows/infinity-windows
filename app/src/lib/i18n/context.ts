// The context object and the hooks that read it. Kept apart from the provider
// component (LanguageProvider.tsx) on purpose: a file that exports a component
// AND non-component helpers trips the fast-refresh lint rule, so the component
// lives alone and everything a screen imports (useT, useLanguage) lives here.

import { createContext, useContext } from "react";
import { CATALOG, type TKey } from "./catalog";
import { translate, type Lang, type TVars } from "./translate";

/** What a screen reaches for: t() to render, plus the current language. */
export type TFn = (key: TKey, vars?: TVars) => string;

export interface LanguageContextValue {
  lang: Lang;
  t: TFn;
  /** Persist a new language and apply it immediately, app-wide. */
  setLang: (lang: Lang) => void;
  /**
   * True when this device has no recorded choice yet — the first-login picker
   * reads this. See cache.ts for why the signal lives on the device.
   */
  needsChoice: boolean;
}

export const LanguageContext = createContext<LanguageContextValue | null>(null);

// The no-provider fallbacks, module-level so their identity is STABLE across
// renders and across calls. An inline `(key, vars) => …` returned fresh from
// inside the hook looks harmless in isolation, but S3b started passing `t`
// into `useMemo`/`useEffect` dependency arrays (FindBar's `answer`,
// Warehouse's `tiles`/`chips`) — a fresh function every render there means
// "changed every render," which turned one `useEffect([answer], …)` that
// calls `setAnswer` into an infinite render loop the instant a test (or any
// tree) renders one of these components with no LanguageProvider above it.
const fallbackT: TFn = (key, vars) => translate(CATALOG, "en", key, vars);
const fallbackLanguageValue: LanguageContextValue = {
  lang: "en",
  t: fallbackT,
  setLang: () => {},
  needsChoice: false,
};

/**
 * The everyday hook: `const t = useT()`. Works even with NO provider above it —
 * an isolated component in a unit test still renders real English copy rather
 * than crashing or leaking a bare key. In the running app the provider is always
 * present, so this is the live-language path.
 */
export function useT(): TFn {
  const ctx = useContext(LanguageContext);
  return ctx ? ctx.t : fallbackT;
}

/** The full context, for the picker and the settings toggle. */
export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  // A benign default so a component under test without a provider still mounts;
  // the real screens that call this are always inside the provider.
  return ctx ?? fallbackLanguageValue;
}
