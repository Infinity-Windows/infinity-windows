// The crew-flow phrasebook, English and Spanish side by side.
//
// WHY THIS EXISTS (standard-tracking-jobs grill, 2026-09-02): most of the
// install crew reads Spanish more comfortably than English. This slice seeds the
// CREW FLOW — the morning-to-install loop a person actually lives in on a phone:
// the clock-in sheet, My Work, the summon strip, the install sheet's top-level
// actions, and the photo capture sheet. It is NOT the whole app; the rest is
// slice 7. Adding a key is one entry with both languages — that is the contract:
// every string ships in English AND Spanish from the start, never English alone
// (CatalogEntry requires `es`, so an English-only entry will not compile).
//
// SAFETY / TOOLBOX / INJURY strings are flagged below and in SAFETY_KEYS. Their
// Spanish is a solid first pass, NOT final safety-critical copy — a bilingual
// crew member verifies the wording before it is trusted in the field. Keep the
// flag on any safety string you add here.

import type { CatalogEntry } from "./translate";

/**
 * Keys whose Spanish still needs a bilingual crew member to verify it — the
 * toolbox talk, the injury report, the "clock in first / sign the talk" nudges.
 * A test asserts every one of these has both languages present; the review is
 * about the WORDS being right for safety, not about them merely existing.
 */
export const SAFETY_KEYS = [
  "clock.injury.was",
  "clock.injury.whatHappened",
  "clock.injury.emergency",
  "clock.injury.placeholder",
  "clock.toolbox.signed",
  "clock.toolbox.signToClockIn",
  "clockblock.signFirst",
  "clockblock.signAndClockIn",
  "toolbox.today",
  "toolbox.read",
  "toolbox.pledge",
  "toolbox.typeName",
  "toolbox.sign",
  "toolbox.signTalk",
  "toolbox.signing",
  "opening.action.signToolbox",
] as const;

export const CATALOG = {
  // ---- First-login language picker -------------------------------------
  "picker.heading": { en: "Choose your language", es: "Elige tu idioma" },
  "picker.help": {
    en: "You can change this later in Settings.",
    es: "Puedes cambiarlo después en Ajustes.",
  },
  // Each option names itself in its own language, the usual way a language
  // chooser reads — so a Spanish reader recognizes "Español" at a glance.
  "picker.english": { en: "English", es: "English" },
  "picker.spanish": { en: "Español", es: "Español" },

  // ---- Settings language toggle ----------------------------------------
  "settings.language.heading": { en: "Language", es: "Idioma" },
  "settings.language.help": {
    en: "Choose the language the app speaks to you in.",
    es: "Elige el idioma en el que la app te habla.",
  },

  // ---- Clock-in sheet ---------------------------------------------------
  "clock.title.pick": {
    en: "Where are you working?",
    es: "¿Dónde estás trabajando?",
  },
  "clock.title.switch": { en: "Switch project", es: "Cambiar de trabajo" },
  "clock.title.break": { en: "Go on break", es: "Tomar un descanso" },
  "clock.title.onBreak": { en: "On break", es: "En descanso" },
  "clock.title.onClock": { en: "On the clock", es: "En horario" },
  "clock.status.working": { en: "Working", es: "Trabajando" },
  // Hero-card subtitles on the on-the-clock screen. Were hard-coded English on
  // the crew flow (slice 7 fix). The running time follows in its own element.
  "clock.hero.workedSoFar": { en: "Worked so far", es: "Trabajado hasta ahora" },
  "clock.hero.breaksToday": { en: "Breaks today", es: "Descansos hoy" },
  "clock.label.youreOn": { en: "You're on", es: "Estás en" },
  "clock.label.switchCostCode": {
    en: "Switch cost code",
    es: "Cambiar código de costo",
  },
  "clock.label.costCode": { en: "Cost code", es: "Código de costo" },
  "clock.label.scheduledToday": {
    en: "Scheduled today",
    es: "Programado para hoy",
  },
  "clock.label.recentJobs": { en: "Recent jobs", es: "Trabajos recientes" },
  "clock.label.chooseDifferentJob": {
    en: "Choose a different job",
    es: "Elegir otro trabajo",
  },
  "clock.label.hideJobList": { en: "Hide job list", es: "Ocultar lista de trabajos" },
  "clock.search.jobs": { en: "Search jobs…", es: "Buscar trabajos…" },
  "clock.search.noJobs": {
    en: "No jobs match “{q}”.",
    es: "Ningún trabajo coincide con «{q}».",
  },
  "clock.label.notesOffice": {
    en: "Notes for the office (optional)",
    es: "Notas para la oficina (opcional)",
  },
  "clock.label.whenFinish": {
    en: "When did you finish?",
    es: "¿Cuándo terminaste?",
  },
  "clock.break.pauseNote": {
    en: "Your timecard pauses until you tap Resume.",
    es: "Tu tarjeta de tiempo se pausa hasta que toques Reanudar.",
  },
  "clock.action.startClock": { en: "Start clock", es: "Marcar entrada" },
  "clock.action.clockingIn": { en: "Clocking in…", es: "Marcando entrada…" },
  "clock.action.clockOut": { en: "Clock out", es: "Marcar salida" },
  "clock.action.clockingOut": { en: "Clocking out…", es: "Marcando salida…" },
  "clock.action.goOnBreak": { en: "Go on break", es: "Tomar un descanso" },
  "clock.action.resumeWork": { en: "Resume work", es: "Volver al trabajo" },
  "clock.action.switchProject": { en: "Switch project", es: "Cambiar de trabajo" },
  "clock.action.switching": { en: "Switching…", es: "Cambiando…" },
  "clock.action.cancel": { en: "Cancel", es: "Cancelar" },
  "clock.action.viewTimecard": {
    en: "View my timecard",
    es: "Ver mi tarjeta de tiempo",
  },
  "clock.action.saveFinish": {
    en: "Save my finish time",
    es: "Guardar mi hora de salida",
  },
  "clock.action.saving": { en: "Saving…", es: "Guardando…" },
  "clock.action.startOn": {
    en: "Start clock on {code}",
    es: "Marca entrada en {code}",
  },
  "clock.action.resumeOn": { en: "Resume on {job}", es: "Volver a {job}" },
  "clock.timeWrong": {
    en: "My recorded time looks wrong — flag it for office review",
    es: "Mi tiempo registrado se ve mal — márcalo para que la oficina lo revise",
  },
  // Clock sheet chrome + result toasts, the last English the clock-in flow
  // carried (tracking-jobs slice 7, 2026-09-03). The "…Queued" variants are the
  // offline-outbox wording shown when a punch is saved to sync later.
  "clock.a11y.timeClock": { en: "Time clock", es: "Reloj de tiempo" },
  "clock.a11y.close": { en: "Close", es: "Cerrar" },
  "clock.a11y.timeWorked": { en: "Time worked", es: "Tiempo trabajado" },
  "clock.jobLabel": { en: "Job", es: "Trabajo" },
  "clock.noJob": { en: "No job", es: "Sin trabajo" },
  "clock.summaryOn": { en: "On: ", es: "En: " },
  "clock.summaryTo": { en: "To: ", es: "A: " },
  "clock.todaysJob": { en: "Today's job", es: "Trabajo de hoy" },
  "clock.title.endBreakToSwitch": {
    en: "End break to switch project",
    es: "Termina el descanso para cambiar de trabajo",
  },
  "clock.title.tapToSwitch": {
    en: "Tap to switch project",
    es: "Toca para cambiar de trabajo",
  },
  "clock.notePlaceholder": {
    en: "Anything the cost code doesn't cover, or an explanation for the office…",
    es: "Algo que el código de costo no cubra, o una explicación para la oficina…",
  },
  "clock.error.badFinishTime": {
    en: "That finish time won't work.",
    es: "Esa hora de salida no funciona.",
  },
  "clock.toast.clockedIn": { en: "Clocked in", es: "Entrada marcada" },
  "clock.toast.clockedInQueued": {
    en: "Clocked in — we'll sync it when you're back online",
    es: "Entrada marcada — la sincronizamos cuando vuelvas a estar en línea",
  },
  // Shown when the clock-in also starts a specific unit ({code} is its work-order
  // mark, e.g. "1-2"). Was hard-coded English on the crew flow (slice 7 fix).
  "clock.toast.clockedInOnUnit": {
    en: "Clocked in — clock running on {code}",
    es: "Entrada marcada — el reloj corre en {code}",
  },
  "clock.toast.switched": { en: "Switched project", es: "Trabajo cambiado" },
  "clock.toast.switchedQueued": {
    en: "Switch saved — we'll sync it when you're back online",
    es: "Cambio guardado — lo sincronizamos cuando vuelvas a estar en línea",
  },
  "clock.toast.costSwitched": {
    en: "Switched cost code",
    es: "Código de costo cambiado",
  },
  "clock.toast.costSwitchedQueued": {
    en: "Cost code saved — will sync when online",
    es: "Código de costo guardado — se sincroniza cuando estés en línea",
  },
  "clock.toast.backOnClock": {
    en: "Back on the clock",
    es: "De vuelta en horario",
  },
  "clock.toast.backOnClockQueued": {
    en: "Back on the clock — will sync when online",
    es: "De vuelta en horario — se sincroniza cuando estés en línea",
  },
  // A held unit auto-resumed after a break; {code} is its work-order mark. Was
  // hard-coded English on the crew flow (slice 7 fix).
  "clock.toast.backOnUnit": {
    en: "Back on unit {code} — clock's running.",
    es: "De vuelta en la unidad {code} — el reloj está corriendo.",
  },
  "clock.toast.clockedOut": { en: "Clocked out", es: "Salida marcada" },
  "clock.toast.clockedOutQueued": {
    en: "Clocked out — we'll sync it when you're back online",
    es: "Salida marcada — la sincronizamos cuando vuelvas a estar en línea",
  },
  "clock.toast.finishSaved": {
    en: "Thanks — your hours are with the office to check",
    es: "Gracias — tus horas están con la oficina para revisar",
  },
  // SAFETY / injury — needs bilingual review.
  "clock.injury.was": {
    en: "I was injured this shift",
    es: "Me lesioné en este turno",
  },
  "clock.injury.whatHappened": { en: "What happened?", es: "¿Qué pasó?" },
  "clock.injury.emergency": {
    en: "(If this is an emergency immediately call 911)",
    es: "(Si es una emergencia, llama al 911 de inmediato)",
  },
  "clock.injury.placeholder": {
    en: "A sentence or two — what happened, and what part of you it got.",
    es: "Una o dos frases — qué pasó y qué parte del cuerpo te afectó.",
  },
  // SAFETY / toolbox — needs bilingual review.
  "clock.toolbox.signed": {
    en: "✓ Today's toolbox talk is signed.",
    es: "✓ La charla de seguridad de hoy está firmada.",
  },
  // SAFETY / toolbox — the clock-in gate, in plain words.
  "clock.toolbox.signToClockIn": {
    en: "Sign today's toolbox talk above to clock in.",
    es: "Firma la charla de seguridad de hoy arriba para marcar entrada.",
  },

  // ---- Toolbox sign card (all SAFETY — needs bilingual review) ----------
  "toolbox.today": {
    en: "Today's toolbox talk",
    es: "Charla de seguridad de hoy",
  },
  "toolbox.read": { en: "Read the talk", es: "Leer la charla" },
  "toolbox.pledge": {
    en: "I read and understood today's talk",
    es: "Leí y entendí la charla de hoy",
  },
  "toolbox.typeName": { en: "Type your name", es: "Escribe tu nombre" },
  "toolbox.fullName": { en: "Full name", es: "Nombre completo" },
  "toolbox.sign": { en: "Sign", es: "Firmar" },
  "toolbox.signTalk": { en: "Sign today's talk", es: "Firmar la charla de hoy" },
  "toolbox.signing": { en: "Signing…", es: "Firmando…" },

  // ---- Clock-in block (the one big clock-in spot on every landing) ------
  "clockblock.title": { en: "Clock in", es: "Marcar entrada" },
  "clockblock.subtitle": {
    en: "Pick your job and cost code — your time flows to payroll and job costing.",
    es: "Elige tu trabajo y código de costo — tu tiempo va a la nómina y al costo del trabajo.",
  },
  "clockblock.onClock": { en: "On the clock", es: "En horario" },
  "clockblock.switch": { en: "Switch", es: "Cambiar" },
  "clockblock.needsFinish": {
    en: "Shift needs a finish time",
    es: "El turno necesita una hora de salida",
  },
  "clockblock.needsFinishSub": {
    en: "We stopped counting — tell us when you finished.",
    es: "Dejamos de contar — dinos cuándo terminaste.",
  },
  "clockblock.moreOptions": {
    en: "More options — different job, break, sign the talk",
    es: "Más opciones — otro trabajo, descanso, firmar la charla",
  },
  "clockblock.notePlaceholder": {
    en: "Add a note for the office (optional)",
    es: "Agrega una nota para la oficina (opcional)",
  },
  "clockblock.notNearJob": {
    en: "You're not near this job — clock in anyway?",
    es: "No estás cerca de este trabajo — ¿marcar entrada de todos modos?",
  },
  // SAFETY / toolbox — needs bilingual review.
  "clockblock.signFirst": {
    en: "Sign today's safety talk to clock in.",
    es: "Firma la charla de seguridad de hoy para marcar entrada.",
  },
  "clockblock.signAndClockIn": {
    en: "Sign safety talk & clock in",
    es: "Firmar charla de seguridad y marcar entrada",
  },

  // ---- Quick tracking job (foreman+, slice 5) ---------------------------
  "clockblock.quickJob.start": {
    en: "Start a quick tracking job",
    es: "Crear un trabajo de seguimiento rápido",
  },
  "clockblock.quickJob.help": {
    en: "For a callback with no job yet — clocks time only. Name it, or just give the address.",
    es: "Para una visita sin trabajo aún — solo registra el tiempo. Ponle nombre, o solo la dirección.",
  },
  "clockblock.quickJob.namePlaceholder": {
    en: "Job name (optional)",
    es: "Nombre del trabajo (opcional)",
  },
  "clockblock.quickJob.addressPlaceholder": {
    en: "Address (optional)",
    es: "Dirección (opcional)",
  },
  "clockblock.quickJob.matchTitle": {
    en: "Already open — join one instead of making a new one:",
    es: "Ya está abierto — únete a uno en vez de crear otro:",
  },
  "clockblock.quickJob.create": { en: "Create & pick", es: "Crear y elegir" },
  "clockblock.quickJob.creating": { en: "Creating…", es: "Creando…" },
  "clockblock.quickJob.created": {
    en: "Job created — pick a cost code and clock in.",
    es: "Trabajo creado — elige un código de costo y marca entrada.",
  },
  "clockblock.quickJob.needName": {
    en: "Give it a name or an address first.",
    es: "Primero ponle un nombre o una dirección.",
  },

  // ---- Installer "need a job" request (slice 5) -------------------------
  "clockblock.needJob.ask": { en: "Need a job for this?", es: "¿Necesitas un trabajo para esto?" },
  "clockblock.needJob.help": {
    en: "Ask a lead to set up a job so you can clock in.",
    es: "Pide a un encargado que cree un trabajo para que puedas marcar entrada.",
  },
  "clockblock.needJob.notePlaceholder": {
    en: "What are you here for? (optional)",
    es: "¿Para qué estás aquí? (opcional)",
  },
  "clockblock.needJob.send": { en: "Ask a lead for a job", es: "Pedir un trabajo a un encargado" },
  "clockblock.needJob.sending": { en: "Asking…", es: "Preguntando…" },
  "clockblock.needJob.sent": {
    en: "Asked — a lead will set you up.",
    es: "Enviado — un encargado te va a ayudar.",
  },
  "clockblock.needJob.noOne": {
    en: "No lead is reachable right now — call one instead.",
    es: "Ningún encargado está disponible ahora — mejor llama a uno.",
  },

  // ---- My Work landing --------------------------------------------------
  "mywork.greeting": { en: "Your day", es: "Tu día" },
  "mywork.title": { en: "My work", es: "Mi trabajo" },
  "mywork.hint": {
    en: "do the top unit next; capture as you go.",
    es: "haz la unidad de arriba; documenta mientras avanzas.",
  },
  "mywork.goodMorning": { en: "Good morning", es: "Buenos días" },
  "mywork.clockIn": { en: "Clock in", es: "Marcar entrada" },
  "mywork.clockingIn": { en: "Clocking in…", es: "Marcando entrada…" },
  "mywork.clockInFinish": {
    en: "Clock in & finish {code} →",
    es: "Marca entrada y termina {code} →",
  },
  "mywork.clockInFlash": {
    en: "Clock in — flash run at {job} →",
    es: "Marca entrada — flashing en {job} →",
  },
  "mywork.clockInStart": {
    en: "Clock in & start on {code} →",
    es: "Marca entrada y empieza en {code} →",
  },
  "mywork.yourJob": { en: "your job", es: "tu trabajo" },
  "mywork.justClockIn": {
    en: "Just clock in — pick the job or unit yourself",
    es: "Solo marcar entrada — elige el trabajo o la unidad tú mismo",
  },
  "mywork.today": { en: "Today", es: "Hoy" },
  "mywork.continueInstall": { en: "Continue install", es: "Continuar instalación" },
  "mywork.startedThisOne": {
    en: "You started this one — tap to finish and grade it.",
    es: "Empezaste esta — toca para terminar y calificarla.",
  },
  "mywork.nothingAssigned.title": {
    en: "Nothing assigned right now",
    es: "Nada asignado ahora mismo",
  },
  "mywork.nothingAssigned.msg": {
    en: "Check with your lead, or help stage the next units.",
    es: "Consulta con tu líder, o ayuda a preparar las siguientes unidades.",
  },
  "mywork.browseJobs": { en: "Browse jobs", es: "Ver trabajos" },
  "mywork.stat.assigned": { en: "assigned", es: "asignadas" },
  "mywork.stat.readyNow": { en: "ready now", es: "listas ahora" },
  "mywork.stat.doneToday": { en: "done today", es: "hechas hoy" },
  "mywork.tapToInstall": {
    en: "Tap to install — photos, voice memo, grade",
    es: "Toca para instalar — fotos, nota de voz, calificación",
  },
  "mywork.unsubmit": { en: "Un-submit", es: "Deshacer envío" },
  "mywork.installed": { en: "installed", es: "instalada" },
  "mywork.doneTodayCount": { en: "Done today ({count})", es: "Hechas hoy ({count})" },
  // Leftover My Work chrome the earlier pass missed (tracking-jobs slice 7,
  // 2026-09-03). The one/many split is how the crew flow does plurals — the
  // framework interpolates {vars} but has no plural rule, so the caller picks
  // the key by count (English unit/units, Spanish unidad/unidades).
  "mywork.loadError": {
    en: "Couldn't load your work",
    es: "No se pudo cargar tu trabajo",
  },
  "mywork.jobToday": { en: "Your job today", es: "Tu trabajo de hoy" },
  "mywork.travel": { en: "Travel:", es: "Viaje:" },
  "mywork.directionsTitle": {
    en: "Directions to today's job",
    es: "Cómo llegar al trabajo de hoy",
  },
  "mywork.typeUnknown": { en: "type?", es: "¿tipo?" },
  "mywork.newUnits.one": {
    en: "{count} new unit assigned to you — tap to dismiss",
    es: "{count} unidad nueva asignada a ti — toca para descartar",
  },
  "mywork.newUnits.many": {
    en: "{count} new units assigned to you — tap to dismiss",
    es: "{count} unidades nuevas asignadas a ti — toca para descartar",
  },
  "mywork.oneWaiting.title": {
    en: "Your unit is waiting on something",
    es: "Tu unidad está esperando algo",
  },
  "mywork.manyWaiting.title": {
    en: "All {count} of your units are waiting on something",
    es: "Las {count} unidades tuyas están esperando algo",
  },
  "mywork.oneWaiting.msg": {
    en: "It can't start until the blocker clears — call your lead about it.",
    es: "No puede empezar hasta que se libere el bloqueo — llama a tu líder sobre esto.",
  },
  "mywork.manyWaiting.msg": {
    en: "None of these can start until the blockers clear — call your lead about the ones below.",
    es: "Ninguna puede empezar hasta que se liberen los bloqueos — llama a tu líder sobre las de abajo.",
  },
  "mywork.waitingOn": {
    en: "Waiting on: {what} — pick it back up once it's cleared",
    es: "Esperando: {what} — retómala cuando se libere",
  },
  "mywork.aBlocker": { en: "a blocker", es: "un bloqueo" },
  "mywork.finishChecks": {
    en: "Finish checks before installing",
    es: "Termina las revisiones antes de instalar",
  },
  "mywork.unsubmitting": { en: "Un-submitting…", es: "Deshaciendo envío…" },
  "mywork.unsubmitTitle": {
    en: "Un-submit {code}?",
    es: "¿Deshacer el envío de {code}?",
  },
  "mywork.unsubmitBody": {
    en: "The window goes back on your list and nothing is lost — photos, memo and time all stay on the record. Say why so the next person (maybe you) knows what still needs doing.",
    es: "La ventana vuelve a tu lista y no se pierde nada — las fotos, la nota y el tiempo quedan en el registro. Di por qué, para que la próxima persona (quizá tú) sepa qué falta.",
  },
  "mywork.unsubmitWhy": {
    en: "Why are you un-submitting?",
    es: "¿Por qué deshaces el envío?",
  },
  "mywork.cancel": { en: "Cancel", es: "Cancelar" },
  "mywork.notePlaceholder": {
    en: "Forgot the shims on the left side…",
    es: "Olvidé las cuñas del lado izquierdo…",
  },

  // ---- Summon strip -----------------------------------------------------
  "summon.a11y.live": { en: "Live summons", es: "Llamadas activas" },
  "summon.status.expired": { en: "Expired", es: "Vencida" },
  "summon.status.answered": { en: "You answered", es: "Respondiste" },
  "summon.status.open": { en: "SUMMON", es: "LLAMADA" },
  "summon.status.covered": { en: "Summon covered", es: "Llamada cubierta" },
  "summon.action.answer": { en: "Answer", es: "Responder" },
  "summon.action.decline": { en: "Decline", es: "Rechazar" },
  "summon.declined": {
    en: "Declined — it's off your screen. No points change.",
    es: "Rechazada — ya no está en tu pantalla. Tus puntos no cambian.",
  },

  // ---- Call for hands: the job-level summon surface (slice 4) -----------
  "callhands.button": { en: "Call for hands", es: "Pedir manos" },
  "callhands.subtitle": {
    en: "Ring the crew clocked into this job.",
    es: "Llama a la cuadrilla marcada en este trabajo.",
  },
  "callhands.howMany": { en: "How many helpers?", es: "¿Cuántos ayudantes?" },
  "callhands.whatFor": {
    en: "What do you need? (optional)",
    es: "¿Qué necesitas? (opcional)",
  },
  "callhands.whereAmI": {
    en: "Where are you on the job? (optional)",
    es: "¿Dónde estás en el trabajo? (opcional)",
  },
  "callhands.ring": {
    en: "Ring the crew — need {count}",
    es: "Llamar a la cuadrilla — necesito {count}",
  },
  "callhands.ringing": { en: "Ringing the crew…", es: "Llamando a la cuadrilla…" },
  "callhands.liveHeader": {
    en: "Call for hands — {count}/{needed}",
    es: "Pedir manos — {count}/{needed}",
  },
  "callhands.answeredWord": { en: "answered", es: "respondieron" },
  "callhands.coveredWord": { en: "covered", es: "cubierto" },
  "callhands.end": { en: "End call", es: "Terminar llamada" },
  "callhands.answer": {
    en: "Answer — help out (+10 pts)",
    es: "Responder — ayudar (+10 pts)",
  },
  "callhands.joining": { en: "Joining…", es: "Uniéndote…" },
  "callhands.cantHelp": { en: "Can't help", es: "No puedo ayudar" },
  "callhands.cantHelpNoted": {
    en: "Can't help — noted",
    es: "No puedo ayudar — anotado",
  },
  "callhands.sayingSo": { en: "Saying so…", es: "Avisando…" },
  "callhands.complete": {
    en: "Complete — back to my work",
    es: "Listo — volver a mi trabajo",
  },
  "callhands.stamping": { en: "Stamping…", es: "Registrando…" },
  "callhands.cantMakeIt": {
    en: "Can't make it — give my seat back",
    es: "No puedo ir — libera mi lugar",
  },
  "callhands.backingOut": { en: "Backing out…", es: "Retirándote…" },
  "callhands.cantCome": { en: "Can't come:", es: "No pueden venir:" },
  "callhands.onTheWay": { en: "on the way", es: "en camino" },
  "callhands.done": { en: "done", es: "listo" },
  "callhands.backedOut": { en: "backed out", es: "se retiró" },
  "callhands.helperMin": {
    en: "{count} helper-min total",
    es: "{count} min de ayuda en total",
  },
  "callhands.lockedViewAs": {
    en: "You're viewing as someone else — these buttons act as your real account, so they're off.",
    es: "Estás viendo como otra persona — estos botones actúan como tu cuenta real, así que están desactivados.",
  },

  // ---- Call for hands: reach-further picker (job-level-summons slice 4) --
  "callhands.reach.title": {
    en: "Reach more people",
    es: "Llamar a más personas",
  },
  "callhands.reach.hint": {
    en: "The crew clocked into this job already gets the call. Add anyone else here.",
    es: "La cuadrilla marcada en este trabajo ya recibe la llamada. Agrega aquí a cualquier otra persona.",
  },
  "callhands.reach.onClockNow": {
    en: "On the clock now",
    es: "En turno ahora",
  },
  "callhands.reach.onJob": { en: "on {job}", es: "en {job}" },
  "callhands.reach.offClock": { en: "off the clock", es: "fuera de turno" },
  "callhands.reach.search": {
    en: "Search anyone by name",
    es: "Buscar a cualquiera por nombre",
  },
  "callhands.reach.add": { en: "Add", es: "Agregar" },
  "callhands.reach.remove": { en: "Remove", es: "Quitar" },
  "callhands.reach.nobodyElse": {
    en: "Nobody else is on the clock right now — search a name to add anyone.",
    es: "Nadie más está en turno ahora — busca un nombre para agregar a cualquiera.",
  },
  "callhands.reach.chosen": {
    en: "Also ringing ({count})",
    es: "También llamando ({count})",
  },
  "callhands.reach.someone": { en: "Someone", es: "Alguien" },

  // ---- Opening / install sheet: top-level actions -----------------------
  "opening.action.clockIn": { en: "Clock in", es: "Marcar entrada" },
  // SAFETY / toolbox — needs bilingual review.
  "opening.action.signToolbox": {
    en: "Sign toolbox talk",
    es: "Firmar la charla de seguridad",
  },
  "opening.action.startTimer": { en: "Start the timer", es: "Iniciar el cronómetro" },
  "opening.action.startInstall": { en: "Start install →", es: "Empezar instalación →" },
  "opening.action.starting": { en: "Starting…", es: "Iniciando…" },
  "opening.action.doneCapture": { en: "Done — capture it →", es: "Listo — documéntalo →" },
  "opening.action.submitInstall": { en: "Submit install", es: "Enviar instalación" },
  "opening.action.saving": { en: "Saving…", es: "Guardando…" },
  "opening.action.backToInstall": {
    en: "Back to the install →",
    es: "Volver a la instalación →",
  },
  "opening.action.resolveBlockers": {
    en: "Resolve blockers to start",
    es: "Resuelve los bloqueos para empezar",
  },
  "opening.action.beforePhotoToStart": {
    en: "Take the before photo to start",
    es: "Toma la foto de antes para empezar",
  },
  "opening.action.clockInFirst": {
    en: "Clock in first to start",
    es: "Marca entrada primero para empezar",
  },
  "opening.action.lunch": { en: "Lunch", es: "Almuerzo" },
  "opening.action.break": { en: "Break", es: "Descanso" },

  // ---- Photo capture sheet ----------------------------------------------
  "photo.title.addReceipt": { en: "Add a receipt", es: "Agregar un recibo" },
  "photo.title.addPhotos": { en: "Add job photos", es: "Agregar fotos del trabajo" },
  "photo.stamped": {
    en: "Each shot is stamped with the time and GPS location.",
    es: "Cada foto se marca con la hora y la ubicación GPS.",
  },
  "photo.label.caption": { en: "Caption (optional)", es: "Descripción (opcional)" },
  "photo.action.useCamera": { en: "Use camera", es: "Usar cámara" },
  "photo.action.uploadFiles": { en: "Upload files", es: "Subir archivos" },
  "photo.action.capture": { en: "Capture", es: "Capturar" },
  "photo.action.saving": { en: "Saving…", es: "Guardando…" },
  "photo.action.done": { en: "Done", es: "Listo" },
  "photo.action.cancel": { en: "Cancel", es: "Cancelar" },
  "photo.action.retake": { en: "Retake", es: "Volver a tomar" },
  "photo.action.file": { en: "File", es: "Archivo" },
  "photo.stampingGps": { en: "Stamping GPS & time…", es: "Marcando GPS y hora…" },
  "photo.cameraUnavailable": {
    en: "Camera unavailable — use Upload files instead.",
    es: "Cámara no disponible — usa Subir archivos.",
  },
  "photo.before": { en: "Take the before photo", es: "Toma la foto de antes" },
  "photo.after": { en: "Take the after photo", es: "Toma la foto de después" },
  "photo.captureBefore": { en: "Capture before", es: "Capturar antes" },
  "photo.captureAfter": { en: "Capture after", es: "Capturar después" },
  "photo.afterHint": {
    en: "Lines up over the ghosted before shot",
    es: "Se alinea sobre la foto de antes en transparencia",
  },
  "photo.lineUpGhost": {
    en: 'Line up with the ghosted "before" shot.',
    es: "Alinéate con la foto de antes en transparencia.",
  },
  "photo.cameraUnavailableFile": {
    en: "Camera unavailable — use the file option instead.",
    es: "Cámara no disponible — usa la opción de archivo.",
  },
  "photo.useFileInstead": {
    en: "use the file option instead.",
    es: "usa la opción de archivo.",
  },
  "photo.tapToOpenCamera": {
    en: "Tap to open the camera",
    es: "Toca para abrir la cámara",
  },
  "photo.gpsTimeAuto": {
    en: "GPS + time stamped automatically",
    es: "GPS y hora marcados automáticamente",
  },
  "photo.chooseFromFiles": {
    en: "or choose from files",
    es: "o elige de tus archivos",
  },
  // Photo capture sheet chrome the earlier pass left in English
  // (tracking-jobs slice 7, 2026-09-03).
  "photo.a11y.close": { en: "Close", es: "Cerrar" },
  "photo.for": { en: "For", es: "Para" },
  "photo.beforeGhostAlt": {
    en: "before ghost",
    es: "foto de antes en transparencia",
  },

  // ---- Job modes (data vs tracking, standard-tracking-jobs slice 2) ------
  // Badges on job cards / the clock-in list / the job header.
  "jobmode.badge.data": { en: "Data", es: "Datos" },
  "jobmode.badge.tracking": { en: "Tracking", es: "Seguimiento" },
  "jobmode.badge.both": { en: "Data + Tracking", es: "Datos + Seguimiento" },
  // Create-job mode picker (foreman+).
  "jobmode.create.label": {
    en: "What does this job track?",
    es: "¿Qué registra este trabajo?",
  },
  "jobmode.create.hint": {
    en: "Data jobs track every window. Tracking jobs just clock time and log the day.",
    es: "Los trabajos de datos registran cada ventana. Los de seguimiento solo marcan tiempo y registran el día.",
  },
  "jobmode.opt.data": { en: "Data", es: "Datos" },
  "jobmode.opt.tracking": { en: "Tracking", es: "Seguimiento" },
  "jobmode.opt.both": { en: "Both", es: "Ambos" },
  // Clock-in mode step (shown only when the job allows both).
  "clockblock.mode.label": {
    en: "What are you here to do?",
    es: "¿A qué vienes?",
  },
  "clockblock.mode.data": { en: "Install work", es: "Trabajo de instalación" },
  "clockblock.mode.tracking": { en: "Tracking only", es: "Solo seguimiento" },
  // Tracking-only project tabs.
  "projtab.specs": { en: "Plans & specs", es: "Planos y especificaciones" },
  "projtab.time": { en: "Time", es: "Tiempo" },
  "specs.empty": { en: "No plans uploaded yet.", es: "Aún no se han subido planos." },
  "specs.emptyUploadHint": {
    en: "Upload a PDF planset so the crew can open it here.",
    es: "Sube un planset en PDF para que la cuadrilla pueda abrirlo aquí.",
  },
  "specs.open": { en: "Open", es: "Abrir" },
  "specs.upload": { en: "Upload plans", es: "Subir planos" },
  "specs.uploading": { en: "Uploading…", es: "Subiendo…" },
  "specs.error": {
    en: "Couldn't open that plan — try again.",
    es: "No se pudo abrir ese plano — inténtalo de nuevo.",
  },
  "jobtime.hint": {
    en: "Clock your time against this job.",
    es: "Registra tu tiempo en este trabajo.",
  },

  // ---- Build a tracking job out into a data job (foreman+, slice 6) ------
  // The one-way upgrade, offered on a tracking job's Overview.
  // The label a job wears when it has neither a job_code nor a name yet — its
  // own key so the fallback never leaks English into the Spanish confirm/done
  // sentences it's interpolated into (tracking-jobs slice 7, 2026-09-03).
  "buildout.thisJob": { en: "this job", es: "este trabajo" },
  "buildout.button": {
    en: "Build this out — turn this into a full data job",
    es: "Desarróllalo — conviértelo en un trabajo de datos completo",
  },
  "buildout.hint": {
    en: "Adds the plan map, the 3D model, the Studio, and window-by-window install tracking. Everything you've already logged stays. This can't be undone.",
    es: "Agrega el mapa del plano, el modelo 3D, el Studio y el seguimiento de instalación ventana por ventana. Todo lo que ya registraste se conserva. Esto no se puede deshacer.",
  },
  "buildout.confirm": {
    en: "Turn {job} into a full data job?\n\nThis switches on the plan map, the 3D model, the Studio, and window-by-window install tracking. All the time, photos, and daily logs already on this job stay put. You can't switch it back.",
    es: "¿Convertir {job} en un trabajo de datos completo?\n\nEsto activa el mapa del plano, el modelo 3D, el Studio y el seguimiento de instalación ventana por ventana. Todo el tiempo, las fotos y los registros diarios que ya tiene este trabajo se conservan. No se puede deshacer.",
  },
  "buildout.done": {
    en: "{job} is now a full data job. Upload its plans to get started.",
    es: "{job} ahora es un trabajo de datos completo. Sube sus planos para empezar.",
  },

  // ---- Per-job cost codes (foreman+ editor, slice 3) --------------------
  "jobcost.title": {
    en: "Cost codes for this job",
    es: "Códigos de costo para este trabajo",
  },
  "jobcost.help": {
    en: "Crew pick from these when they clock into this job. Leave every code off to show the full company list.",
    es: "La cuadrilla elige entre estos al marcar entrada en este trabajo. Deja todos apagados para mostrar la lista completa de la empresa.",
  },
  "jobcost.loading": { en: "Loading…", es: "Cargando…" },
  "jobcost.empty": {
    en: "No cost codes in the library yet.",
    es: "Aún no hay códigos de costo en la biblioteca.",
  },
  "jobcost.allShown": {
    en: "Showing the full company list — no per-job subset.",
    es: "Mostrando la lista completa de la empresa — sin subconjunto por trabajo.",
  },
  "jobcost.subsetCount": {
    en: "{n} of {total} codes chosen for this job.",
    es: "{n} de {total} códigos elegidos para este trabajo.",
  },
  "jobcost.save": { en: "Save cost codes", es: "Guardar códigos de costo" },
  "jobcost.saving": { en: "Saving…", es: "Guardando…" },
  "jobcost.saved": { en: "Cost codes saved.", es: "Códigos de costo guardados." },

  // ---- Per-job / per-cost-code time report (foreman+, slice 3) ----------
  "timereport.title": {
    en: "Time by job & cost code",
    es: "Tiempo por trabajo y código de costo",
  },
  "timereport.help": {
    en: "This pay period's hours, split by job and the cost code charged — the basis for billing service work.",
    es: "Las horas de este período de pago, divididas por trabajo y código de costo — la base para facturar el trabajo de servicio.",
  },
  "timereport.empty": {
    en: "No hours in this pay period yet.",
    es: "Aún no hay horas en este período de pago.",
  },
  "timereport.total": { en: "Total", es: "Total" },
  "timereport.noJob": { en: "No job", es: "Sin trabajo" },
  "timereport.noCode": { en: "No cost code", es: "Sin código de costo" },

  // ---- The job Photos tab (the photo/receipt feed, tracking-jobs slice 7) ----
  // PhotoFeed was English-only by convention until this slice; these wrap the
  // whole feed so a Spanish reader never meets an English label on their photos.
  // The foreman+ 30-day recoverable trash (slice-3 curation):
  "feed.trash": { en: "Trash", es: "Papelera" },
  "feed.backToPhotos": { en: "Back to photos", es: "Volver a las fotos" },
  "feed.trashHint": {
    en: "Removed photos stay here for 30 days, then they're erased for good.",
    es: "Las fotos quitadas se quedan aquí 30 días, luego se borran para siempre.",
  },
  "feed.removeConfirm": {
    en: "Remove this photo? It goes to the trash — recoverable for 30 days.",
    es: "¿Quitar esta foto? Va a la papelera — se puede recuperar por 30 días.",
  },
  "feed.photoTrashed": {
    en: "Photo moved to trash — 30 days to undo.",
    es: "Foto movida a la papelera — 30 días para deshacer.",
  },
  "feed.restore": { en: "Restore", es: "Restaurar" },
  "feed.photoRestored": { en: "Photo restored.", es: "Foto restaurada." },
  "feed.trashLoadError": {
    en: "Couldn't load the trash",
    es: "No se pudo cargar la papelera",
  },
  "feed.trashEmptyTitle": { en: "Trash is empty", es: "La papelera está vacía" },
  "feed.trashEmptyMsg": {
    en: "Removed photos show up here, recoverable for 30 days.",
    es: "Las fotos quitadas aparecen aquí, recuperables por 30 días.",
  },
  "feed.removedPhotoAlt": { en: "Removed photo", es: "Foto quitada" },
  // The photo/receipt grid, toolbar, empty states and lightbox:
  "feed.addPhoto": { en: "Add photo", es: "Agregar foto" },
  "feed.addReceipt": { en: "Add receipt", es: "Agregar recibo" },
  "feed.addAPhoto": { en: "Add a photo", es: "Agregar una foto" },
  "feed.photoLoadError": {
    en: "Couldn't load photos",
    es: "No se pudieron cargar las fotos",
  },
  "feed.receiptLoadError": {
    en: "Couldn't load receipts",
    es: "No se pudieron cargar los recibos",
  },
  "feed.noPhotosTitle": { en: "No photos yet", es: "Aún no hay fotos" },
  "feed.noReceiptsTitle": { en: "No receipts yet", es: "Aún no hay recibos" },
  "feed.noPhotosJobMsg": {
    en: "Snap the first progress or install photo for this job.",
    es: "Toma la primera foto de avance o instalación de este trabajo.",
  },
  "feed.noPhotosAllMsg": {
    en: "Photos from every job show up here as the crew captures them.",
    es: "Las fotos de todos los trabajos aparecen aquí mientras la cuadrilla las toma.",
  },
  "feed.noReceiptsMsg": {
    en: "Snap a gas or materials receipt — the job is optional, everything else is skippable.",
    es: "Toma una foto de un recibo de gasolina o materiales — el trabajo es opcional, todo lo demás se puede omitir.",
  },
  "feed.jobPhotoAlt": { en: "Job photo", es: "Foto del trabajo" },
  "feed.receiptAlt": { en: "Receipt", es: "Recibo" },
  "feed.reviewed": { en: "Reviewed", es: "Revisado" },
  "feed.someone": { en: "Someone", es: "Alguien" },
  "feed.imageOffline": {
    en: "Image unavailable offline.",
    es: "Imagen no disponible sin conexión.",
  },
  "feed.remove": { en: "Remove", es: "Quitar" },
  "feed.close": { en: "Close", es: "Cerrar" },

  // ---- Delete-a-job dialog (supervisor+, tracking-jobs slice 7) ----------
  // The confirm text is assembled from a template + the count words so both
  // languages pluralize the same way (regular +s covers opening/abertura,
  // package/paquete, photo/foto). buildDeleteConfirmMessage does the counting;
  // these are the words and sentence it drops them into.
  "deljob.word.opening": { en: "opening", es: "abertura" },
  "deljob.word.package": { en: "package", es: "paquete" },
  "deljob.word.photo": { en: "photo", es: "foto" },
  "deljob.confirmTemplate": {
    en: "Delete {job}? This job has {openings}, {packages}, and {photos}.\n\nIt disappears everywhere, and you have 30 days to undo from Job history.",
    es: "¿Eliminar {job}? Este trabajo tiene {openings}, {packages} y {photos}.\n\nDesaparece de todas partes y tienes 30 días para deshacerlo desde el Historial de trabajos.",
  },
  "deljob.why": {
    en: "Why are you deleting it? (every supervisor is told)",
    es: "¿Por qué lo eliminas? (se avisa a cada supervisor)",
  },
  "deljob.deleted": {
    en: "Deleted — it disappears everywhere. Undo for 30 days from Job history.",
    es: "Eliminado — desaparece de todas partes. Deshacer por 30 días desde el Historial de trabajos.",
  },
  "deljob.checking": { en: "Checking…", es: "Comprobando…" },
  "deljob.delete": { en: "Delete…", es: "Eliminar…" },

  // ---- Data off + missed units (transcripts program, wave E) -------------
  // Two field-truth flows the crew lives in: saying the paperwork on a unit is
  // wrong ("data off"), and adding a window or door the plans never had. Both
  // are installer-facing on a phone, so both ship in Spanish from day one.
  "dataoff.title": { en: "Data off", es: "Datos incorrectos" },
  "dataoff.help": {
    en: "The window is fine but the paperwork isn't. Say so — it never stops you finishing.",
    es: "La ventana está bien pero el papeleo no. Dilo — nunca te impide terminar.",
  },
  "dataoff.pickReason": { en: "What's off?", es: "¿Qué está mal?" },
  "dataoff.reason.wrongSize": { en: "Wrong size", es: "Medida equivocada" },
  "dataoff.reason.mirrored": { en: "Mirrored", es: "Al revés (espejo)" },
  "dataoff.reason.notAsDrawn": { en: "Not as drawn", es: "No es como está dibujado" },
  "dataoff.reason.notOnPlans": { en: "Not on the plans", es: "No está en los planos" },
  "dataoff.reason.other": { en: "Something else", es: "Otra cosa" },
  "dataoff.notePlaceholder": {
    en: "What did you find? (optional)",
    es: "¿Qué encontraste? (opcional)",
  },
  "dataoff.save": { en: "Mark data off", es: "Marcar datos incorrectos" },
  "dataoff.saving": { en: "Saving…", es: "Guardando…" },
  "dataoff.saved": {
    en: "Marked data off. Finish the window as normal.",
    es: "Marcado datos incorrectos. Termina la ventana como siempre.",
  },
  "dataoff.flagged": { en: "Data off:", es: "Datos incorrectos:" },
  "dataoff.by": { en: "flagged by {who}", es: "marcado por {who}" },
  "dataoff.clear": { en: "Clear the flag", es: "Quitar la marca" },
  "dataoff.cleared": { en: "Flag cleared.", es: "Marca quitada." },
  "dataoff.askForeman": {
    en: "Your foreman clears this once the paperwork is fixed.",
    es: "Tu supervisor la quita cuando se arregla el papeleo.",
  },
  "missed.add": { en: "Add a missed unit", es: "Agregar una unidad faltante" },
  "missed.title": {
    en: "A window or door that isn't on the plans",
    es: "Una ventana o puerta que no está en los planos",
  },
  "missed.help": {
    en: "Add it now so it gets ordered and installed. Your supervisor is told straight away.",
    es: "Agrégala ahora para que se pida y se instale. Se avisa a tu supervisor de inmediato.",
  },
  "missed.kind": { en: "Is it a window or a door?", es: "¿Es una ventana o una puerta?" },
  "missed.window": { en: "Window", es: "Ventana" },
  "missed.door": { en: "Door", es: "Puerta" },
  "missed.width": { en: "Width (inches)", es: "Ancho (pulgadas)" },
  "missed.height": { en: "Height (inches)", es: "Alto (pulgadas)" },
  "missed.photo": { en: "Photo of the opening", es: "Foto de la abertura" },
  "missed.notePlaceholder": {
    en: "Where is it? Anything the office should know",
    es: "¿Dónde está? Algo que la oficina deba saber",
  },
  "missed.tapTheMap": {
    en: "Tap the plan where it is, then fill this in.",
    es: "Toca el plano donde está, luego llena esto.",
  },
  "missed.placed": { en: "Placed on the plan.", es: "Colocada en el plano." },
  "missed.unplaced": {
    en: "No plan for this job yet — it will be added without a spot on the drawing.",
    es: "Este trabajo aún no tiene plano — se agregará sin lugar en el dibujo.",
  },
  "missed.submit": { en: "Add it", es: "Agregarla" },
  "missed.submitting": { en: "Adding…", es: "Agregando…" },
  "missed.added": {
    en: "Added as {code}. Your supervisor has been told.",
    es: "Agregada como {code}. Ya se avisó a tu supervisor.",
  },
  "missed.needSize": {
    en: "Give a width and a height so it can be ordered.",
    es: "Pon un ancho y un alto para poder pedirla.",
  },
  "missed.cancel": { en: "Cancel", es: "Cancelar" },
  "missed.badge": { en: "Missed unit", es: "Unidad faltante" },
  "datahub.dataOff.title": { en: "Units data off", es: "Unidades con datos incorrectos" },
  "datahub.dataOff.explain": {
    en: "Windows and doors the crew says the paperwork is wrong about. Their install time is kept out of every average, because it timed a unit we did not really order — the rate beside it is how often that happens.",
    es: "Ventanas y puertas donde la cuadrilla dice que el papeleo está mal. Su tiempo de instalación se deja fuera de todos los promedios, porque midió una unidad que en realidad no pedimos — la tasa al lado dice con qué frecuencia pasa.",
  },
  "datahub.dataOff.none": {
    en: "Nothing flagged. When a crew member marks a unit data off, it lands here with the reason and their name.",
    es: "Nada marcado. Cuando alguien marca una unidad con datos incorrectos, aparece aquí con el motivo y su nombre.",
  },
  "datahub.dataOff.chip": { en: "Data off", es: "Datos incorrectos" },
  "datahub.dataOff.excluded": {
    en: "{n} kept out of the averages",
    es: "{n} fuera de los promedios",
  },
} satisfies Record<string, CatalogEntry>;

/** Every key the catalog knows. Later slices widen this by adding entries. */
export type TKey = keyof typeof CATALOG;
