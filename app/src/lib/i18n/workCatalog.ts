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

  // Foreman unit contributors (2026-09-30): record_stage_contributors /
  // correct_stage_contributors, the compact action below the lead row.
  "work.contrib.title": { en: "Unit contributors", es: "Colaboradores de la unidad" },
  "work.contrib.confirmed": { en: "Contributors confirmed in Forge.", es: "Colaboradores confirmados en Forge." },
  "work.contrib.unavailable": { en: "Contributor records are not available yet. Refresh after the update finishes.", es: "Los registros de colaboradores aún no están disponibles. Actualiza cuando termine la actualización." },
  "work.contrib.pendingTitle": { en: "Pending contributor records", es: "Registros de colaboradores pendientes" },
  "work.contrib.retry": { en: "Retry saved work", es: "Reintentar el trabajo guardado" },
  "work.contrib.reviewPending": { en: "Review saved requests", es: "Revisar solicitudes guardadas" },
  "work.contrib.removedPerson": { en: "Attribution removed: {name}", es: "Atribución retirada: {name}" },
  "work.contrib.stage.RO checked": { en: "RO checked", es: "Vano revisado" },
  "work.contrib.stage.Installing": { en: "Installing", es: "Instalación" },
  "work.contrib.stage.Preparation": { en: "Preparation", es: "Preparación" },
  "work.contrib.stage.Flashing": { en: "Flashing", es: "Impermeabilización" },
  "work.contrib.stage.Setting frame": { en: "Setting frame", es: "Colocación del marco" },
  "work.contrib.stage.Glazing": { en: "Glazing", es: "Acristalamiento" },
  "work.contrib.stage.Hardware": { en: "Hardware", es: "Herrajes" },
  "work.contrib.stage.Detail work": { en: "Detail work", es: "Detalles" },
  "work.contrib.stage.Rework": { en: "Rework", es: "Retrabajo" },
  "work.contrib.openWrite": { en: "Add contributors", es: "Agregar colaboradores" },
  "work.contrib.openRead": { en: "View contributors", es: "Ver colaboradores" },
  "work.contrib.saved": { en: "Saved on this device. See the summary below for confirmation.", es: "Guardado en este dispositivo. Consulta el resumen para confirmar." },
  "work.contrib.help": {
    en: "Select a saved unit or a map opening, then who actually worked it and when — even off the clock, with no unit timer.",
    es: "Selecciona una unidad guardada o una apertura del mapa, luego quién la trabajó y cuándo, incluso fuera de turno y sin temporizador.",
  },
  "work.contrib.job": { en: "Job", es: "Trabajo" },
  "work.contrib.chooseJob": { en: "Choose job", es: "Elegir trabajo" },
  "work.contrib.unit": { en: "Unit or map opening", es: "Unidad o apertura del mapa" },
  "work.contrib.chooseUnit": { en: "Choose unit", es: "Elegir unidad" },
  "work.contrib.mapUnit": { en: "Map opening", es: "Apertura del mapa" },
  "work.contrib.stage": { en: "Stage", es: "Etapa" },
  "work.contrib.date": { en: "Work date", es: "Fecha de trabajo" },
  "work.contrib.summary": { en: "Currently credited", es: "Actualmente acreditado" },
  "work.contrib.loading": { en: "Loading…", es: "Cargando…" },
  "work.contrib.none": { en: "No contributors to show for this stage and date.", es: "No hay colaboradores que mostrar para esta etapa y fecha." },
  "work.contrib.formerWorker": { en: "Former crew member", es: "Exmiembro del equipo" },
  "work.contrib.pending": { en: "{count} saved on this device — awaiting sync", es: "{count} guardado en este dispositivo — pendiente de sincronizar" },
  "work.contrib.history": { en: "History", es: "Historial" },
  "work.contrib.historyFiled": { en: "Filed by {name}", es: "Registrado por {name}" },
  "work.contrib.historyCorrected": { en: "Corrected by {name}", es: "Corregido por {name}" },
  "work.contrib.correct": { en: "Correct this", es: "Corregir esto" },
  "work.contrib.removePeople": { en: "Remove", es: "Quitar" },
  "work.contrib.addPeople": { en: "Add instead", es: "Agregar en su lugar" },
  "work.contrib.reason": { en: "Reason for this correction", es: "Motivo de esta corrección" },
  "work.contrib.reasonRequired": { en: "Enter a short reason for this correction.", es: "Ingresa un motivo breve para esta corrección." },
  "work.contrib.correcting": { en: "Saving correction…", es: "Guardando corrección…" },
  "work.contrib.saveCorrection": { en: "Save correction", es: "Guardar corrección" },
  "work.contrib.cancelCorrection": { en: "Cancel correction", es: "Cancelar corrección" },
  "work.contrib.outcome": { en: "Status", es: "Estado" },
  "work.contrib.finished": { en: "Stage completed", es: "Etapa terminada" },
  "work.contrib.partial": { en: "Partially completed", es: "Parcialmente terminado" },
  "work.contrib.people": { en: "Who worked it?", es: "¿Quién la trabajó?" },
  "work.contrib.search": { en: "Search crew", es: "Buscar equipo" },
  "work.contrib.selected": { en: "{count} selected", es: "{count} seleccionados" },
  "work.contrib.notes": { en: "Notes (optional)", es: "Notas (opcional)" },
  "work.contrib.noTime": { en: "This does not add payroll hours, start a timer, approve QC or mark the unit complete.", es: "Esto no agrega horas de nómina, inicia temporizador, aprueba calidad ni marca la unidad como completa." },
  "work.contrib.saving": { en: "Saving…", es: "Guardando…" },
  "work.contrib.save": { en: "Save contributors", es: "Guardar colaboradores" },
  "work.contrib.close": { en: "Close", es: "Cerrar" },
} satisfies Record<string, CatalogEntry>;

export type WorkKey = keyof typeof WORK_CATALOG;

registerCatalog(WORK_CATALOG);
