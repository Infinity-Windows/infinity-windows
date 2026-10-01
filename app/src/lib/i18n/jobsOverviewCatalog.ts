// The Jobs Overview phrasebook (replaces Heartbeat). Lazy for the same
// reason workCatalog.ts is: JobOverview loads separately inside Jobs,
// never the entry chunk, so its strings ride in that chunk and register into
// the live catalog the moment it loads — see catalog.ts's registerCatalog.

import type { CatalogEntry } from "./translate";
import { registerCatalog } from "./catalog";

export const JOBS_OVERVIEW_CATALOG = {
  "jobsOverview.fetchedAt": { en: "Updated {time}", es: "Actualizado {time}" },
  "jobsOverview.refresh": { en: "Refresh", es: "Actualizar" },
  "jobsOverview.refreshing": { en: "Refreshing…", es: "Actualizando…" },
  "jobsOverview.loadError": {
    en: "Couldn't load the overview",
    es: "No se pudo cargar el panorama",
  },

  "jobsOverview.attention.heading": { en: "Needs attention", es: "Necesita atención" },
  "jobsOverview.attention.empty": {
    en: "Nothing flagged right now.",
    es: "Nada marcado por ahora.",
  },
  "jobsOverview.attention.viewAll": { en: "View all ({n})", es: "Ver todo ({n})" },
  "jobsOverview.attention.showLess": { en: "Show less", es: "Mostrar menos" },

  "jobsOverview.jobs.heading": { en: "All jobs", es: "Todos los trabajos" },
  "jobsOverview.jobs.empty": { en: "No jobs to show.", es: "No hay trabajos que mostrar." },
  "jobsOverview.jobs.upcoming": { en: "Upcoming", es: "Próximo" },

  "jobsOverview.today.plan": { en: "Today: {crew}", es: "Hoy: {crew}" },
  "jobsOverview.today.none": { en: "No crew published today", es: "Sin equipo publicado hoy" },
  "jobsOverview.nextStep.none": { en: "No next step published this week", es: "Sin siguiente paso publicado esta semana" },

  "jobsOverview.scope.line": {
    en: "{installed} of {total} openings installed",
    es: "{installed} de {total} aberturas instaladas",
  },
  "jobsOverview.scope.unavailable": {
    en: "Progress unavailable",
    es: "Progreso no disponible",
  },
  "jobsOverview.customWork.line": {
    en: "{completed} of {total} units complete",
    es: "{completed} de {total} unidades completas",
  },
  "jobsOverview.customWork.unavailable": {
    en: "Custom work progress unavailable",
    es: "Progreso de trabajo personalizado no disponible",
  },
  "jobsOverview.scope.none": { en: "No recorded scope yet", es: "Sin alcance registrado todavía" },

  "jobsOverview.concern.none": { en: "No reported concern", es: "Sin problema reportado" },
  "jobsOverview.concern.assignedTo": { en: "Assigned to {name}", es: "Asignado a {name}" },

  "jobsOverview.activity.label": { en: "Last recorded {time}", es: "Último registro {time}" },
  "jobsOverview.activity.none": { en: "No recorded activity in the last 14 days", es: "Sin actividad registrada en los últimos 14 días" },

  "jobsOverview.changes.heading": { en: "Meaningful changes since yesterday", es: "Cambios importantes desde ayer" },
  "jobsOverview.changes.empty": {
    en: "Nothing recorded as changed since yesterday.",
    es: "No se registró ningún cambio desde ayer.",
  },

  "jobsOverview.sources.issues": {
    en: "Issues unavailable — concerns from issues are not shown.",
    es: "Problemas no disponibles: no se muestran los problemas reportados.",
  },
  "jobsOverview.sources.scope": {
    en: "Opening progress unavailable for some jobs.",
    es: "Progreso de aberturas no disponible para algunos trabajos.",
  },
  "jobsOverview.sources.schedule": {
    en: "Published schedule unavailable — today's plan and next steps are not shown.",
    es: "Horario publicado no disponible: no se muestra el plan de hoy ni los siguientes pasos.",
  },
  "jobsOverview.sources.customWork": {
    en: "Custom work progress unavailable for some jobs.",
    es: "Progreso de trabajo personalizado no disponible para algunos trabajos.",
  },
  "jobsOverview.sources.dailyLogs": {
    en: "Daily logs unavailable — recent log activity is not shown.",
    es: "Bitácoras diarias no disponibles: no se muestra actividad reciente de bitácoras.",
  },
  "jobsOverview.sources.sessions": {
    en: "Recorded work activity unavailable for some jobs.",
    es: "Actividad de trabajo registrada no disponible para algunos trabajos.",
  },
  "jobsOverview.sources.readiness": {
    en: "Readiness checklist unavailable for some jobs.",
    es: "Lista de preparación no disponible para algunos trabajos.",
  },
  "jobsOverview.today.unavailable": { en: "Today’s crew plan unavailable", es: "Plan de cuadrilla de hoy no disponible" },
  "jobsOverview.today.unnamed": { en: "Crew names not recorded", es: "Nombres de cuadrilla sin registrar" },
  "jobsOverview.nextStep.plan": { en: "Next: crew scheduled {day}", es: "Siguiente: cuadrilla programada {day}" },
  "jobsOverview.nextStep.unavailable": { en: "Next scheduled step unavailable", es: "Siguiente paso programado no disponible" },
  "jobsOverview.concern.readiness": { en: "Readiness needs review", es: "La preparación necesita revisión" },
  "jobsOverview.concern.unknown": { en: "No work update for today’s plan", es: "Sin actualización de trabajo para el plan de hoy" },
  "jobsOverview.concern.issue": { en: "Reported issue", es: "Problema reportado" },
  "jobsOverview.concern.ownerUnknown": { en: "Responsible person not recorded", es: "Persona responsable sin registrar" },
  "jobsOverview.concern.unassigned": { en: "Unassigned", es: "Sin asignar" },
  "jobsOverview.concern.assignedUnknown": { en: "Assigned; name unavailable", es: "Asignado; nombre no disponible" },
  "jobsOverview.concern.unavailable": { en: "Concern information incomplete", es: "Información de problemas incompleta" },
  "jobsOverview.activity.unavailable": { en: "Some work activity unavailable", es: "Parte de la actividad de trabajo no está disponible" },
  "jobsOverview.activity.window": { en: "Latest recorded activity within the last 14 days. This does not establish attendance.", es: "Última actividad registrada en los últimos 14 días. Esto no confirma asistencia." },
  "jobsOverview.details": { en: "Details and concerns ({n})", es: "Detalles y problemas ({n})" },
  "jobsOverview.qcScope": { en: "Recorded installation progress; QC approval and other job scope are separate.", es: "Avance de instalación registrado; la aprobación de calidad y otros alcances son independientes." },
  "jobsOverview.attention.unknown": { en: "Some concern information is unavailable. Refresh to check.", es: "Parte de la información de problemas no está disponible. Actualiza para revisar." },
  "jobsOverview.changes.unknown": { en: "Some change history is unavailable.", es: "Parte del historial de cambios no está disponible." },
  "jobsOverview.changes.viewAll": { en: "View all changes ({n})", es: "Ver todos los cambios ({n})" },
  "jobsOverview.change.issueNew": { en: "New issue: {issue}", es: "Nuevo problema: {issue}" },
  "jobsOverview.change.issueResolved": { en: "Resolved: {issue}", es: "Resuelto: {issue}" },
  "jobsOverview.change.schedulePublished": { en: "Crew plan published for {day}", es: "Plan de cuadrilla publicado para {day}" },
  "jobsOverview.change.scheduleChanged": { en: "Published crew plan edited for {day}", es: "Plan publicado de cuadrilla modificado para {day}" },
  "jobsOverview.change.dailyLog": { en: "Daily log filed for {day}", es: "Registro diario enviado para {day}" },
  "jobsOverview.change.record": { en: "Recorded update", es: "Actualización registrada" },
  "jobsOverview.sources.other": { en: "Some overview information is unavailable.", es: "Parte de la información del panorama no está disponible." },
  "jobsOverview.sources.customSessions": { en: "Custom work activity unavailable.", es: "Actividad de trabajo personalizado no disponible." },
  "jobsOverview.sources.crewReports": { en: "Crew work reports unavailable.", es: "Reportes de trabajo de cuadrilla no disponibles." },
  "jobsOverview.issue.blocker": { en: "Reported blocker", es: "Bloqueo reportado" },
  "jobsOverview.issue.framing": { en: "Framing fix needed", es: "Se necesita corregir la estructura" },
  "jobsOverview.issue.failed_install": { en: "Failed install", es: "Instalación fallida" },
  "jobsOverview.issue.flag": { en: "Flagged issue", es: "Problema marcado" },
  "jobsOverview.issue.damage": { en: "Damage", es: "Daño" },
  "jobsOverview.issue.complication": { en: "Complication", es: "Complicación" },
  "jobsOverview.issue.missing": { en: "Missing delivery", es: "Entrega faltante" },
  "jobsOverview.issue.spec_gap": { en: "Spec sheet gap", es: "Falta en la hoja de especificaciones" },
  "jobsOverview.issue.missing_job": { en: "Job not built yet", es: "Trabajo aún sin crear" },
} satisfies Record<string, CatalogEntry>;

export type JobsOverviewKey = keyof typeof JOBS_OVERVIEW_CATALOG;

registerCatalog(JOBS_OVERVIEW_CATALOG);
