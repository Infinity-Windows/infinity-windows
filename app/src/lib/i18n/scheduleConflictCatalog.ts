// The schedule double-booking / hours-review phrasebook — English and
// Spanish side by side, the same contract as catalog.ts.
//
// WHY A SECOND FILE: Scheduling, the assignment editor and Notifications are
// each their own lazy route/chunk (see workCatalog.ts's header for the full
// story), so these strings ride in those chunks and register themselves into
// the live catalog the moment one of those chunks loads — before any
// component that reads them renders. A component that uses these keys
// imports this file for its side effect (registerCatalog below).
//
// Two kinds of clash get distinct wording on purpose: a CONFIRMED
// double-booking (both assignments' hours are known and actually overlap)
// vs. an hours-NEEDS-REVIEW pair (one side's hours are missing or malformed,
// so it can't be ruled out, but it must never read as a confirmed clash).

import type { CatalogEntry } from "./translate";
import { registerCatalog } from "./catalog";

export const SCHEDULE_CONFLICT_CATALOG = {
  "schedConflict.aJob": { en: "a job", es: "un trabajo" },
  "schedConflict.noHoursSet": { en: "Start/end not set", es: "Sin hora de inicio/fin" },
  "schedConflict.timeNotSet": { en: "not set", es: "sin hora" },
  "schedConflict.checkTime": { en: "check time", es: "revisa la hora" },
  "schedConflict.dailyOverlap": { en: "Overlap each shared day: {hours}", es: "Traslape cada día compartido: {hours}" },
  "schedConflict.checkHoursAction": { en: "Add or check start/end times to see whether these jobs overlap.", es: "Agrega o revisa las horas de inicio y fin para saber si estos trabajos se traslapan." },
  "schedConflict.fix": { en: "Fix", es: "Resolver" },
  "schedConflict.hoursUnknown": { en: "hours not set", es: "sin horario" },

  "schedConflict.banner.confirmedHeading.one": {
    en: "1 double-booking to sort out",
    es: "1 doble asignación por resolver",
  },
  "schedConflict.banner.confirmedHeading.many": {
    en: "{n} double-bookings to sort out",
    es: "{n} dobles asignaciones por resolver",
  },
  "schedConflict.banner.reviewHeading.one": {
    en: "Hours need review: 1 booking pair",
    es: "Horas por revisar: 1 par de asignaciones",
  },
  "schedConflict.banner.reviewHeading.many": {
    en: "Hours need review: {n} booking pairs",
    es: "Horas por revisar: {n} pares de asignaciones",
  },
  "schedConflict.banner.confirmedRow": {
    en: "{name}",
    es: "{name}",
  },
  "schedConflict.banner.reviewRow": {
    en: "{name}",
    es: "{name}",
  },

  "schedConflict.editor.confirmed": {
    en: "Double-booked: {names}. These hours overlap.",
    es: "Doble asignación: {names}. Estas horas se traslapan.",
  },
  "schedConflict.editor.review": {
    en: "Hours need review: {names}.",
    es: "Horas por revisar: {names}.",
  },

  "schedConflict.publishBadge.confirmed": { en: "· {n} double-booked", es: "· {n} con doble asignación" },
  "schedConflict.publishBadge.review": { en: "· {n} need hours review", es: "· {n} con horario por revisar" },

  "schedConflict.publishSheet.confirmedHeading": {
    en: "Heads-up: {n} double-booked",
    es: "Aviso: {n} con doble asignación",
  },
  "schedConflict.publishSheet.reviewHeading": {
    en: "Hours need review: {n} crew",
    es: "Horas por revisar: {n} personas",
  },
  "schedConflict.publishSheet.confirmedRow": {
    en: "{name} — {n} overlapping jobs",
    es: "{name} — {n} trabajos que se cruzan",
  },
  "schedConflict.publishSheet.reviewRow": {
    en: "{name} — {n} jobs with hours to check",
    es: "{name} — {n} trabajos con horario por revisar",
  },
  "schedConflict.publishSheet.note": {
    en: "You can still publish; this is just a warning.",
    es: "Aún puedes publicar; esto es solo un aviso.",
  },
  "schedConflict.publishSheet.none": {
    en: "No conflicts detected.",
    es: "No se detectaron conflictos.",
  },

  "schedConflict.notif.confirmedTitle.one": { en: "1 crew double-booked", es: "1 persona con doble asignación" },
  "schedConflict.notif.confirmedTitle.many": { en: "{n} crew double-booked", es: "{n} personas con doble asignación" },
  "schedConflict.notif.confirmedSub": {
    en: "Overlapping schedule assignments — resolve before publishing",
    es: "Asignaciones de horario que se cruzan — resuélvelas antes de publicar",
  },
  "schedConflict.notif.reviewTitle.one": { en: "Hours need review: 1 crew member", es: "Horas por revisar: 1 persona" },
  "schedConflict.notif.reviewTitle.many": { en: "Hours need review: {n} crew members", es: "Horas por revisar: {n} personas" },
  "schedConflict.notif.reviewSub": {
    en: "Check start/end times to see whether these jobs overlap",
    es: "Revisa la hora de inicio y fin para saber si estos trabajos se traslapan",
  },
} satisfies Record<string, CatalogEntry>;

export type ScheduleConflictKey = keyof typeof SCHEDULE_CONFLICT_CATALOG;

registerCatalog(SCHEDULE_CONFLICT_CATALOG);
