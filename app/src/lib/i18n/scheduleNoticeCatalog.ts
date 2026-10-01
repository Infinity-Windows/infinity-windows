// The schedule-change-notice phrasebook — English and Spanish side by side,
// the same contract as catalog.ts.
//
// WHY A SEPARATE FILE: Notifications is its own lazy route/chunk (see
// workCatalog.ts's header for the full story), so these strings ride in that
// chunk and register themselves into the live catalog the moment it loads.
// Notifications.tsx imports this file for its side effect (registerCatalog).
//
// The title is deliberately plain ("Check your schedule"), not an accusation
// that every listed job changed — the row reopens whenever ANY of the
// person's assignments gets a substantive date/hour change, and the rows
// underneath always show what is CURRENTLY scheduled, never a diff.

import type { CatalogEntry } from "./translate";
import { registerCatalog } from "./catalog";

export const SCHEDULE_NOTICE_CATALOG = {
  "schedNotice.title": { en: "Check your schedule", es: "Revisa tu horario" },
  "schedNotice.sub": {
    en: "Current jobs, dates and hours. Tap to see your full schedule.",
    es: "Trabajos, fechas y horarios actuales. Toca para ver tu horario completo.",
  },
  "schedNotice.job": { en: "Job", es: "Trabajo" },
  "schedNotice.delivery": { en: "Delivery", es: "Entrega" },
  "schedNotice.more": { en: "+{n} more", es: "+{n} más" },
} satisfies Record<string, CatalogEntry>;

export type ScheduleNoticeKey = keyof typeof SCHEDULE_NOTICE_CATALOG;

registerCatalog(SCHEDULE_NOTICE_CATALOG);
