import type { CatalogEntry } from "./translate";
import { registerCatalog } from "./catalog";

export const JOBS_VIEW_CATALOG = {
  "jobsView.selectedIssue": { en: "Showing the selected issue.", es: "Se muestra el problema seleccionado." },
  "jobsView.allIssues": { en: "Show all issues", es: "Mostrar todos los problemas" },
  "jobsView.issueUnavailable": { en: "This issue is not available. Show all issues or refresh to try again.", es: "Este problema no está disponible. Muestra todos los problemas o actualiza para intentar de nuevo." },
  "jobsView.heading": { en: "Jobs", es: "Trabajos" },
  "jobsView.overview": { en: "Overview", es: "Panorama" },
  "jobsView.list": { en: "Job list", es: "Lista de trabajos" },
  "jobsView.choose": { en: "Jobs view", es: "Vista de trabajos" },
  "jobsView.help": {
    en: "See what needs attention, today's plan and the latest recorded work.",
    es: "Revisa lo que necesita atención, el plan de hoy y el último trabajo registrado.",
  },
} as const satisfies Record<string, CatalogEntry>;

export type JobsViewKey = keyof typeof JOBS_VIEW_CATALOG;

registerCatalog(JOBS_VIEW_CATALOG);
