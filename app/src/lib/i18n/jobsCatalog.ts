// The Jobs page's search/recommendation phrasebook — English and Spanish side
// by side, the same contract as catalog.ts. See workCatalog.ts's header for
// why this rides as a second file: Projects.tsx stays on the route the entry
// chunk already carries, but a second phrasebook costs that chunk nothing
// either way (registerCatalog below runs once, from the page's own import),
// and keeping every page's strings in one file would make catalog.ts the
// thing every unrelated change has to merge through.

import type { CatalogEntry } from "./translate";
import { registerCatalog } from "./catalog";

export const JOBS_CATALOG = {
  "jobs.title": { en: "Jobs", es: "Trabajos" },
  "jobs.subtitle": { en: "Your next stop, and every active job.", es: "Tu próxima parada y todos los trabajos activos." },
  "jobs.home": { en: "Home", es: "Inicio" },
  "jobs.new": { en: "+ New project", es: "+ Nuevo proyecto" },
  "jobs.cancel": { en: "Cancel", es: "Cancelar" },
  "jobs.history": { en: "Job history", es: "Historial" },
  "jobs.imports": { en: "Import jobs from Monday", es: "Importar trabajos de Monday" },
  "jobs.noneScheduled": { en: "No upcoming jobs scheduled", es: "Sin trabajos próximos programados" },
  "jobs.scheduleHorizon": { en: "Your published schedule for the next six weeks.", es: "Tu horario publicado para las próximas seis semanas." },
  "jobs.noneRecent": { en: "No recent jobs yet", es: "Todavía no hay trabajos recientes" },
  "jobs.recentWindow": { en: "Jobs from your recent time and work records in the last 90 days.", es: "Trabajos de tus registros recientes de tiempo y trabajo de los últimos 90 días." },
  "jobs.timeUnknown": { en: "Time not set", es: "Sin hora" },
  "jobs.search.placeholder": { en: "Search jobs", es: "Buscar trabajos" },
  "jobs.search.clear": { en: "Clear search", es: "Borrar búsqueda" },
  "jobs.search.count.one": { en: "1 job", es: "1 trabajo" },
  "jobs.search.count.many": { en: "{n} jobs", es: "{n} trabajos" },
  "jobs.search.none": { en: "No jobs match", es: "Ningún trabajo coincide" },
  "jobs.search.noneHint": {
    en: "Try a different name, job code, address or customer.",
    es: "Prueba con otro nombre, código, dirección o cliente.",
  },
  "jobs.search.allJobsNote": {
    en: "Searching every active job, whatever chip is selected.",
    es: "Buscando en todos los trabajos activos, sin importar el filtro elegido.",
  },

  "jobs.chip.all": { en: "All", es: "Todos" },
  "jobs.chip.scheduled": { en: "Scheduled", es: "Programados" },
  "jobs.chip.recent": { en: "Recent", es: "Recientes" },
  "jobs.chip.loadError": { en: "couldn't load", es: "no se pudo cargar" },

  "jobs.group.scheduled": { en: "Scheduled jobs", es: "Trabajos programados" },
  "jobs.group.recent": { en: "Recently worked", es: "Trabajados recientemente" },
  "jobs.group.other": { en: "Other jobs", es: "Otros trabajos" },

  "jobs.next.heading": { en: "Next on your schedule", es: "Lo próximo en tu horario" },
  "jobs.next.today": { en: "Today", es: "Hoy" },

  "jobs.officeOrder.toggle": { en: "Office order", es: "Orden de oficina" },
  "jobs.officeOrder.done": { en: "Done ordering", es: "Terminar de ordenar" },
  "jobs.officeOrder.hint": {
    en: "Drag a job, or use the arrows, to set the saved office order.",
    es: "Arrastra un trabajo, o usa las flechas, para fijar el orden guardado de oficina.",
  },

  "jobs.scheduleError": {
    en: "Couldn't check your schedule — showing jobs alphabetically instead.",
    es: "No se pudo revisar tu horario — mostrando los trabajos en orden alfabético.",
  },
  "jobs.recentError": {
    en: "Couldn't load recently worked jobs.",
    es: "No se pudieron cargar los trabajos recientes.",
  },
} satisfies Record<string, CatalogEntry>;

export type JobsKey = keyof typeof JOBS_CATALOG;

registerCatalog(JOBS_CATALOG);
