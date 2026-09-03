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

/**
 * The everyday hook: `const t = useT()`. Works even with NO provider above it —
 * an isolated component in a unit test still renders real English copy rather
 * than crashing or leaking a bare key. In the running app the provider is always
 * present, so this is the live-language path.
 */
export function useT(): TFn {
  const ctx = useContext(LanguageContext);
  if (ctx) return ctx.t;
  return (key, vars) => translate(CATALOG, "en", key, vars);
}

/** The full context, for the picker and the settings toggle. */
export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (ctx) return ctx;
  // A benign default so a component under test without a provider still mounts;
  // the real screens that call this are always inside the provider.
  return {
    lang: "en",
    t: (key, vars) => translate(CATALOG, "en", key, vars),
    setLang: () => {},
    needsChoice: false,
  };
}
