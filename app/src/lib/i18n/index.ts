// One import surface for the language layer. Screens want `useT`; the app root
// wants `LanguageProvider`; the picker and settings toggle want `useLanguage`.
export { LanguageProvider } from "./LanguageProvider";
export { useT, useLanguage, type TFn } from "./context";
export { CATALOG, SAFETY_KEYS, type TKey } from "./catalog";
export {
  isLang,
  normalizeLang,
  resolveLanguage,
  translate,
  interpolate,
  LANGS,
  type Lang,
  type TVars,
  type CatalogEntry,
} from "./translate";
