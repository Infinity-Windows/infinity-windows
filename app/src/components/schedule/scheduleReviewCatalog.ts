// Copy for the Review AI drafts card (K2.8). Loads with the card's own lazy
// chunk, not with the first-load bundle — catalog.ts ships in the app shell
// and the 260 kB budget has ~4 kB of room (like dailyLogCatalog.ts for the
// Ask page). Every key has English and Spanish; the Spanish is a first pass
// for the owner's bilingual review.
import { useCallback } from "react";
import { useLanguage } from "../../lib/i18n/context";
import type { TKey as AppKey } from "../../lib/i18n/catalog";
import { translate, type CatalogEntry, type TVars } from "../../lib/i18n/translate";

export const SCHEDULE_REVIEW_CATALOG = {
  "aiReview.title": { en: "Review AI drafts", es: "Revisar borradores de la IA" },
  "aiReview.count": { en: "{n} to review", es: "{n} por revisar" },
  "aiReview.help": { en: "Forge AI drafted these. Keep or drop each one, then publish — nothing reaches the crew until you publish.", es: "Forge AI escribió estos borradores. Conserva o descarta cada uno y luego publica; nada llega al equipo hasta que publiques." },
  "aiReview.reasonLoading": { en: "Reading the AI's reason…", es: "Leyendo el motivo de la IA…" },
  "aiReview.noReason": { en: "No reason recorded", es: "Sin motivo registrado" },
  "aiReview.reasonsFailed": { en: "The AI's reasons could not be loaded. The drafts are still here.", es: "No se pudieron cargar los motivos de la IA. Los borradores siguen aquí." },
  "aiReview.keep": { en: "Keep", es: "Conservar" },
  "aiReview.kept": { en: "Kept", es: "Conservado" },
  "aiReview.drop": { en: "Drop", es: "Descartar" },
  "aiReview.dropping": { en: "Dropping…", es: "Descartando…" },
  "aiReview.dropFailed": { en: "{error} The draft is still here.", es: "{error} El borrador sigue aquí." },
  // Drop reached the database and found the row no longer the draft the card
  // was showing — another supervisor published or changed it meanwhile. It was
  // NOT deleted; the list re-reads so the row shows as it is now.
  "aiReview.dropChanged": { en: "This draft changed since you opened it — it may have been published. Nothing was dropped; the list has been refreshed.", es: "Este borrador cambió desde que lo abriste; puede que ya esté publicado. No se descartó nada; la lista se actualizó." },
  "aiReview.nobody": { en: "nobody assigned", es: "nadie asignado" },
  "aiReview.job": { en: "Job", es: "Obra" },
  "aiReview.outside": { en: "{n} more AI draft(s) outside these dates — move the dates to see them. Publish sends those too.", es: "{n} borrador(es) más de la IA fuera de estas fechas; cambia las fechas para verlos. Publicar también los envía." },
  "aiReview.onlyOutside": { en: "No AI drafts in these dates.", es: "No hay borradores de la IA en estas fechas." },
  "aiReview.publishHint": { en: "Publish sends every unpublished change — the AI drafts you kept and your own ({n}).", es: "Publicar envía todos los cambios sin publicar: los borradores de la IA que conservaste y los tuyos ({n})." },
  "aiReview.publish": { en: "Review & publish", es: "Revisar y publicar" },
} as const satisfies Record<string, CatalogEntry>;

export type ScheduleReviewKey = keyof typeof SCHEDULE_REVIEW_CATALOG;
export type TKey = AppKey | ScheduleReviewKey;
export type TFn = (key: TKey, vars?: TVars) => string;

/** `useT()` plus this card's own keys, in the person's language. */
export function useScheduleReviewT(): TFn {
  const { lang, t } = useLanguage();
  return useCallback((key: TKey, vars?: TVars) => key.startsWith("aiReview.")
    ? translate(SCHEDULE_REVIEW_CATALOG, lang, key, vars)
    : t(key as AppKey, vars), [lang, t]);
}
