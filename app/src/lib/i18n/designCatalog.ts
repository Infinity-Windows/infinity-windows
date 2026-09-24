// The design-switch card's phrasebook (crew redesign Release 1, K-X2 and
// K1.3's owner date). Lazy for the same reason workCatalog.ts is: the card
// lives in its own chunk (Settings loads it on demand), so its strings ride
// there and register into the live catalog when it loads — see catalog.ts's
// registerCatalog. The four "Try the new Forge" lines stay in the main
// catalog because the classic landings render that card eagerly.

import type { CatalogEntry } from "./translate";
import { registerCatalog } from "./catalog";

export const DESIGN_CATALOG = {
  // K-X2: the design switch, per person, plus the owner's master switch.
  "design.heading": { en: "Design", es: "Diseño" },
  "design.help": {
    en: "The new Forge puts your clock, today's job and your next unit on one Work screen. Your work saves the same either way. Switch back any time.",
    es: "El nuevo Forge pone tu reloj, el trabajo de hoy y tu siguiente unidad en una sola pantalla de Trabajo. Tu trabajo se guarda igual de las dos formas. Vuelve cuando quieras.",
  },
  "design.useNew": { en: "Use the new design", es: "Usar el nuevo diseño" },
  "design.useClassic": { en: "Use the classic design", es: "Usar el diseño clásico" },
  "design.current.new": { en: "You're on the new design.", es: "Estás en el nuevo diseño." },
  "design.current.classic": { en: "You're on the classic design.", es: "Estás en el diseño clásico." },
  "design.masterOff": {
    en: "The owner has turned the new design off for everyone for now. Your choice is kept for when it comes back.",
    es: "El dueño desactivó el nuevo diseño para todos por ahora. Tu elección se guarda para cuando vuelva.",
  },
  "design.owner.heading": { en: "New design master switch", es: "Interruptor general del nuevo diseño" },
  "design.owner.help": {
    en: "Owner only. Off sends everyone back to the classic screens at once; people's own choices are kept and come back when it's on again.",
    es: "Solo el dueño. Apagado regresa a todos a las pantallas clásicas de una vez; la elección de cada persona se guarda y vuelve cuando se encienda de nuevo.",
  },
  "design.owner.on": { en: "On — people can choose it", es: "Encendido: la gente puede elegirlo" },
  "design.owner.off": { en: "Off for everyone", es: "Apagado para todos" },
  "design.owner.turnOff": { en: "Turn off for everyone", es: "Apagar para todos" },
  "design.owner.turnOn": { en: "Turn on", es: "Encender" },
  "design.owner.saving": { en: "Saving…", es: "Guardando…" },
  // K1.3 / Q69: the paid-time rule's effective date (owner only).
  "paidTime.heading": { en: "Paid time starts at Start day", es: "El tiempo pagado empieza al Iniciar el día" },
  "paidTime.help": {
    en: "Owner only. From this date, paid time starts the moment someone taps Start day — before the toolbox talk is signed. Until then, today's timing applies. One date for everyone, and no shift already on record changes.",
    es: "Solo el dueño. Desde esta fecha, el tiempo pagado empieza en el momento en que alguien toca Iniciar el día, antes de firmar la charla de seguridad. Hasta entonces aplica el horario de hoy. Una sola fecha para todos y ningún turno ya registrado cambia.",
  },
  "paidTime.from": { en: "Starts on", es: "Empieza el" },
  "paidTime.state.off": { en: "Off — today's timing applies.", es: "Apagado: aplica el horario de hoy." },
  "paidTime.state.scheduled": { en: "Starts {date} for everyone.", es: "Empieza el {date} para todos." },
  "paidTime.state.on": { en: "On for everyone since {date}.", es: "Activo para todos desde el {date}." },
  "paidTime.save": { en: "Save date", es: "Guardar fecha" },
  "paidTime.clear": { en: "Turn off", es: "Apagar" },
  "paidTime.saved": { en: "Saved.", es: "Guardado." },
} satisfies Record<string, CatalogEntry>;

export type DesignKey = keyof typeof DESIGN_CATALOG;

registerCatalog(DESIGN_CATALOG);
