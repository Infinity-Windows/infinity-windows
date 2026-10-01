// The Work screen's phrasebook (crew redesign Release 1, 2026-09-23) —
// English and Spanish side by side, the same contract as catalog.ts.
//
// WHY A SECOND FILE: the main catalog ships in the entry chunk every phone
// downloads before it can draw anything, and that chunk sits a hair under
// its budget (scripts/check-bundle-budget.mjs). The Work screen, the new
// Schedule tab and their sheets are lazy routes, so their ~120 strings ride
// in THEIR chunk and register themselves into the live catalog the moment it
// loads (registerCatalog below) — before any of those components renders.
// Type-wise the keys are still part of TKey (catalog.ts imports this file's
// key TYPE only, which costs the entry nothing), so t("work.…") is checked
// like every other key.
//
// Every component under components/work/ and pages/work/ imports this file
// for its side effect, so a component rendered on its own — in a test, say —
// still speaks. A key used before registration renders empty, never a bare
// key (translate() never returns the key), and never crashes.

import type { CatalogEntry } from "./translate";
import { registerCatalog } from "./catalog";

export const WORK_CATALOG = {
  "work.title": { en: "Work", es: "Trabajo" },
  "work.clock.job": { en: "Job", es: "Trabajo" },
  "work.clock.costCode": { en: "Cost code", es: "Código de costo" },
  "work.clock.change": { en: "Change", es: "Cambiar" },
  "work.clock.pickJob": { en: "Pick a job", es: "Elegir trabajo" },
  "work.clock.startDay": { en: "Start day", es: "Iniciar el día" },
  "work.clock.starting": { en: "Starting…", es: "Iniciando…" },
  "work.clock.willOpenTalk": {
    en: "Opens today's toolbox talk first.",
    es: "Primero abre la charla de seguridad de hoy.",
  },
  "work.clock.paidFromTap": {
    en: "Paid time starts at this tap. Sign today's talk right after.",
    es: "El tiempo pagado empieza con este toque. Firma la charla de hoy justo después.",
  },
  "work.clock.clockedIn": { en: "Clocked in {time}", es: "Entrada {time}" },
  "work.clock.working": { en: "Working", es: "Trabajando" },
  "work.clock.onBreak": { en: "On break", es: "En descanso" },
  "work.clock.break": { en: "Break", es: "Descanso" },
  "work.clock.resume": { en: "Resume work", es: "Volver al trabajo" },
  "work.clock.clockOut": { en: "Clock out", es: "Marcar salida" },
  "work.clock.moreOptions": { en: "More clock options", es: "Más opciones del reloj" },
  "work.clock.queued": {
    en: "Saved on this phone — sends when you're back in signal.",
    es: "Guardado en este teléfono: se envía cuando vuelva la señal.",
  },
  "work.clock.needsFinish": { en: "Your clock stopped counting", es: "Tu reloj dejó de contar" },
  "work.clock.needsFinishSub": {
    en: "Tell us when you actually finished.",
    es: "Dinos cuándo terminaste en realidad.",
  },
  "work.clock.saveFinish": { en: "Set finish time", es: "Poner hora de salida" },
  "work.clock.a11y": { en: "Your clock", es: "Tu reloj" },
  // Shown while the clock is still being read (Codex review of #642): no
  // Start day until Forge knows whether a shift is already open.
  "work.clock.recovering": { en: "Recovering your clock…", es: "Recuperando tu reloj…" },
  "work.clock.recoveringSub": {
    en: "Checking your shift and anything saved on this phone before you start.",
    es: "Revisando tu turno y lo guardado en este teléfono antes de empezar.",
  },
  "work.toolbox.finish": { en: "Finish your toolbox talk", es: "Termina tu charla de seguridad" },
  "work.toolbox.finishHelp": {
    en: "You're on the clock. Sign today's talk to unlock unit work and prep time.",
    es: "Ya estás en horario. Firma la charla de hoy para poder trabajar en unidades y registrar tiempo de preparación.",
  },
  "work.toolbox.locked": {
    en: "Sign today's toolbox talk to start a unit.",
    es: "Firma la charla de seguridad de hoy para empezar una unidad.",
  },
  // SAFETY — the server's own refusal (_unit_work_gate), said on the phone.
  "work.toolbox.refused": {
    en: "Forge won't start a unit until today's toolbox talk is signed. Sign it under Finish your toolbox talk, then try again.",
    es: "Forge no empieza una unidad hasta que firmes la charla de seguridad de hoy. Fírmala en Termina tu charla de seguridad y vuelve a intentar.",
  },
  "work.today.heading": { en: "Today", es: "Hoy" },
  "work.today.nextUp": { en: "Next up · {day}", es: "Lo que sigue · {day}" },
  "work.today.none": {
    en: "No published work in the next 7 days.",
    es: "No hay trabajo publicado en los próximos 7 días.",
  },
  "work.today.starts": { en: "Starts {time}", es: "Empieza {time}" },
  "work.today.noTime": { en: "Start time not set", es: "Hora de inicio sin definir" },
  "work.today.with": { en: "With {names}", es: "Con {names}" },
  "work.today.truck": { en: "Truck: {truck}", es: "Camión: {truck}" },
  "work.today.updated": { en: "Updated {time}", es: "Actualizado {time}" },
  "work.today.changed": { en: "Changed", es: "Cambió" },
  "work.today.savedFrom": {
    en: "Showing your schedule from {time} — can't reach Forge",
    es: "Mostrando tu horario de las {time}: no hay conexión con Forge",
  },
  "work.today.unreachable": {
    en: "Can't reach Forge right now. Your schedule shows when you're back in signal.",
    es: "No hay conexión con Forge ahora. Tu horario aparecerá cuando vuelva la señal.",
  },
  "work.today.viewSchedule": { en: "Schedule", es: "Horario" },
  "work.today.directions": { en: "Directions", es: "Cómo llegar" },
  "work.today.meetTruck": { en: "Meet the truck — {label}", es: "Recibe el camión — {label}" },
  "work.today.delivery": { en: "delivery", es: "entrega" },
  "work.unit.heading": { en: "Your unit", es: "Tu unidad" },
  "work.unit.running": { en: "Working on", es: "Trabajando en" },
  "work.unit.nextUp": { en: "Next up", es: "Lo que sigue" },
  "work.unit.reason.yesterday": { en: "Unfinished from yesterday", es: "Sin terminar de ayer" },
  "work.unit.reason.assigned": { en: "Assigned to you", es: "Asignada a ti" },
  "work.unit.reason.available": { en: "Available on this job", es: "Disponible en este trabajo" },
  "work.unit.start": { en: "Start", es: "Empezar" },
  "work.unit.starting": { en: "Starting…", es: "Empezando…" },
  "work.unit.open": { en: "Open unit", es: "Abrir unidad" },
  "work.unit.continue": { en: "Continue", es: "Continuar" },
  "work.unit.pause": { en: "Pause", es: "Pausar" },
  "work.unit.finish": { en: "Finish", es: "Terminar" },
  "work.unit.new": { en: "New unit", es: "Nueva unidad" },
  "work.unit.syncRefused": { en: "Unit time was not saved", es: "El tiempo de la unidad no se guardó" },
  "work.unit.reviewSync": { en: "Review saved work", es: "Revisar trabajo guardado" },
  "work.unit.save": { en: "Save unit", es: "Guardar unidad" },
  "work.unit.saveStart": { en: "Save & start", es: "Guardar y empezar" },
  "work.unit.close": { en: "Close new unit", es: "Cerrar nueva unidad" },
  "work.unit.job": { en: "Job", es: "Trabajo" },
  "work.unit.chooseJob": { en: "Choose a job", es: "Elige un trabajo" },
  "work.unit.currentJob": { en: "Current job", es: "Trabajo actual" },
  "work.unit.startAfterClock": {
    en: "Save this unit, then clock into its job to start timed work.",
    es: "Guarda esta unidad y después registra la entrada en su trabajo para empezar a contar tiempo.",
  },
  "work.unit.justAdded": { en: "Just added", es: "Recién agregada" },
  "work.unit.openClock": { en: "Open job clock", es: "Abrir reloj del trabajo" },
  "work.unit.details": { en: "Unit details", es: "Detalles de la unidad" },
  "work.unit.savedUnits": { en: "Your saved units", es: "Tus unidades guardadas" },
  "work.unit.savedUnitsHelp": {
    en: "Open a unit to add details or work on it later.",
    es: "Abre una unidad para agregar detalles o trabajar en ella después.",
  },
  "work.unit.assignedJob": { en: "Assigned job", es: "Trabajo asignado" },
  "work.unit.allUnits": { en: "See all units", es: "Ver todas las unidades" },
  "work.unit.newHelp": {
    en: "Nothing matched on this job. Add the unit you're starting.",
    es: "Nada coincide en este trabajo. Agrega la unidad que vas a empezar.",
  },
  "work.unit.nothingYet": {
    en: "No unit yet. Start your day and your next unit shows here.",
    es: "Todavía no hay unidad. Inicia tu día y aquí aparecerá tu siguiente unidad.",
  },
  "work.unit.duplicate": { en: "Already on this job:", es: "Ya existe en este trabajo:" },
  "work.unit.useExisting": { en: "Use {label}", es: "Usar {label}" },
  "work.unit.startFailed": {
    en: "Couldn't start {code} — open it to see why.",
    es: "No se pudo empezar {code}: ábrela para ver por qué.",
  },
  "work.unit.type": { en: "Type", es: "Tipo" },
  "work.unit.label": { en: "Unit number / name", es: "Número / nombre de la unidad" },
  "work.unit.location": { en: "Location", es: "Ubicación" },
  "work.quick.prep": { en: "Prep time", es: "Tiempo de preparación" },
  "work.quick.supplies": { en: "Take supplies", es: "Tomar material" },
  "work.quick.log": { en: "Daily log", es: "Reporte del día" },
  "work.quick.problem": { en: "Report a problem", es: "Reportar un problema" },
  "work.quick.needJob": { en: "Start your day first.", es: "Inicia tu día primero." },
  "work.prep.title": { en: "Prep time", es: "Tiempo de preparación" },
  "work.prep.help": {
    en: "Job work that isn't on one unit. Pick what you're doing.",
    es: "Trabajo del proyecto que no es de una sola unidad. Elige qué estás haciendo.",
  },
  "work.prep.reason.Gathering": { en: "Gathering", es: "Juntando material" },
  "work.prep.reason.Hauling": { en: "Hauling", es: "Acarreando" },
  "work.prep.reason.Setup": { en: "Setup", es: "Preparación" },
  "work.prep.reason.Errand": { en: "Errand", es: "Mandado" },
  "work.prep.reason.Cleanup": { en: "Cleanup", es: "Limpieza" },
  "work.prep.reason.Other": { en: "Other", es: "Otro" },
  "work.prep.note": { en: "Say more (optional)", es: "Cuenta más (opcional)" },
  "work.prep.start": { en: "Start prep time", es: "Iniciar tiempo de preparación" },
  "work.prep.running": { en: "Prep time · {reason}", es: "Tiempo de preparación · {reason}" },
  "work.prep.stop": { en: "Stop prep time", es: "Detener tiempo de preparación" },
  "work.prep.cancel": { en: "Cancel", es: "Cancelar" },
  "work.prep.needClock": {
    en: "Start your day to record prep time.",
    es: "Inicia tu día para registrar tiempo de preparación.",
  },
  "work.prep.pendingClock": {
    en: "Your clock is still sending. Prep time can start once it's saved in Forge.",
    es: "Tu reloj todavía se está enviando. El tiempo de preparación puede empezar cuando se guarde en Forge.",
  },
  // SAFETY — Prep time waits for today's talk like unit work (K1.3, the
  // owner's answer of 2026-09-24): the lock in words, and the server's own
  // refusal (_prep_time_gate), said on the phone.
  "work.prep.locked": {
    en: "Sign today's toolbox talk to start prep time.",
    es: "Firma la charla de seguridad de hoy para empezar el tiempo de preparación.",
  },
  "work.prep.refused": {
    en: "Forge won't start prep time until today's toolbox talk is signed. Sign it under Finish your toolbox talk, then try again.",
    es: "Forge no empieza el tiempo de preparación hasta que firmes la charla de seguridad de hoy. Fírmala en Termina tu charla de seguridad y vuelve a intentar.",
  },
  "work.problem.title": { en: "Report a problem", es: "Reportar un problema" },
  "work.problem.help": { en: "Your lead sees it right away.", es: "Tu encargado lo ve de inmediato." },
  "work.problem.kind.blocker": { en: "I'm blocked", es: "Estoy bloqueado" },
  "work.problem.kind.damage": { en: "Damage", es: "Daño" },
  "work.problem.kind.missing": { en: "Missing material", es: "Falta material" },
  "work.problem.kind.complication": { en: "Something else", es: "Otra cosa" },
  "work.problem.urgent": { en: "Urgent", es: "Urgente" },
  "work.problem.note": { en: "What's going on?", es: "¿Qué está pasando?" },
  "work.problem.send": { en: "Send to my lead", es: "Enviar a mi encargado" },
  "work.problem.sending": { en: "Sending…", es: "Enviando…" },
  "work.problem.sent": { en: "Sent. Your lead will see it.", es: "Enviado. Tu encargado lo verá." },
  "work.problem.onUnit": { en: "About {label}", es: "Sobre {label}" },
  "work.problem.cancel": { en: "Cancel", es: "Cancelar" },
  "work.headsUp.toolbox": { en: "Toolbox talk not signed yet", es: "Charla de seguridad sin firmar" },
  "work.headsUp.photo.one": {
    en: "1 photo hasn't sent for over an hour",
    es: "1 foto lleva más de una hora sin enviarse",
  },
  "work.headsUp.photo.many": {
    en: "{n} photos haven't sent for over an hour",
    es: "{n} fotos llevan más de una hora sin enviarse",
  },
  "work.headsUp.assignment": { en: "Your schedule changed", es: "Tu horario cambió" },
  "work.headsUp.qc.one": { en: "1 unit is waiting for QC", es: "1 unidad espera QC" },
  "work.headsUp.qc.many": { en: "{n} units are waiting for QC", es: "{n} unidades esperan QC" },
  "work.headsUp.a11y": { en: "Heads-ups", es: "Avisos" },
  "work.lead.jobs": { en: "Jobs", es: "Trabajos" },
  "work.lead.crew": { en: "Crew", es: "Equipo" },
  // K1.6: the Schedule tab.
  "work.schedule.showMore": { en: "Show more · through {day}", es: "Mostrar más · hasta el {day}" },
  "work.schedule.nothingThrough": {
    en: "Nothing published through {day} yet.",
    es: "Todavía no hay nada publicado hasta el {day}.",
  },
  "work.schedule.editInScheduling": { en: "View only — edit in Scheduling", es: "Solo lectura: edita en Programación" },
  "work.lead.overview": { en: "Overview", es: "Panorama" },
  "work.lead.timecards": { en: "Team timecards", es: "Tarjetas del equipo" },
  "work.jobPick.title": { en: "Where are you working?", es: "¿Dónde vas a trabajar?" },
  "work.jobPick.scheduled": { en: "Scheduled today", es: "Programado hoy" },
  "work.jobPick.recent": { en: "Recent", es: "Recientes" },
  "work.jobPick.search": { en: "Search jobs", es: "Buscar trabajos" },
  "work.jobPick.allJobs": { en: "All jobs", es: "Todos los trabajos" },
  "work.jobPick.done": { en: "Done", es: "Listo" },
  "work.jobPick.mode": { en: "What are you here to do?", es: "¿Qué vas a hacer?" },
  "work.jobPick.note": { en: "Note for the office (optional)", es: "Nota para la oficina (opcional)" },
  "work.jobPick.noMatch": { en: "No jobs match “{q}”", es: "Ningún trabajo coincide con “{q}”" },

  // ---- The cross-job Daily Logs page (Horizon parity, 2026-10-01) --------
  "dailyLogsPage.title": { en: "Daily Logs", es: "Registros diarios" },
  "dailyLogsPage.subtitle": { en: "All logs across your jobs", es: "Todos los registros de tus trabajos" },
  "dailyLogsPage.search": { en: "Search project, summary, author", es: "Buscar trabajo, resumen, autor" },
  "dailyLogsPage.searchJob": { en: "Search jobs", es: "Buscar trabajos" },
  "dailyLogsPage.noJobsMatch": { en: "No jobs match that search.", es: "Ningún trabajo coincide con esa búsqueda." },
  "dailyLogsPage.from": { en: "From", es: "Desde" },
  "dailyLogsPage.to": { en: "To", es: "Hasta" },
  "dailyLogsPage.rangeNote": { en: "Showing {from} – {to}. A progress reading on a card is as of that log's own date, not today.", es: "Mostrando {from} – {to}. El progreso de una tarjeta es a la fecha de ese registro, no de hoy." },
  "dailyLogsPage.loadMore": { en: "Load more", es: "Cargar más" },
  "dailyLogsPage.notFound": { en: "That log couldn't be found.", es: "No se encontró ese registro." },
  "dailyLogsPage.unknownJob": { en: "Job no longer in Forge", es: "Trabajo ya no está en Forge" },
  "dailyLogsPage.back": { en: "Back", es: "Atrás" },
  "dailyLogsPage.copyLink": { en: "Copy link", es: "Copiar enlace" },
  "dailyLogsPage.print": { en: "Print", es: "Imprimir" },
  "dailyLogsPage.linkCopied": { en: "Link copied", es: "Enlace copiado" },
  "dailyLogsPage.linkCopyFailed": { en: "Couldn't copy the link", es: "No se pudo copiar el enlace" },
  "dailyLogsPage.submitted": { en: "SUBMITTED", es: "ENVIADO" },
  "dailyLogsPage.submittedOn": { en: "Submitted {date}", es: "Enviado {date}" },
  "dailyLogsPage.facts.project": { en: "Project", es: "Proyecto" },
  "dailyLogsPage.facts.date": { en: "Date", es: "Fecha" },
  "dailyLogsPage.facts.submittedBy": { en: "Submitted by", es: "Enviado por" },
  "dailyLogsPage.allJobs": { en: "All jobs", es: "Todos los trabajos" },
  "dailyLogsPage.card.photos": { en: "{count} photo(s)", es: "{count} foto(s)" },
  "dailyLogsPage.card.stopped": { en: "Stopped", es: "Detenido" },
  "dailyLogsPage.card.needed": { en: "Needed tomorrow", es: "Se necesita mañana" },
  "dailyLogsPage.card.noPhotos": { en: "No photos", es: "Sin fotos" },
  "dailyLogsPage.card.latestAsOf": { en: "Latest in this range, as of {date}", es: "Más reciente en este rango, al {date}" },
  "dailyLogsPage.card.reportedAsOf": { en: "Reported as of {date}", es: "Reportado al {date}" },
  "dailyLogsPage.card.latestUnknown": { en: "Latest — date unknown", es: "Más reciente — fecha desconocida" },
  "dailyLogsPage.card.firstReading": { en: "first", es: "primera" },
  "dailyLogsPage.overview.title": { en: "Latest progress in this range", es: "Progreso más reciente en este rango" },
  "dailyLogsPage.overview.noneInWindow": { en: "No report for this job in the selected dates.", es: "No hay reporte de este trabajo en las fechas seleccionadas." },
  "dailyLogsPage.searchNoMatchYet": { en: "No matches in the {count} logs loaded so far. Load more to search further back.", es: "Sin coincidencias en los {count} registros cargados. Carga más para buscar más atrás." },
} satisfies Record<string, CatalogEntry>;

export type WorkKey = keyof typeof WORK_CATALOG;

registerCatalog(WORK_CATALOG);
