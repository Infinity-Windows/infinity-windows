// The Job location card's phrasebook (manual job location, 2026-10-08) —
// English and Spanish side by side, the same contract as catalog.ts.
//
// WHY ITS OWN FILE: the main catalog ships in the entry chunk every phone
// downloads before it can draw anything, and that chunk sits a hair under its
// budget (scripts/check-bundle-budget.mjs). The Job location card is explicitly loaded on demand,
// so these strings ride in its own chunk and register themselves into the live
// catalog the moment JobLocationPanel's module loads — before it renders.
// catalog.ts imports only this file's key TYPE, which costs the entry nothing,
// so t("jobLocation.…") is still checked like every other key.
//
// A key used before registration renders empty, never a bare key (translate()
// never returns the key), and never crashes.

import type { CatalogEntry } from "./translate";
import { registerCatalog } from "./catalog";

export const JOB_LOCATION_CATALOG = {
  "jobLocation.heading": { en: "Job location", es: "Ubicación del trabajo" },
  "jobLocation.address": { en: "Address", es: "Dirección" },
  "jobLocation.gps": { en: "GPS coordinates", es: "Coordenadas GPS" },
  "jobLocation.noAddress": { en: "No address saved", es: "No hay dirección guardada" },
  "jobLocation.noGps": { en: "No GPS point saved", es: "No hay punto GPS guardado" },
  "jobLocation.empty": { en: "No location saved for this job yet.", es: "Este trabajo todavía no tiene ubicación guardada." },
  "jobLocation.emptyLead": {
    en: "Add an address, a GPS point, or both so the crew can find the site.",
    es: "Agrega una dirección, un punto GPS o ambos para que el equipo encuentre el sitio.",
  },
  "jobLocation.emptyCrew": {
    en: "Ask a foreman or supervisor to add it.",
    es: "Pide a un capataz o supervisor que la agregue.",
  },
  "jobLocation.gpsUsedForDirections": {
    en: "Directions go to the GPS point.",
    es: "Las indicaciones llevan al punto GPS.",
  },
  "jobLocation.directions": { en: "Directions", es: "Cómo llegar" },
  "jobLocation.directionsTitle": { en: "Get directions to the job", es: "Cómo llegar al trabajo" },
  "jobLocation.copy": { en: "Copy", es: "Copiar" },
  "jobLocation.copied": { en: "Location copied", es: "Ubicación copiada" },
  "jobLocation.copyFailed": { en: "Couldn't copy the location", es: "No se pudo copiar la ubicación" },
  "jobLocation.add": { en: "Add location", es: "Agregar ubicación" },
  "jobLocation.edit": { en: "Edit location", es: "Editar ubicación" },
  "jobLocation.gpsHint": {
    en: "Latitude, longitude in decimal degrees. Example: 40.7608, -111.8910",
    es: "Latitud, longitud en grados decimales. Ejemplo: 40.7608, -111.8910",
  },
  "jobLocation.blankHint": {
    en: "Both are optional. Leave a field blank to remove it.",
    es: "Ambos son opcionales. Deja un campo en blanco para quitarlo.",
  },
  "jobLocation.clearBoth": { en: "Clear both", es: "Borrar ambos" },
  "jobLocation.save": { en: "Save location", es: "Guardar ubicación" },
  "jobLocation.saving": { en: "Saving…", es: "Guardando…" },
  "jobLocation.cancel": { en: "Cancel", es: "Cancelar" },
  "jobLocation.saved": { en: "Location saved", es: "Ubicación guardada" },
  "jobLocation.error.pair": {
    en: "Enter latitude and longitude as two numbers separated by a comma, like 40.7608, -111.8910.",
    es: "Escribe la latitud y la longitud como dos números separados por una coma, como 40.7608, -111.8910.",
  },
  "jobLocation.error.range": {
    en: "Latitude must be between -90 and 90, and longitude between -180 and 180.",
    es: "La latitud debe estar entre -90 y 90, y la longitud entre -180 y 180.",
  },
} satisfies Record<string, CatalogEntry>;

export type JobLocationKey = keyof typeof JOB_LOCATION_CATALOG;

registerCatalog(JOB_LOCATION_CATALOG);
