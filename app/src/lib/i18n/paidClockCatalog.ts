import { registerCatalog } from "./catalog";
import type { CatalogEntry } from "./translate";
export const PAID_CLOCK_CATALOG = {
  "paidClock.title": { en:"Saved clock punches", es:"Marcaciones guardadas" },
  "paidClock.loading": { en:"Reading saved punches…", es:"Leyendo marcaciones guardadas…" },
  "paidClock.unavailable": { en:"Saved punches could not be read. Keep this device and check again before making a replacement punch.", es:"No se pudieron leer las marcaciones guardadas. Conserva este dispositivo y vuelve a revisar antes de crear otra marcación." },
  "paidClock.clock_in": { en:"Clock in", es:"Entrada" },
  "paidClock.break_start": { en:"Start break", es:"Comenzar descanso" },
  "paidClock.break_end": { en:"End break", es:"Terminar descanso" },
  "paidClock.clock_out": { en:"Clock out", es:"Salida" },
  "paidClock.queued": { en:"Saved on this device · awaiting confirmation", es:"Guardada en este dispositivo · pendiente de confirmación" },
  "paidClock.unknown": { en:"Confirmation pending · Forge may already have received this punch", es:"Confirmación pendiente · Forge puede haber recibido esta marcación" },
  "paidClock.review": { en:"Needs review · no completion is assumed", es:"Necesita revisión · no se supone que se haya completado" },
  "paidClock.acknowledged": { en:"Delivery confirmed · historical receipt", es:"Entrega confirmada · comprobante histórico" },
  "paidClock.historyHelp": { en:"A receipt confirms delivery of that punch. Current paid time and work status come from the latest shift and activity records.", es:"Un comprobante confirma la entrega de esa marcación. El tiempo pagado y el estado actual del trabajo vienen de los registros más recientes del turno y las actividades." },
  "paidClock.check": { en:"Check confirmation", es:"Revisar confirmación" },
  "paidClock.resend": { en:"Resend original punch", es:"Reenviar marcación original" },
  "paidClock.resendHelp": { en:"This sends the same saved punch and original tap time. An unresolved reply stays unresolved until its matching confirmation arrives.", es:"Esto envía la misma marcación guardada y su hora original. Una respuesta sin resolver sigue sin resolverse hasta que llegue la confirmación correspondiente." },
  "paidClock.working": { en:"Checking this punch…", es:"Revisando esta marcación…" },
  "paidClock.offline": { en:"Reconnect to check or resend the original punch.", es:"Vuelve a conectarte para revisar o reenviar la marcación original." },
  "paidClock.held": { en:"No new confirmation was found. This punch is not treated as complete; review the saved requests above.", es:"No se encontró una confirmación nueva. Esta marcación no se considera completa; revisa las solicitudes guardadas arriba." },
  "paidClock.failed": { en:"This punch could not be checked. Read the saved requests again before trying another action.", es:"No se pudo revisar esta marcación. Vuelve a leer las solicitudes guardadas antes de intentar otra acción." },
  "paidClock.refresh": { en:"Read saved punches again", es:"Volver a leer marcaciones guardadas" },
} satisfies Record<string,CatalogEntry>;
export type PaidClockKey = keyof typeof PAID_CLOCK_CATALOG;
registerCatalog(PAID_CLOCK_CATALOG);
