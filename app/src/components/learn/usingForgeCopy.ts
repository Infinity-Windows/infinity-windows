// The "Using Forge" tab's words, English and Spanish side by side.
//
// A dictionary of its own rather than rows in lib/i18n/catalog.ts, because the
// main catalog rides in the entry chunk every phone downloads before it can
// draw anything (scripts/check-bundle-budget.mjs), and these strings are only
// ever needed once somebody opens this one tab. Same contract as the main
// catalog: every entry is a CatalogEntry, so a missing Spanish line does not
// compile, and usingForgeCopy.test.ts proves none are blank.
//
// Say only what is true. The videos are narrated in the language stated on the
// row — today English — and the interface around them is what is translated;
// the copy says so rather than implying Spanish narration.

import { useCallback } from "react";
import { useLanguage } from "../../lib/i18n";
import { translate, type CatalogEntry, type TVars } from "../../lib/i18n";

export const USING_FORGE_COPY = {
  "uf.title": { en: "Using Forge", es: "Usar Forge" },
  "uf.intro": {
    en: "Narrated walkthroughs of how Forge could work for your role.",
    es: "Recorridos narrados de cómo podría funcionar Forge para tu función.",
  },
  "uf.previewBadge": { en: "Design preview", es: "Vista previa de diseño" },
  "uf.previewText": {
    en: "Design preview — some steps are proposed, not available in the current app.",
    es: "Vista previa de diseño — algunos pasos son propuestas y no están disponibles en la app actual.",
  },
  "uf.notCounted": {
    en: "Watching does not add learning time, points, quiz results or clearances, and these videos are not instructions to work a new way. Keep using the app as it works today.",
    es: "Verlos no suma tiempo de aprendizaje, puntos, resultados de cuestionarios ni autorizaciones, y estos videos no son instrucciones para trabajar de otra forma. Sigue usando la app como funciona hoy.",
  },
  "uf.scope.installer": { en: "Installers and up", es: "Instaladores y superiores" },
  "uf.scope.foreman": { en: "Foremen and up", es: "Capataces y superiores" },
  "uf.scope.leadership": { en: "Supervisors and owners", es: "Supervisores y dueños" },
  "uf.narration.en": {
    en: "Narration and captions in English",
    es: "Narración y subtítulos en inglés",
  },
  "uf.narration.es": {
    en: "Narration and captions in Spanish",
    es: "Narración y subtítulos en español",
  },
  "uf.trackLabel.en": { en: "English", es: "Inglés" },
  "uf.trackLabel.es": { en: "Spanish", es: "Español" },
  "uf.minutes": { en: "{n} min", es: "{n} min" },
  "uf.watch": { en: "Watch", es: "Ver" },
  "uf.watchNamed": { en: "Watch {title}", es: "Ver {title}" },
  "uf.back": { en: "All walkthroughs", es: "Todos los recorridos" },
  "uf.loadingList": { en: "Loading walkthroughs…", es: "Cargando recorridos…" },
  "uf.listFailed": {
    en: "Couldn't load the walkthroughs.",
    es: "No se pudieron cargar los recorridos.",
  },
  "uf.offline": {
    en: "You're offline. These walkthroughs stream over the internet and aren't saved on this phone.",
    es: "Estás sin conexión. Estos recorridos se transmiten por internet y no se guardan en este teléfono.",
  },
  "uf.tryLater": {
    en: "Check your signal and try again.",
    es: "Revisa tu señal e inténtalo de nuevo.",
  },
  "uf.retry": { en: "Try again", es: "Reintentar" },
  "uf.empty.title": { en: "No walkthroughs yet", es: "Todavía no hay recorridos" },
  "uf.empty.msg": {
    en: "None have been published for your role yet. They will appear here when they are.",
    es: "Aún no se ha publicado ninguno para tu función. Aparecerán aquí cuando se publiquen.",
  },
  "uf.preparing": { en: "Preparing the video…", es: "Preparando el video…" },
  "uf.mediaFailed": { en: "The video couldn't be opened.", es: "No se pudo abrir el video." },
  "uf.playbackFailed": {
    en: "The video stopped loading. The link may have expired or the signal dropped.",
    es: "El video dejó de cargar. Puede que el enlace haya vencido o que se perdiera la señal.",
  },
  "uf.captionsFailed": {
    en: "Captions couldn't load. The transcript below has the same words.",
    es: "No se pudieron cargar los subtítulos. La transcripción de abajo tiene las mismas palabras.",
  },
  "uf.noCaptions": {
    en: "This video has no captions. The transcript below has the narration.",
    es: "Este video no tiene subtítulos. La transcripción de abajo tiene la narración.",
  },
  "uf.videoLabel": { en: "Video: {title}", es: "Video: {title}" },
  "uf.chapters": { en: "Chapters", es: "Capítulos" },
  "uf.chapterJump": { en: "Jump to {time}, {title}", es: "Ir a {time}, {title}" },
  "uf.status.proposal": { en: "Proposed", es: "Propuesta" },
  "uf.status.live": { en: "In the app today", es: "En la app hoy" },
  "uf.status.mixed": { en: "Partly in the app", es: "Parte en la app" },
  "uf.statusHelp": {
    en: "Proposed steps are designs, not buttons you can use yet.",
    es: "Los pasos propuestos son diseños, todavía no son botones que puedas usar.",
  },
  "uf.transcript": { en: "Read the transcript", es: "Leer la transcripción" },
  "uf.noTranscript": {
    en: "No transcript was published with this video.",
    es: "No se publicó una transcripción con este video.",
  },
  "uf.streamingNote": {
    en: "Plays while you're online. It can't be downloaded or watched offline.",
    es: "Se reproduce con conexión. No se puede descargar ni ver sin conexión.",
  },
  "uf.liveApart.title": { en: "Doing real work?", es: "¿Vas a hacer trabajo real?" },
  "uf.liveApart.body": {
    en: "Nothing in these videos changes your records. Clock in, log units and fill out forms from the app's own screens, the way they work today.",
    es: "Nada en estos videos cambia tus registros. Marca tu entrada, registra unidades y llena formularios desde las pantallas de la app, como funcionan hoy.",
  },
} satisfies Record<string, CatalogEntry>;

export type UsingForgeKey = keyof typeof USING_FORGE_COPY;
export type UsingForgeT = (key: UsingForgeKey, vars?: TVars) => string;

/** `const t = useUsingForgeT()` — the tab's own t(), following the app's
 * language setting like every other screen. */
export function useUsingForgeT(): UsingForgeT {
  const { lang } = useLanguage();
  return useCallback(
    (key: UsingForgeKey, vars?: TVars) => translate(USING_FORGE_COPY, lang, key, vars),
    [lang],
  );
}
