// The walkthrough importer's words, English and Spanish side by side. Its own
// dictionary for the same reason as usingForgeCopy.ts: it is only ever needed
// by a supervisor or owner who opens the importer, so it stays out of the
// entry chunk. Every entry is a CatalogEntry, so a missing Spanish line does
// not compile.
//
// Say only what is true: nothing is "published" until the server said so, and
// the videos these publish are design previews, narrated in English.

import { useCallback } from "react";
import { useLanguage } from "../../lib/i18n";
import { translate, type CatalogEntry, type TVars } from "../../lib/i18n";
import type { ImportErrorCode, ImportProblemCode } from "../../lib/trainingImport";

export const TRAINING_IMPORTER_COPY = {
  "ti.title": { en: "Publish walkthrough videos", es: "Publicar videos de recorrido" },
  "ti.intro": {
    en: "For supervisors and owners. Pick the reviewed role-videos-manifest.json and the files it names. Everything is checked on this computer before anything is sent.",
    es: "Para supervisores y dueños. Elige el role-videos-manifest.json revisado y los archivos que nombra. Todo se revisa en esta computadora antes de enviar nada.",
  },
  "ti.private": {
    en: "The files stay private: only people at or above each video's role can watch, and nothing is shared as a public link.",
    es: "Los archivos siguen siendo privados: solo quienes tienen la función del video o una superior pueden verlo, y nada se comparte como enlace público.",
  },
  "ti.step.manifest": { en: "1. Manifest", es: "1. Manifiesto" },
  "ti.step.files": { en: "2. Video, caption, transcript and poster files", es: "2. Archivos de video, subtítulos, transcripción y portada" },
  "ti.pickManifest": { en: "Choose manifest", es: "Elegir manifiesto" },
  "ti.pickFiles": { en: "Choose files", es: "Elegir archivos" },
  "ti.noneChosen": { en: "Nothing chosen yet", es: "Aún no se eligió nada" },
  "ti.filesChosen": { en: "{n} files chosen", es: "{n} archivos elegidos" },
  "ti.checking": { en: "Checking the files…", es: "Revisando los archivos…" },
  "ti.problemsTitle": {
    en: "Fix these before publishing. Nothing has been sent.",
    es: "Corrige esto antes de publicar. No se ha enviado nada.",
  },
  "ti.previewTitle": { en: "Ready to publish", es: "Listo para publicar" },
  "ti.previewBadge": { en: "Design preview", es: "Vista previa de diseño" },
  "ti.previewNote": {
    en: "Published as a design preview. The app will show every viewer that some steps are proposed, not available today.",
    es: "Se publica como vista previa de diseño. La app mostrará a cada persona que algunos pasos son propuestas y no están disponibles hoy.",
  },
  "ti.scope.installer": { en: "Installers and up", es: "Instaladores y superiores" },
  "ti.scope.foreman": { en: "Foremen and up", es: "Capataces y superiores" },
  "ti.scope.leadership": { en: "Supervisors and owners", es: "Supervisores y dueños" },
  "ti.version": { en: "Version {n}", es: "Versión {n}" },
  "ti.versionNext": { en: "Next version", es: "Siguiente versión" },
  "ti.duration": { en: "Length {time}", es: "Duración {time}" },
  "ti.narration": { en: "Narrated in English", es: "Narrado en inglés" },
  "ti.chapters": { en: "{n} chapters", es: "{n} capítulos" },
  "ti.captions": { en: "{n} captions", es: "{n} subtítulos" },
  "ti.transcript": { en: "Transcript: {n} passages", es: "Transcripción: {n} pasajes" },
  "ti.kind.video": { en: "Video", es: "Video" },
  "ti.kind.captions": { en: "Captions", es: "Subtítulos" },
  "ti.kind.poster": { en: "Poster", es: "Portada" },
  "ti.noPoster": { en: "No poster", es: "Sin portada" },
  "ti.publish": { en: "Publish reviewed walkthroughs", es: "Publicar recorridos revisados" },
  "ti.publishHelp": {
    en: "Replaces the version each role sees now. The older version is kept, switched off.",
    es: "Reemplaza la versión que cada función ve ahora. La versión anterior se guarda, desactivada.",
  },
  "ti.step.reserving": { en: "Reserving versions…", es: "Reservando versiones…" },
  "ti.step.uploading": { en: "Uploading…", es: "Subiendo…" },
  "ti.step.verifying": { en: "Checking what arrived…", es: "Revisando lo que llegó…" },
  "ti.step.publishing": { en: "Publishing…", es: "Publicando…" },
  "ti.keepOpen": {
    en: "Keep this page open. It says Published only once the server has confirmed it.",
    es: "Mantén esta página abierta. Solo dirá Publicado cuando el servidor lo haya confirmado.",
  },
  "ti.asset.waiting": { en: "Waiting", es: "En espera" },
  "ti.asset.uploading": { en: "Uploading", es: "Subiendo" },
  "ti.asset.stored": { en: "Received", es: "Recibido" },
  "ti.asset.failed": { en: "Stopped", es: "Detenido" },
  "ti.cancel": { en: "Stop", es: "Detener" },
  "ti.retry": { en: "Try again", es: "Reintentar" },
  "ti.startOver": { en: "Start over with new versions", es: "Empezar de nuevo con versiones nuevas" },
  "ti.discard": { en: "Give up these reserved versions", es: "Renunciar a estas versiones reservadas" },
  "ti.discarded": {
    en: "Stopped this import. Reserved versions that were not published were given up; nothing was deleted, and any publication that had already completed stays available.",
    es: "Se detuvo esta importación. Se renunció a las versiones reservadas que no se publicaron; no se borró nada, y cualquier publicación que ya se había completado sigue disponible.",
  },
  "ti.failedTitle": {
    en: "Publication not confirmed",
    es: "Publicación no confirmada",
  },
  "ti.keptFiles": {
    en: "Your chosen files are still selected.",
    es: "Tus archivos elegidos siguen seleccionados.",
  },
  "ti.doneTitle": { en: "Published", es: "Publicado" },
  "ti.doneLine": { en: "{scope}: version {n} is now live for viewers.", es: "{scope}: la versión {n} ya está disponible." },
  "ti.doneAlready": { en: "{scope}: version {n} was already published.", es: "{scope}: la versión {n} ya estaba publicada." },
  "ti.doneInactive": {
    en: "{scope}: version {n} is published but a newer version is showing.",
    es: "{scope}: la versión {n} está publicada, pero se muestra una versión más nueva.",
  },
  "ti.discardedPublished": {
    en: "{scope}: version {n} had already been published and stays available.",
    es: "{scope}: la versión {n} ya se había publicado y sigue disponible.",
  },
  "ti.another": { en: "Publish another set", es: "Publicar otro conjunto" },
  "ti.notConfigured": {
    en: "This copy of the app is not connected to the database, so it cannot publish.",
    es: "Esta copia de la app no está conectada a la base de datos, así que no puede publicar.",
  },

  // Problems found on this computer, before anything is sent.
  "ti.p.manifest.notJson": { en: "The manifest is not valid JSON.", es: "El manifiesto no es JSON válido." },
  "ti.p.manifest.tooLarge": { en: "The manifest file is too large to be a manifest.", es: "El archivo del manifiesto es demasiado grande para ser un manifiesto." },
  "ti.p.manifest.shape": {
    en: "The manifest must be {\"videos\": [ … ]} (or a list of the same entries).",
    es: "El manifiesto debe ser {\"videos\": [ … ]} (o una lista de las mismas entradas).",
  },
  "ti.p.manifest.empty": { en: "The manifest lists no videos.", es: "El manifiesto no incluye videos." },
  "ti.p.manifest.tooMany": { en: "The manifest lists more than three videos.", es: "El manifiesto incluye más de tres videos." },
  "ti.p.entry.notObject": { en: "{where}: this entry is not a set of fields.", es: "{where}: esta entrada no es un conjunto de campos." },
  "ti.p.entry.unknownField": { en: "{where}: unknown field “{detail}”.", es: "{where}: campo desconocido “{detail}”." },
  "ti.p.entry.field": { en: "{where}: “{detail}” is missing or too long.", es: "{where}: falta “{detail}” o es demasiado largo." },
  "ti.p.entry.slug": { en: "{where}: slug must be installer, foreman or leadership.", es: "{where}: slug debe ser installer, foreman o leadership." },
  "ti.p.entry.floor": { en: "{where}: minRole does not match this walkthrough.", es: "{where}: minRole no corresponde a este recorrido." },
  "ti.p.entry.language": { en: "{where}: language must be \"en\" (the narration is English).", es: "{where}: language debe ser \"en\" (la narración es en inglés)." },
  "ti.p.entry.status": {
    en: "{where}: contentStatus must be \"proposal\". This importer only publishes design previews.",
    es: "{where}: contentStatus debe ser \"proposal\". Este importador solo publica vistas previas de diseño.",
  },
  "ti.p.entry.duration": { en: "{where}: durationSeconds must be a whole number from 1 to 7200.", es: "{where}: durationSeconds debe ser un número entero de 1 a 7200." },
  "ti.p.entry.version": { en: "{where}: version must be a whole number from 1 to 999, or left out.", es: "{where}: version debe ser un número entero de 1 a 999, u omitirse." },
  "ti.p.entry.chapters": {
    en: "{where}: chapters must start at 0 seconds, go in order, stay inside the video, and each have a title and a status.",
    es: "{where}: los capítulos deben empezar en 0 segundos, ir en orden, quedar dentro del video y tener cada uno un título y un estado.",
  },
  "ti.p.entry.duplicate": { en: "{where}: listed twice.", es: "{where}: aparece dos veces." },
  "ti.p.file.unsafePath": {
    en: "{where}: “{detail}” must be a plain file name or folder/file name — no web address, no full path, no “..”.",
    es: "{where}: “{detail}” debe ser un nombre de archivo o carpeta/archivo — sin dirección web, sin ruta completa, sin “..”.",
  },
  "ti.p.file.missing": { en: "{where}: “{detail}” was not among the chosen files.", es: "{where}: “{detail}” no está entre los archivos elegidos." },
  "ti.p.file.ambiguous": {
    en: "{where}: more than one chosen file is called “{detail}”. Choose only one.",
    es: "{where}: hay más de un archivo elegido llamado “{detail}”. Elige solo uno.",
  },
  "ti.p.file.reused": { en: "{where}: “{detail}” is already used by another entry.", es: "{where}: “{detail}” ya lo usa otra entrada." },
  "ti.p.file.extension": { en: "{where}: “{detail}” has the wrong file type.", es: "{where}: “{detail}” tiene el tipo de archivo equivocado." },
  "ti.p.file.empty": { en: "{where}: “{detail}” is empty.", es: "{where}: “{detail}” está vacío." },
  "ti.p.file.tooLarge": {
    en: "{where}: “{detail}” is too large (video 45 MB, poster 5 MB, captions and transcript 1 MB).",
    es: "{where}: “{detail}” es demasiado grande (video 45 MB, portada 5 MB, subtítulos y transcripción 1 MB).",
  },
  "ti.p.file.unreadable": { en: "{where}: a file could not be read on this computer.", es: "{where}: no se pudo leer un archivo en esta computadora." },
  "ti.p.video.notMp4": { en: "{where}: “{detail}” is not an MP4 video.", es: "{where}: “{detail}” no es un video MP4." },
  "ti.p.video.duration": {
    en: "{where}: the video is {detail} seconds long, which does not match durationSeconds.",
    es: "{where}: el video dura {detail} segundos, lo que no coincide con durationSeconds.",
  },
  "ti.p.video.unreadable": {
    en: "{where}: this browser could not read the length of “{detail}”, so phones may not play it either.",
    es: "{where}: este navegador no pudo leer la duración de “{detail}”, así que es posible que los teléfonos tampoco lo reproduzcan.",
  },
  "ti.p.captions.notVtt": { en: "{where}: “{detail}” is not a WebVTT caption file.", es: "{where}: “{detail}” no es un archivo de subtítulos WebVTT." },
  "ti.p.captions.noCues": { en: "{where}: “{detail}” has no captions in it.", es: "{where}: “{detail}” no tiene subtítulos." },
  "ti.p.captions.timing": {
    en: "{where}: “{detail}” has a caption with a broken time or one past the end of the video.",
    es: "{where}: “{detail}” tiene un subtítulo con una hora incorrecta o después del final del video.",
  },
  "ti.p.poster.notImage": { en: "{where}: “{detail}” is not a JPEG, PNG or WebP image.", es: "{where}: “{detail}” no es una imagen JPEG, PNG o WebP." },
  "ti.p.poster.typeMismatch": {
    en: "{where}: “{detail}” is a different image type than its name says.",
    es: "{where}: “{detail}” es un tipo de imagen distinto al que indica su nombre.",
  },
  "ti.p.transcript.notJson": { en: "{where}: the transcript is not valid JSON.", es: "{where}: la transcripción no es JSON válido." },
  "ti.p.transcript.shape": {
    en: "{where}: the transcript must be {\"language\", \"segments\": [ … ]} with at least one segment.",
    es: "{where}: la transcripción debe ser {\"language\", \"segments\": [ … ]} con al menos un segmento.",
  },
  "ti.p.transcript.language": { en: "{where}: the transcript's language does not match the video's.", es: "{where}: el idioma de la transcripción no coincide con el del video." },
  "ti.p.transcript.segment": {
    en: "{where}: transcript segment {detail} has a missing or impossible time, or no text.",
    es: "{where}: el segmento {detail} de la transcripción tiene una hora faltante o imposible, o no tiene texto.",
  },
  "ti.p.transcript.order": { en: "{where}: transcript segment {detail} is out of order.", es: "{where}: el segmento {detail} de la transcripción está fuera de orden." },
  "ti.p.transcript.tooLong": { en: "{where}: the transcript is too long to publish.", es: "{where}: la transcripción es demasiado larga para publicarla." },

  // Why a run stopped. None of these says anything was published.
  "ti.err.signedOut": {
    en: "You were signed out, so this stopped before the server confirmed anything. Sign in again and tap Try again to check where it stands.",
    es: "Se cerró tu sesión, así que esto se detuvo antes de que el servidor confirmara nada. Vuelve a iniciar sesión y toca Reintentar para ver cómo quedó.",
  },
  "ti.err.accountChanged": {
    en: "A different account signed in, so this stopped and nothing more was sent. Anything the server had already finished stays.",
    es: "Inició sesión otra cuenta, así que esto se detuvo y no se envió nada más. Lo que el servidor ya había terminado se mantiene.",
  },
  "ti.err.cancelled": {
    en: "Stopped. If the server had already finished publishing, that stays. Tap Try again to check — nothing is published twice.",
    es: "Detenido. Si el servidor ya había terminado de publicar, eso se mantiene. Toca Reintentar para comprobarlo; nada se publica dos veces.",
  },
  "ti.err.timeout": {
    en: "The connection was too slow and this stopped before the server confirmed anything. Tap Try again: files that already arrived are not sent twice, and a publication that already went through is shown, not repeated.",
    es: "La conexión fue demasiado lenta y esto se detuvo antes de que el servidor confirmara nada. Toca Reintentar: los archivos que ya llegaron no se envían otra vez, y una publicación que ya se hizo se muestra, no se repite.",
  },
  "ti.err.network": {
    en: "The connection dropped before the server confirmed anything. Tap Try again to check — a publication that already went through is shown, not repeated.",
    es: "Se perdió la conexión antes de que el servidor confirmara nada. Toca Reintentar para comprobarlo; una publicación que ya se hizo se muestra, no se repite.",
  },
  "ti.err.notInstalled": {
    en: "Publishing isn't set up on the server yet. Ask for the latest database update.",
    es: "La publicación aún no está configurada en el servidor. Pide la actualización más reciente de la base de datos.",
  },
  "ti.err.notAllowed": { en: "Only a supervisor or owner can publish walkthroughs.", es: "Solo un supervisor o dueño puede publicar recorridos." },
  "ti.err.rejected": { en: "The server refused these details. Check the manifest.", es: "El servidor rechazó estos datos. Revisa el manifiesto." },
  "ti.err.versionTaken": {
    en: "That version number is already used. Remove \"version\" from the manifest, or use a higher one.",
    es: "Ese número de versión ya se usó. Quita \"version\" del manifiesto o usa uno más alto.",
  },
  "ti.err.requestChanged": {
    en: "The files changed since this import started. Start over with new versions.",
    es: "Los archivos cambiaron desde que empezó esta importación. Empieza de nuevo con versiones nuevas.",
  },
  "ti.err.expired": {
    en: "The reserved versions expired before publishing. Start over with new versions.",
    es: "Las versiones reservadas vencieron antes de publicarse. Empieza de nuevo con versiones nuevas.",
  },
  "ti.err.cancelledServer": {
    en: "Those reserved versions were given up. Start over with new versions.",
    es: "Se renunció a esas versiones reservadas. Empieza de nuevo con versiones nuevas.",
  },
  "ti.err.missing": { en: "A file had not finished uploading. Try again.", es: "Un archivo no terminó de subirse. Inténtalo de nuevo." },
  "ti.err.mismatch": {
    en: "A stored file does not match the one chosen here, so it was not accepted for publishing. Start over with new versions.",
    es: "Un archivo guardado no coincide con el elegido aquí, así que no se aceptó para publicar. Empieza de nuevo con versiones nuevas.",
  },
  "ti.err.newerPublished": {
    en: "Someone published a newer version meanwhile. Nothing was replaced. Start over if yours should be newest.",
    es: "Alguien publicó una versión más nueva mientras tanto. No se reemplazó nada. Empieza de nuevo si la tuya debe ser la más reciente.",
  },
  "ti.err.notFound": { en: "That import was not found for this account.", es: "No se encontró esa importación para esta cuenta." },
  "ti.err.tooLarge": { en: "A file is larger than the server accepts.", es: "Un archivo es más grande de lo que acepta el servidor." },
  "ti.err.badResponse": {
    en: "The server's answer didn't match what was asked, so this isn't counted as published. Tap Try again to check.",
    es: "La respuesta del servidor no coincidió con lo pedido, así que no se cuenta como publicado. Toca Reintentar para comprobarlo.",
  },
  "ti.err.server": {
    en: "Something went wrong on the server and nothing was confirmed. Tap Try again to check where it stands.",
    es: "Algo falló en el servidor y no se confirmó nada. Toca Reintentar para ver cómo quedó.",
  },
} satisfies Record<string, CatalogEntry>;

export type TrainingImporterKey = keyof typeof TRAINING_IMPORTER_COPY;
export type TrainingImporterT = (key: TrainingImporterKey, vars?: TVars) => string;

// Compile-time proof that every problem and error code has words.
type ProblemKeysCovered = `ti.p.${ImportProblemCode}` extends TrainingImporterKey ? true : never;
type ErrorKeysCovered = `ti.err.${ImportErrorCode}` extends TrainingImporterKey ? true : never;
export const COPY_COVERS_CODES: ProblemKeysCovered & ErrorKeysCovered = true;

export function useTrainingImporterT(): TrainingImporterT {
  const { lang } = useLanguage();
  return useCallback(
    (key: TrainingImporterKey, vars?: TVars) => translate(TRAINING_IMPORTER_COPY, lang, key, vars),
    [lang],
  );
}
