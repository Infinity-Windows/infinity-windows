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
  // Wave O: the names of the safety cards themselves. A crew member reads these
  // to decide whether the card in their wallet is the one being asked for, and
  // "protección contra caídas" is the phrase a fall-protection class is sold
  // under in Spanish — worth a bilingual crew member's eyes before it is
  // trusted.
  "cred.kind.first_aid_cpr",
  "cred.kind.aerial_lift",
  "cred.kind.forklift",
  "cred.kind.fall_protection",
  // The roster's group sign-in (20260985000000). This checkbox is the entire
  // reason a bulk clock-in may pass the toolbox gate — a supervisor saying, on
  // the record, that the talk was given. Its wording has to be exact in both
  // languages before anybody leans on it.
  "crewclock.in.attest",
  "crewclock.in.attestHelp",
  // The other half of the same claim: what the person it was made ABOUT reads
  // on their own safety page, and what an auditor reads on the crew list.
  "toolbox.group.recordedTitle",
  "toolbox.group.by",
  "toolbox.group.bySupervisor",
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

  // ---- Wave K: time honesty (transcripts program, 2026-09-03) -----------
  // The far-from-job question (K1). It only ever appears when the app can
  // actually see the phone is away from the job, and both answers are real
  // ones — "I'm still here" holds the question for an hour and nothing about
  // the clock changes. The distance is two keys rather than one so both
  // languages get their own singular.
  "farjob.title": { en: "Still at the job?", es: "¿Sigues en el trabajo?" },
  "farjob.bodyMiles": {
    en: "You're {miles} miles from {job}. Switch to Travel?",
    es: "Estás a {miles} millas de {job}. ¿Cambiar a Viaje?",
  },
  "farjob.bodyOneMile": {
    en: "You're {miles} mile from {job}. Switch to Travel?",
    es: "Estás a {miles} milla de {job}. ¿Cambiar a Viaje?",
  },
  "farjob.switch": { en: "Switch to Travel", es: "Cambiar a Viaje" },
  "farjob.stillHere": { en: "I'm still here", es: "Sigo aquí" },
  "farjob.note": {
    en: "Your clock keeps running either way — nothing changes unless you tap.",
    es: "Tu reloj sigue corriendo de todos modos — nada cambia hasta que toques.",
  },
  "farjob.switched": { en: "Switched to Travel", es: "Cambiado a Viaje" },
  // The supervisor's reading of the same fact (K3). "mi" abbreviates the same
  // way in both languages, so one key covers one mile and fourteen.
  //
  // "from where they clocked in", NOT "from job": the only position a single
  // shift row carries is its own clock-in, and clocking in away from the site
  // (the shop, a supply stop, a bad address) is a normal morning. Saying "from
  // job" would report somebody standing on site as miles away from it.
  "lastseen.farFromJob": {
    en: "last seen {miles} mi from where they clocked in · {time}",
    es: "visto por última vez a {miles} mi de donde marcó entrada · {time}",
  },
  // The evening nudge hour, set by a foreman on Team timecards (K2).
  "nudge.label": {
    en: "Evening \u201cStill on the job?\u201d reminder at {time}",
    es: "Recordatorio de la tarde \u201c\u00bfSigues en el trabajo?\u201d a las {time}",
  },
  "nudge.aria": {
    en: "Time of day the evening reminder goes out",
    es: "Hora a la que sale el recordatorio de la tarde",
  },
  "nudge.on": { en: "Send it", es: "Enviarlo" },
  "nudge.save": { en: "Save", es: "Guardar" },
  "nudge.saving": { en: "Saving\u2026", es: "Guardando\u2026" },
  // The durable half of "somebody changed your punches" (K4). The push is
  // English by design; this line is the one that stays, so it speaks both.
  "notif.timecardChanged.title": {
    en: "Your timecard was changed",
    es: "Tu tarjeta de tiempo fue cambiada",
  },
  "notif.timecardChanged.subOne": {
    en: "One change in the last 30 days \u2014 check your hours",
    es: "Un cambio en los \u00faltimos 30 d\u00edas \u2014 revisa tus horas",
  },
  "notif.timecardChanged.subMany": {
    en: "{count} changes in the last 30 days \u2014 check your hours",
    es: "{count} cambios en los \u00faltimos 30 d\u00edas \u2014 revisa tus horas",
  },
  // The team timecard's range stepper and the Gusto file (K5). The rest of the
  // page is older English left alone by design, but every string this wave
  // WROTE goes through t() \u2014 including the labels a screen reader speaks, which
  // are the only words a blind foreman gets off the two chevron buttons.
  "tcx.range.week": { en: "Week", es: "Semana" },
  "tcx.range.pay": { en: "Pay period", es: "Periodo de pago" },
  "tcx.range.aria": {
    en: "Team timecard range",
    es: "Rango de la tarjeta de tiempo del equipo",
  },
  "tcx.range.prev": { en: "Previous", es: "Anterior" },
  "tcx.range.next": { en: "Next", es: "Siguiente" },
  "tcx.range.backToNow": { en: "Jump back to now", es: "Volver a ahora" },
  "tcx.export.gusto": {
    en: "Export pay period for Gusto",
    es: "Exportar periodo de pago para Gusto",
  },
  "tcx.export.gustoHint": {
    en: "Switch to Pay period to export for Gusto.",
    es: "Cambia a Periodo de pago para exportar para Gusto.",
  },

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
  // What a supervisor does with a missed unit. On the opening sheet, which
  // every role opens — the installer who added it reads the first two lines and
  // nothing else, so those are as much a phone string as any other.
  "missed.explain": {
    en: "Added from the site. It counts as a real window or door everywhere until somebody says otherwise.",
    es: "Agregada desde el sitio. Cuenta como una ventana o puerta real en todos lados hasta que alguien diga lo contrario.",
  },
  "missed.supervisorDecides": {
    en: "A supervisor decides whether it keeps this name, is really an existing mark, or comes back off.",
    es: "Un supervisor decide si conserva este nombre, si en realidad es una marca que ya existe, o si se quita.",
  },
  "missed.keepUnderName": { en: "Keep it — under this name", es: "Consérvala — con este nombre" },
  "missed.nameLabel": { en: "Name for this unit", es: "Nombre de esta unidad" },
  "missed.saveName": { en: "Save the name", es: "Guardar el nombre" },
  "missed.orExistingMark": {
    en: "Or it is really an existing mark",
    es: "O en realidad es una marca que ya existe",
  },
  "missed.mergeInto": { en: "Merge into…", es: "Combinar con…" },
  "missed.merge": { en: "Merge", es: "Combinar" },
  "missed.takeOff": { en: "Take it back off the job", es: "Quitarla del trabajo" },
  "missed.kept": { en: "Kept as {code}.", es: "Guardada como {code}." },
  "missed.merged": { en: "Merged into {code}.", es: "Combinada con {code}." },
  "missed.removed": {
    en: "Taken back off the job — it is in the removed list.",
    es: "Quitada del trabajo — está en la lista de quitadas.",
  },

  // ---- Wave Z: money doors (transcripts program, 2026-09-03) -------------
  // Almost all of wave Z is office and owner work — the Cost screen, the
  // receipts table, the Roster's grant checkboxes, the bank import — and stays
  // English like the rest of those files. These two are the exception: ANYONE
  // signed in snaps a receipt, so the one new question the capture sheet asks
  // is a crew string and goes through t() in both languages, even though its
  // neighbours on that sheet are older English.
  //
  // "Cost code" is worded exactly as the clock's own picker words it
  // (clock.label.costCode) — it is the same list, so it should not be two
  // different phrases to learn.
  "receipt.costCode.label": { en: "Cost code", es: "Código de costo" },
  "receipt.costCode.help": {
    en: "Optional — it helps the office put this on the right job.",
    es: "Opcional — ayuda a la oficina a ponerlo en el trabajo correcto.",
  },

  // ---- Wave J — the job pipeline ---------------------------------------
  // (transcripts program, grill 2026-09-03, Q8+Q9). The stretch between
  // winning a bid and the first window going in: is the job ready, when do
  // the windows land, and does somebody need to make a phone call. These
  // strings are read by everybody — an installer scanning the Jobs list wants
  // to know a job has no glass just as much as the office does — so they are
  // deliberately short, and dates are rendered by the caller in the device's
  // own locale rather than being spelled out here.
  //
  // The PUSH the 7 AM sweep sends is NOT here and must not be: a notification
  // is rendered by the operating system long before the app's language layer
  // gets a say, so push copy stays English by the program's own rule.
  "pipeline.heading": { en: "Pipeline", es: "Estado del trabajo" },
  "pipeline.ready": { en: "Ready", es: "Listo" },
  "pipeline.notReady": { en: "Not ready", es: "No listo" },
  "pipeline.markReady": { en: "Mark ready", es: "Marcar listo" },
  "pipeline.markNotReady": { en: "Mark not ready", es: "Marcar no listo" },
  "pipeline.expectedStart": { en: "Expected start", es: "Inicio previsto" },
  "pipeline.materialsEta": { en: "Windows ETA", es: "Ventanas llegan" },
  "pipeline.materialsArrived": { en: "Materials arrived", es: "Material llegó" },
  "pipeline.arrivedOn": { en: "Arrived {date}", es: "Llegó el {date}" },
  "pipeline.notArrivedYet": { en: "Not here yet", es: "Todavía no llega" },
  "pipeline.undoArrived": { en: "They are not here yet", es: "Todavía no llegan" },
  "pipeline.notSet": { en: "Not set", es: "Sin fecha" },
  "pipeline.change": { en: "Change", es: "Cambiar" },
  "pipeline.save": { en: "Save", es: "Guardar" },
  "pipeline.cancel": { en: "Cancel", es: "Cancelar" },
  "pipeline.clear": { en: "Clear", es: "Borrar" },
  "pipeline.saving": { en: "Saving…", es: "Guardando…" },
  // The wave H seam, said plainly. Once the GC check-in table exists this line
  // shows the real date instead; until then "none yet" is the honest answer,
  // and the app has never had anywhere to record one.
  "pipeline.lastCheckin": { en: "Last GC check-in", es: "Último contacto con el GC" },
  "pipeline.noCheckinYet": { en: "None yet", es: "Ninguno todavía" },
  // The chip and the reasons behind it. Each reason is a fragment that reads
  // on its own, because a job usually has one of them and never all four.
  "pipeline.needsCall": { en: "Needs a call", es: "Hay que llamar" },
  "pipeline.reason.notReady": { en: "not ready", es: "no está listo" },
  "pipeline.reason.materialsMissing": { en: "windows not in", es: "faltan las ventanas" },
  "pipeline.reason.materialsLate": { en: "windows late", es: "ventanas atrasadas" },
  "pipeline.reason.noCheckin": { en: "no GC check-in", es: "sin contacto con el GC" },
  // The job card's own line: "Not ready · start ~Sep 22 · windows ETA Sep 15".
  "pipeline.card.start": { en: "start ~{date}", es: "inicia ~{date}" },
  "pipeline.card.eta": { en: "windows ETA {date}", es: "ventanas {date}" },
  // The New project form's toggle. Ready is the default here and only here:
  // somebody is filling this in by hand, so they know. A job that ARRIVES —
  // imported from Monday, built in one tap from the clock-in — is born Not
  // ready instead, with nobody asked.
  "pipeline.create.label": { en: "Is this job ready to work?", es: "¿Este trabajo está listo?" },
  "pipeline.create.hint": {
    en: "Not ready puts it on the morning reminder until somebody says it is.",
    es: "No listo lo pone en el aviso de la mañana hasta que alguien diga que sí.",
  },
  // Reordering the jobs list. Buttons, not only a drag: a drag needs a mouse,
  // and this list is read on a phone in gloves.
  "pipeline.order.up": { en: "Move up", es: "Subir" },
  "pipeline.order.down": { en: "Move down", es: "Bajar" },
  "pipeline.order.drag": { en: "Drag to reorder", es: "Arrastra para reordenar" },
  "pipeline.order.saved": { en: "New order saved.", es: "Nuevo orden guardado." },
  // Building a job from an Incoming-from-Monday proposal (J3). Said BEFORE the
  // tap, because "Not ready" is a state somebody has to clear by hand and a
  // foreman should not meet it for the first time on the jobs list afterwards.
  // Two whole sentences rather than one sentence plus a glued-on clause: word
  // order is not the same in both languages, and a phrase assembled from parts
  // reads like a phrase assembled from parts.
  "pipeline.monday.landsNotReady": {
    en: "It lands as Not ready — mark it ready once somebody has checked the site.",
    es: "Entra como No listo — márcalo listo cuando alguien haya revisado el sitio.",
  },
  "pipeline.monday.landsNotReadyWithEta": {
    en: "It lands as Not ready, with the windows due {date} — mark it ready once somebody has checked the site.",
    es: "Entra como No listo, con las ventanas para el {date} — márcalo listo cuando alguien haya revisado el sitio.",
  },

  // ---- Scope at a glance (wave X) ---------------------------------------
  // The one line a job card and a job header both say: how big this job is and
  // how much of it is doors. Every count is a one/many pair because the caller
  // picks the key by number — the framework interpolates {n} but has no plural
  // rule (same shape as mywork.newUnits.one/.many). Spanish genders follow the
  // noun: aberturas, ventanas and puertas are all feminine.
  "scope.openings.one": { en: "{n} opening", es: "{n} abertura" },
  "scope.openings.many": { en: "{n} openings", es: "{n} aberturas" },
  "scope.windows.one": { en: "{n} window", es: "{n} ventana" },
  "scope.windows.many": { en: "{n} windows", es: "{n} ventanas" },
  "scope.doors.one": { en: "{n} door", es: "{n} puerta" },
  "scope.doors.many": { en: "{n} doors", es: "{n} puertas" },
  "scope.stories.one": { en: "{n} story", es: "{n} piso" },
  "scope.stories.many": { en: "{n} stories", es: "{n} pisos" },
  // A tracking job has no openings by design — nobody uploads plans for a
  // service call — so it says what it is instead of showing zeroes.
  "scope.trackingJob": { en: "Tracking job", es: "Trabajo de seguimiento" },
  // Which doors, in the job header only. The words are the trade's own; see
  // docs/window-vendor-conventions.md, "Door kinds".
  "scope.door.slider.one": { en: "{n} slider", es: "{n} corrediza" },
  "scope.door.slider.many": { en: "{n} sliders", es: "{n} corredizas" },
  "scope.door.french.one": { en: "{n} French", es: "{n} francesa" },
  "scope.door.french.many": { en: "{n} French", es: "{n} francesas" },
  "scope.door.bifold.one": { en: "{n} bifold", es: "{n} plegable" },
  "scope.door.bifold.many": { en: "{n} bifolds", es: "{n} plegables" },
  "scope.door.swing.one": { en: "{n} swing", es: "{n} abatible" },
  "scope.door.swing.many": { en: "{n} swing", es: "{n} abatibles" },
  // Not a mistake and not a gap: the paperwork for these never said which kind
  // of door it is. A foreman fixing the spec text moves them out of here.
  "scope.door.other.one": { en: "{n} not stated", es: "{n} sin especificar" },
  "scope.door.other.many": { en: "{n} not stated", es: "{n} sin especificar" },
  // Storeys on the job form and the Job details panel.
  "scope.stories.label": { en: "Storeys", es: "Pisos" },
  "scope.stories.hint": {
    en: "How many floors the building has. Leave blank if you don't know yet.",
    es: "Cuántos pisos tiene el edificio. Déjalo en blanco si aún no lo sabes.",
  },
  "scope.stories.fromModel": {
    en: "From the traced 3D model.",
    es: "Del modelo 3D trazado.",
  },

  // ---- Credentials (wave O) ---------------------------------------------
  // The cards a crew member holds and the day each one runs out. The KIND
  // names are the trade's and the regulator's own — OSHA 10 is called OSHA 10
  // in both languages, and translating it would leave somebody hunting for a
  // card they hold — so those two entries are deliberately identical, the same
  // way picker.english names itself in its own language. The rest are the
  // words a Spanish-reading installer would recognise on the class certificate
  // and are flagged in SAFETY_KEYS for the owner's bilingual review.
  "cred.kind.osha10": { en: "OSHA 10", es: "OSHA 10" },
  "cred.kind.osha30": { en: "OSHA 30", es: "OSHA 30" },
  "cred.kind.first_aid_cpr": {
    en: "First aid / CPR",
    es: "Primeros auxilios / RCP",
  },
  "cred.kind.aerial_lift": { en: "Aerial lift", es: "Plataforma elevadora" },
  "cred.kind.forklift": { en: "Forklift", es: "Montacargas" },
  "cred.kind.fall_protection": {
    en: "Fall protection",
    es: "Protección contra caídas",
  },
  "cred.kind.other": { en: "Other", es: "Otra" },

  // The section itself, on a Roster row and on My Work.
  "cred.heading": { en: "Credentials", es: "Certificaciones" },
  "cred.none": { en: "No cards on file yet.", es: "Todavía no hay tarjetas." },
  "cred.skillTree": { en: "Skill tree", es: "Árbol de habilidades" },
  "cred.badges": { en: "Badges", es: "Insignias" },
  "cred.clearances.one": { en: "{n} type cleared", es: "{n} tipo aprobado" },
  "cred.clearances.many": { en: "{n} types cleared", es: "{n} tipos aprobados" },

  // The expiry chips. Deliberately four different sentences rather than one
  // with a number swapped in: "no expiry" and "ran out" are not the same
  // sentence with a different number, and a phrase assembled from parts reads
  // like a phrase assembled from parts in Spanish.
  "cred.chip.noExpiry": { en: "No expiry", es: "Sin vencimiento" },
  "cred.chip.good": { en: "Good until {date}", es: "Válida hasta el {date}" },
  "cred.chip.soon": { en: "Runs out {date}", es: "Vence el {date}" },
  "cred.chip.expired": { en: "Expired {date}", es: "Venció el {date}" },
  "cred.unverified": { en: "Not checked yet", es: "Sin verificar" },
  "cred.verified": { en: "Checked", es: "Verificada" },

  // Adding a card.
  "cred.add": { en: "Add a card", es: "Agregar tarjeta" },
  "cred.addMine": { en: "Add my card", es: "Agregar mi tarjeta" },
  "cred.whichCard": { en: "Which card is it?", es: "¿Qué tarjeta es?" },
  "cred.nameIt": { en: "Name the card", es: "Nombre de la tarjeta" },
  "cred.issued": { en: "Issued", es: "Emitida" },
  "cred.expires": { en: "Runs out", es: "Vence" },
  "cred.expiresHint": {
    en: "Leave blank if the card has no expiry date on it.",
    es: "Déjalo en blanco si la tarjeta no tiene fecha de vencimiento.",
  },
  "cred.photo": { en: "Photo of the card", es: "Foto de la tarjeta" },
  "cred.photoHint": {
    en: "No stamp on this one — it is a photo of a card, not proof of where you stood.",
    es: "Esta foto no lleva sello — es una tarjeta, no una prueba de dónde estabas.",
  },
  "cred.save": { en: "Save card", es: "Guardar tarjeta" },
  "cred.saving": { en: "Saving…", es: "Guardando…" },
  "cred.cancel": { en: "Cancel", es: "Cancelar" },
  "cred.mineLandUnverified": {
    en: "A card you add yourself waits for a supervisor to check it.",
    es: "Una tarjeta que agregas tú espera a que un supervisor la revise.",
  },
  "cred.uploading": { en: "Sending the photo…", es: "Enviando la foto…" },
  "cred.viewCard": { en: "See the card", es: "Ver la tarjeta" },
  // The bucket answers "you may not read this" and "there is nothing here" the
  // same way, so this one sentence has to cover both without guessing.
  "cred.viewCard.noLuck": {
    en: "That photo would not open. Only the person it belongs to, or a supervisor, can see it.",
    es: "No se pudo abrir esa foto. Solo la persona dueña de la tarjeta, o un supervisor, puede verla.",
  },

  // Supervisor actions on somebody else's card.
  "cred.verify": { en: "Mark checked", es: "Marcar verificada" },
  "cred.unverify": { en: "Undo checked", es: "Quitar verificada" },
  "cred.void": { en: "Void", es: "Anular" },
  "cred.voidConfirm": {
    en: "Void this card? It stays on file and stops counting anywhere.",
    es: "¿Anular esta tarjeta? Queda en el archivo y deja de contar en todas partes.",
  },

  // O5 — the bid summary, supervisor+ on the Roster.
  "cred.summary.heading": { en: "Credential summary", es: "Resumen de certificaciones" },
  "cred.summary.hint": {
    en: "Checked cards that have not run out. No names — this line is written to be pasted into a bid.",
    es: "Tarjetas verificadas que no han vencido. Sin nombres — esta línea es para pegarla en una propuesta.",
  },
  "cred.summary.none": {
    en: "No checked cards on file yet.",
    es: "Todavía no hay tarjetas verificadas.",
  },
  "cred.summary.copy": { en: "Copy as text", es: "Copiar como texto" },
  "cred.summary.copied": { en: "Copied", es: "Copiado" },

  // O4 — the Heartbeat tile. Thirty days rather than "this month" so the tile
  // and the 7 AM push are counting the same cards; a calendar month would hide
  // a card expiring on the 2nd from anybody reading this on the 30th.
  "cred.expiring.one": {
    en: "1 credential runs out within 30 days",
    es: "1 certificación vence en 30 días o menos",
  },
  "cred.expiring.many": {
    en: "{n} credentials run out within 30 days",
    es: "{n} certificaciones vencen en 30 días o menos",
  },

  // A photo.* key filed in this wave's block because this wave is what created
  // it: the capture sheet's only unstamped caller. Its neighbour says "Stamping
  // GPS & time…", which would be a plain lie under a shot that carries neither
  // — the wait here is the shrink and re-encode, and nothing else.
  "photo.preparing": {
    en: "Getting the photo ready…",
    es: "Preparando la foto…",
  },
  // ---- Wave H — the GC handshake ----------------------------------------
  // (transcripts program, grill 2026-09-03, Q10 + Q11 + Q20). Six questions
  // get asked on every job, and the answers used to live in somebody's memory
  // of a phone call. These are the CREW side of that — the card on a job's
  // Overview where the office files what the builder said and hands him a link
  // to answer it himself.
  //
  // The GC'S OWN PAGE IS NOT HERE AND MUST NOT BE. It is customer-facing, it is
  // English-only in v1 by decision, and it is rendered before the app's
  // language layer exists at all — a general contractor opening a link from a
  // text message has never picked a language in this app and never will. The
  // email it goes out with is English for the same reason. When somebody asks
  // for Spanish there, it is a translation of the PAGE, not of this catalog.
  "gc.heading": { en: "GC", es: "Contratista general" },
  "gc.noCheckins": { en: "Nobody has checked in with the GC yet.", es: "Nadie ha hablado con el contratista general todavía." },
  "gc.log": { en: "Log a GC check-in", es: "Anotar contacto con el GC" },
  "gc.lastSpoke": { en: "Last spoke {date}", es: "Último contacto {date}" },
  "gc.answeredByGc": { en: "The GC answered this himself", es: "El GC contestó él mismo" },
  "gc.history": { en: "Earlier check-ins", es: "Contactos anteriores" },
  "gc.showHistory": { en: "Show earlier check-ins", es: "Ver contactos anteriores" },
  "gc.hideHistory": { en: "Hide earlier check-ins", es: "Ocultar contactos anteriores" },
  // The six questions. Short labels — this is a form filled in on a phone with
  // the builder still on the line.
  "gc.expectedEnd": { en: "House finished", es: "Casa terminada" },
  "gc.roofOn": { en: "Roof on", es: "Techo puesto" },
  "gc.framingChecked": { en: "Framing checked?", es: "¿Revisaron el marco?" },
  "gc.setPreference": { en: "Inset or outset?", es: "¿Adentro o afuera?" },
  "gc.set.inset": { en: "Inset", es: "Adentro" },
  "gc.set.outset": { en: "Outset", es: "Afuera" },
  "gc.set.unknown": { en: "He has not said", es: "No ha dicho" },
  "gc.exterior": { en: "Going on the outside", es: "Material de afuera" },
  "gc.interior": { en: "Going on the inside", es: "Material de adentro" },
  "gc.exteriorHint": { en: "Stucco, stone, siding…", es: "Estuco, piedra, siding…" },
  "gc.interiorHint": { en: "Drywall, plaster, wood…", es: "Panel de yeso, yeso, madera…" },
  "gc.yes": { en: "Yes", es: "Sí" },
  "gc.no": { en: "No", es: "No" },
  // Who and how — not required, but the first thing anybody wants when the
  // answers turn out to be wrong.
  "gc.contactName": { en: "Who you talked to", es: "Con quién hablaste" },
  "gc.channel": { en: "How", es: "Cómo" },
  "gc.channel.call": { en: "Call", es: "Llamada" },
  "gc.channel.text": { en: "Text", es: "Mensaje" },
  "gc.channel.email": { en: "Email", es: "Correo" },
  "gc.channel.site": { en: "On site", es: "En la obra" },
  // Not offered on the form — nobody in the office talked to the builder "on
  // the link". It is what a check-in the GC filed HIMSELF reads back as.
  "gc.channel.link": { en: "On his link", es: "En su enlace" },
  "gc.notes": { en: "Anything else", es: "Algo más" },
  "gc.save": { en: "File this check-in", es: "Guardar el contacto" },
  "gc.saving": { en: "Saving…", es: "Guardando…" },
  "gc.cancel": { en: "Cancel", es: "Cancelar" },
  "gc.saved": { en: "Filed. The job stops asking for a call.", es: "Guardado. El trabajo deja de pedir una llamada." },
  // The refusals, one per required answer, in the order the form asks them.
  // Each one names the box that is empty rather than saying "fill in the form".
  "gc.missing.expectedEnd": { en: "Say when the GC expects the house to be finished.", es: "Di cuándo espera el GC que la casa esté terminada." },
  "gc.missing.roofOn": { en: "Say when the roof goes on.", es: "Di cuándo ponen el techo." },
  "gc.missing.framingChecked": { en: "Say whether the framing has been checked.", es: "Di si ya revisaron el marco." },
  "gc.missing.setPreference": { en: "Say whether he wants the windows inset, outset, or that he has not said.", es: "Di si quiere las ventanas adentro, afuera, o que no ha dicho." },
  "gc.missing.exterior": { en: "Say what is going on the outside.", es: "Di qué va por fuera." },
  "gc.missing.interior": { en: "Say what is going on the inside.", es: "Di qué va por dentro." },
  "gc.missing.channel": { en: "Say how you talked to the GC.", es: "Di cómo hablaste con el GC." },
  // H2 — the link we hand the builder, and the thread on it. Crew-facing, so
  // both languages; the PAGE the link opens and the email that carries it are
  // English only in v1 and live in GcPage.tsx and the send-email function.
  "gc.link.heading": { en: "The GC's own link", es: "El enlace del GC" },
  "gc.link.none": { en: "No link has gone out yet.", es: "Todavía no se ha enviado ningún enlace." },
  "gc.link.live": { en: "The link works until {date}.", es: "El enlace funciona hasta el {date}." },
  "gc.link.sentTo": { en: "Sent to {email}", es: "Enviado a {email}" },
  // Said when the link exists and an address is on it but no email ever went —
  // which is every link while RESEND_API_KEY is unset. It has to name the next
  // move, because the card is all the foreman sees after he reloads the job.
  "gc.link.notSent": {
    en: "No email went. Copy the link and text it.",
    es: "No se envió ningún correo. Copia el enlace y mándalo por mensaje.",
  },
  "gc.link.answered": { en: "He answered on it {date}.", es: "Contestó ahí el {date}." },
  "gc.link.off": { en: "The link is off.", es: "El enlace está apagado." },
  "gc.link.email": { en: "GC's email", es: "Correo del GC" },
  "gc.link.send": { en: "Send to GC", es: "Enviar al GC" },
  "gc.link.resend": { en: "Send a fresh link", es: "Enviar un enlace nuevo" },
  "gc.link.revoke": { en: "Turn the link off", es: "Apagar el enlace" },
  "gc.link.sending": { en: "Sending…", es: "Enviando…" },
  "gc.link.needEmail": { en: "Type the GC's email address first.", es: "Escribe primero el correo del GC." },
  // Said BEFORE the tap, because a fresh link turns the old one off and a
  // builder who is holding the old one should not find that out by tapping it.
  "gc.link.confirm": {
    en: "Send the six questions to {email}? Any earlier link stops working.",
    es: "¿Enviar las seis preguntas a {email}? Cualquier enlace anterior deja de funcionar.",
  },
  "gc.link.copy": { en: "Copy the link", es: "Copiar el enlace" },
  "gc.link.copied": { en: "Copied.", es: "Copiado." },
  // The token exists in one place after this and it is the clipboard. Say so
  // plainly rather than letting somebody discover it by coming back tomorrow.
  "gc.link.onceOnly": {
    en: "Copy it now if you want to text it — we cannot show it again. Sending again makes a new one.",
    es: "Cópialo ahora si quieres mandarlo por mensaje — no podemos volver a mostrarlo. Enviar de nuevo crea uno nuevo.",
  },
  "gc.link.emailOff": {
    en: "Email is not set up yet, so nothing was sent. Copy the link and text it instead.",
    es: "El correo todavía no está configurado, así que no se envió nada. Copia el enlace y mándalo por mensaje.",
  },
  // Which of the company's two names this job's GC hears (Q20).
  "gc.brand.label": { en: "The GC sees us as", es: "El GC nos ve como" },
  "gc.brand.stg": { en: "STG Windows & Doors", es: "STG Windows & Doors" },
  "gc.brand.forge": { en: "Forge Windows and Doors", es: "Forge Windows and Doors" },
  // The thread. Never crew chat — said on the card, because the two boxes look
  // alike and sending the wrong one to the wrong audience is the mistake.
  "gc.thread.heading": { en: "Messages with the GC", es: "Mensajes con el GC" },
  "gc.thread.notCrewChat": {
    en: "This goes to the GC, not to the crew.",
    es: "Esto va al GC, no al equipo.",
  },
  "gc.thread.empty": { en: "Nothing yet.", es: "Nada todavía." },
  "gc.thread.placeholder": { en: "Write to the GC", es: "Escribe al GC" },
  "gc.thread.send": { en: "Send", es: "Enviar" },
  "gc.thread.us": { en: "Us", es: "Nosotros" },
  "gc.thread.them": { en: "The GC", es: "El GC" },

  // ---- Who installed this? (wave Y, transcripts program) ----------------
  // The finish step only asks when the unit belongs to somebody else, so
  // every one of these is read by a person who is filing for a workmate.
  // "Credit" is deliberately absent from the copy: on a job site that word
  // means money. The question the crew actually asks each other is who put
  // it in, so that is the question the app asks.
  "credit.who": { en: "Who installed this?", es: "¿Quién lo instaló?" },
  "credit.help": {
    en: "This unit is on someone else's list. Whoever you pick gets it on their record; the time still counts as yours.",
    es: "Esta unidad está en la lista de otra persona. A quien elijas le queda en su historial; el tiempo sigue contando como tuyo.",
  },
  "credit.me": { en: "Me", es: "Yo" },
  // The map's door into this (Y3). It goes to the same finish flow with the
  // same photo, grade and flashing gates — nothing is marked done from here.
  "credit.recordFor": { en: "Record install for…", es: "Registrar instalación de…" },
  "credit.pickPerson": { en: "Who installed it?", es: "¿Quién lo instaló?" },
  "credit.gateStillApplies": {
    en: "This opens the window's own sheet — the after photo and the grade are still needed.",
    es: "Esto abre la hoja de la ventana — todavía hacen falta la foto final y la calificación.",
  },
  "credit.cancel": { en: "Cancel", es: "Cancelar" },
  // The map's single-unit Assign door (Y4).
  "credit.assignOne": { en: "Assign…", es: "Asignar…" },
  // The map picked a person for a mark it cannot find an opening behind —
  // a plan drawn ahead of the schedule, usually.
  "credit.noOpeningYet": {
    en: "That unit has no opening yet.",
    es: "Esa unidad todavía no tiene abertura.",
  },
  // The line the Record reads back on a filed round. The two halves are one
  // sentence in both languages, so they are one key rather than a name glued
  // to a separator in code — Spanish does not put them in the same order.
  "credit.installedBy": {
    en: "Installed by {installer}",
    es: "Instalada por {installer}",
  },
  "credit.installedByFiledBy": {
    en: "Installed by {installer} · filed by {filer}",
    es: "Instalada por {installer} · registrada por {filer}",
  },
  // The credited person left the crew, or was never on it. Better than a
  // blank: somebody was named, we just cannot say who any more.
  "credit.someoneElse": { en: "someone else", es: "otra persona" },

  // ---- Who has had this unit (wave Y, Y5) --------------------------------
  // The hand-over log, read on the unit's Record and on the job's own list.
  // Three sentences because three different things happen — a unit going out,
  // a unit moving between two people, and a unit coming off a list — and each
  // has a with-a-name and a without-a-name form, because a hand-over made by
  // an account nobody can name still has to read as a sentence. Spanish puts
  // the person who moved it first, which is why these are whole sentences and
  // not an English stem with a " by …" stuck on the end.
  "assign.assigned": { en: "Assigned to {to}", es: "Asignada a {to}" },
  "assign.assignedBy": {
    en: "Assigned to {to} by {by}",
    es: "{by} se la asignó a {to}",
  },
  "assign.moved": { en: "Moved from {from} to {to}", es: "Pasó de {from} a {to}" },
  "assign.movedBy": {
    en: "Moved from {from} to {to} by {by}",
    es: "{by} la pasó de {from} a {to}",
  },
  "assign.takenOff": {
    en: "Taken off {from}'s list",
    es: "Quitada de la lista de {from}",
  },
  "assign.takenOffBy": {
    en: "Taken off {from}'s list by {by}",
    es: "{by} la quitó de la lista de {from}",
  },
  "assign.cleared": { en: "Assignment cleared", es: "Asignación borrada" },
  "assign.clearedBy": {
    en: "Assignment cleared by {by}",
    es: "{by} borró la asignación",
  },
  // Somebody the roster cannot name — the same fallback the session timeline
  // already uses rather than showing a raw id.
  "assign.crew": { en: "Crew", es: "Cuadrilla" },
  // The log itself. Folded shut by default: it is the thing you go and look at
  // when something is wrong, not a thing to read every morning.
  "assign.historyOpen": {
    en: "Assignment history — who has had what",
    es: "Historial de asignaciones — quién ha tenido qué",
  },
  "assign.history": {
    en: "Assignment history",
    es: "Historial de asignaciones",
  },
  "assign.historyLoading": { en: "Loading…", es: "Cargando…" },
  "assign.historyEmpty": {
    en: "Nothing handed out on this job yet.",
    es: "Todavía no se ha repartido nada en este trabajo.",
  },
  "assign.historyClose": { en: "Close history", es: "Cerrar historial" },
  // A hand-over whose unit is not in the list this screen loaded.
  "assign.unit": { en: "unit", es: "unidad" },

  // ---- Recordings by link (wave U) --------------------------------------
  // The owner's design (Q15/Q19): the app never collects raw footage. An
  // installer mails the clip to their lead, the lead puts it on YouTube, and a
  // supervisor pastes the LINK into Learn. Everything below is either the
  // mailing half or the draft-until-published half of that.
  //
  // The mail subject and body are composed on the INSTALLER's phone, so they
  // are written in the installer's language even though a lead reads them —
  // the person typing is the person the copy has to be clear to, and a lead
  // opening "Grabación — Sand Hollow — 3 sep 2026" knows exactly what it is.
  "recording.send": { en: "Send a recording", es: "Enviar una grabación" },
  "recording.help": {
    en: "Email the video to your lead. They put it on YouTube and it shows up in Learn.",
    es: "Envía el video por correo a tu líder. Él lo sube a YouTube y aparece en Aprender.",
  },
  // Said when nobody could be addressed — a database without the address book
  // yet, or a company with no lead on the books. The button still opens the
  // mail app, empty, which is better than a button that does nothing.
  "recording.noLead": {
    en: "No lead's address on file — pick one in your mail app.",
    es: "No hay dirección de un líder — elige una en tu app de correo.",
  },
  "recording.subject": {
    en: "Recording — {job} — {date}",
    es: "Grabación — {job} — {date}",
  },
  "recording.subjectNoJob": { en: "Recording — {date}", es: "Grabación — {date}" },
  "recording.body": { en: "Attach your video.", es: "Adjunta tu video." },

  // The Videos tab's Inbox: a supervisor's own unfinished lessons, above the
  // library everybody else sees.
  "learn.videos.inbox": { en: "Inbox — not published yet", es: "Bandeja — sin publicar" },
  "learn.videos.inboxHelp": {
    en: "Only supervisors see these. Publish one once the lesson is ready for crews.",
    es: "Solo los supervisores ven esto. Publica una lección cuando esté lista para los equipos.",
  },
  "learn.videos.draft": { en: "Draft", es: "Borrador" },
  "learn.videos.draftNote": {
    en: "Draft — crews can't see this yet.",
    es: "Borrador — los equipos aún no pueden ver esto.",
  },
  "learn.videos.publish": { en: "Publish", es: "Publicar" },
  "learn.videos.publishing": { en: "Publishing…", es: "Publicando…" },
  "learn.videos.publishedToast": {
    en: "Published — crews can see it now.",
    es: "Publicado — los equipos ya pueden verlo.",
  },
  // Beside the transcript box. YouTube stopped answering caption requests made
  // by anything but a real browser, so a pasted transcript is the only way a
  // linked lesson gets its words.
  "learn.videos.transcriptHelp": {
    en: "YouTube won't hand us the words for a link. Paste the transcript here, or ask your coordinator to pull it for you.",
    es: "YouTube no nos entrega el texto de un enlace. Pega aquí la transcripción, o pídele a tu coordinador que la saque por ti.",
  },

  // ---- The map's assign sheet with nobody to list (2026-09-04) -----------
  // The roster is read when this sheet OPENS now, so the only way to see this
  // line is to open it in the second before the roster lands. The old line
  // said the device had never been online, which was almost never true and
  // gave a foreman nothing to do about it; this one says wait a beat.
  "map.crewLoading": {
    en: "Crew list still loading — try again in a second.",
    es: "La lista del equipo se está cargando. Inténtalo de nuevo en un segundo.",
  },

  // ---- Which mailbox the GC's email came from (2026-09-04) --------------
  // STG-branded jobs and Forge-branded jobs mail from two different addresses
  // now, and the builder sees the From line before he sees anything else. So
  // the note under the button says which one he got — that is the first thing
  // the office asks when a builder says nothing ever arrived, and the foreman
  // who pressed the button is the one who can answer it.
  "gc.link.sentToFrom": {
    en: "Sent to {email} from {from}.",
    es: "Enviado a {email} desde {from}.",
  },

  // ---- Clock the crew in and out from the roster (2026-09-04) ------------
  // The owner found fourteen people clocked into OFFICE a minute apart —
  // somebody had punched fourteen phones in by hand. Team timecards now has a
  // checkbox per row and a bar that does the whole list at once.
  //
  // Every string here is read by a supervisor rather than an installer, and
  // supervisors read this app in Spanish too, so the whole block is
  // translated. The one thing that stays English is the refusal SENTENCE
  // inside crewclock.outcome.refused: it comes back from the database, the
  // same way every other server message in this app does.
  // Both select buttons act on the rows the SEARCH BOX is showing, and carry
  // the number they would tick, so a supervisor filtered down to one name can
  // never tap "Select all" and quietly get the whole company (2026-09-04
  // review). Every counted string below is a .one/.many pair: the framework
  // interpolates {n} but has no plural rule, so the caller picks the key by
  // count — the same shape as scope.openings.one/.many.
  "crewclock.select.all": {
    en: "Select all ({n})",
    es: "Seleccionar a todos ({n})",
  },
  "crewclock.select.onClock": {
    en: "Select everyone on the clock ({n})",
    es: "Seleccionar a todos los que están marcados ({n})",
  },
  "crewclock.select.clear": { en: "Clear", es: "Quitar la selección" },
  "crewclock.select.person": { en: "Select {name}", es: "Seleccionar a {name}" },
  "crewclock.bar.count.one": { en: "{n} selected", es: "{n} seleccionado" },
  "crewclock.bar.count.many": { en: "{n} selected", es: "{n} seleccionados" },
  "crewclock.bar.clockIn": { en: "Clock in…", es: "Marcar entrada…" },
  "crewclock.bar.clockOut": { en: "Clock out…", es: "Marcar salida…" },

  "crewclock.in.title.one": {
    en: "Clock in {n} person",
    es: "Marcar la entrada de {n} persona",
  },
  "crewclock.in.title.many": {
    en: "Clock in {n} people",
    es: "Marcar la entrada de {n} personas",
  },
  "crewclock.in.job": { en: "Job", es: "Trabajo" },
  "crewclock.in.pickJob": { en: "Pick a job", es: "Elige un trabajo" },
  "crewclock.in.note": {
    en: "Note for the office (optional)",
    es: "Nota para la oficina (opcional)",
  },
  // SAFETY / toolbox — needs bilingual review. This checkbox is the whole
  // reason a bulk clock-in is allowed to pass the toolbox gate: it records a
  // named person's claim that the talk was actually given.
  "crewclock.in.attest": {
    en: "I gave today's toolbox talk to everyone selected",
    es: "Di la charla de seguridad de hoy a todas las personas seleccionadas",
  },
  "crewclock.in.attestHelp": {
    en: "Required. Anyone who hasn't signed today gets today's talk recorded in your name.",
    es: "Obligatorio. A quien no haya firmado hoy se le registra la charla de hoy a tu nombre.",
  },
  "crewclock.in.move": {
    en: "Move anyone already on another job here",
    es: "Traer aquí a quien ya esté en otro trabajo",
  },
  "crewclock.in.moveOff.one": {
    en: "Someone you picked is already on another job — they'll be left where they are.",
    es: "Alguien que elegiste ya está en otro trabajo — se quedará donde está.",
  },
  "crewclock.in.moveOff.many": {
    en: "{n} already on another job — they'll be left where they are.",
    es: "{n} ya están en otro trabajo — se quedarán donde están.",
  },
  "crewclock.in.go": { en: "Clock them in", es: "Marcar su entrada" },
  "crewclock.in.going": { en: "Clocking them in…", es: "Marcando la entrada…" },

  "crewclock.out.title.one": {
    en: "Clock out {n} person",
    es: "Marcar la salida de {n} persona",
  },
  "crewclock.out.title.many": {
    en: "Clock out {n} people",
    es: "Marcar la salida de {n} personas",
  },
  "crewclock.out.body.one": {
    en: "One of the people you picked is on the clock. Their punch ends now.",
    es: "Una de las personas que elegiste está marcada. Su turno termina ahora.",
  },
  "crewclock.out.body.many": {
    en: "{n} of the people you picked are on the clock. Their punches end now.",
    es: "{n} de las personas que elegiste están marcadas. Sus turnos terminan ahora.",
  },
  "crewclock.out.nobody": {
    en: "Nobody you picked is on the clock.",
    es: "Ninguna de las personas que elegiste está marcada.",
  },
  "crewclock.out.go": { en: "Clock them out", es: "Marcar su salida" },
  "crewclock.out.going": { en: "Clocking them out…", es: "Marcando la salida…" },

  "crewclock.cancel": { en: "Cancel", es: "Cancelar" },
  "crewclock.results.title": { en: "What happened", es: "Qué pasó" },
  "crewclock.results.close": { en: "Done", es: "Listo" },
  "crewclock.outcome.clocked_in": { en: "Clocked in", es: "Entrada marcada" },
  "crewclock.outcome.already_on_this_job": {
    en: "Already on this job",
    es: "Ya estaba en este trabajo",
  },
  "crewclock.outcome.moved_from_other_job": {
    en: "Moved over from another job",
    es: "Traído de otro trabajo",
  },
  "crewclock.outcome.clocked_out": { en: "Clocked out", es: "Salida marcada" },
  "crewclock.outcome.already_out": {
    en: "Was already off the clock",
    es: "Ya estaba fuera de turno",
  },
  // Somebody the sheet deliberately never sent. The server cannot report this
  // one — it never heard about them — so the screen says it instead, rather
  // than handing back eleven lines for fourteen ticked names.
  "crewclock.outcome.skipped": {
    en: "Left on their other job",
    es: "Se quedó en su otro trabajo",
  },
  "crewclock.outcome.refused": { en: "Not done — {reason}", es: "No se hizo — {reason}" },
  "crewclock.outcome.unknown": { en: "Nothing changed", es: "No cambió nada" },
  // The database has not been updated yet. Said plainly, because the roster
  // itself still works and nothing is broken.
  "crewclock.notReady": {
    en: "Clocking the crew from this screen isn't switched on yet. It arrives with the next update.",
    es: "Marcar al equipo desde esta pantalla todavía no está activo. Llega con la próxima actualización.",
  },

  // On the person's OWN clock, so they can see at a glance that this punch
  // was not one they started.
  "clock.clockedInBy": {
    en: "Clocked in by {name}",
    es: "Entrada marcada por {name}",
  },

  // SAFETY / toolbox — needs bilingual review. A group sign-in on the Safety
  // page and in the personal history (2026-09-04 review). The database has
  // recorded the difference between a signature and a supervisor's attestation
  // since 20260985000000; until these strings existed, NO screen showed it —
  // a worker's own page said "Signed today ✓" above a blank name, and a
  // compliance list an auditor reads counted the two the same.
  "toolbox.group.recordedTitle": {
    en: "Today's talk was recorded for you",
    es: "La charla de hoy quedó registrada para ti",
  },
  "toolbox.group.by": {
    en: "Given by {name} — group talk, no signature",
    es: "La dio {name} — charla en grupo, sin firma",
  },
  "toolbox.group.bySupervisor": {
    en: "Given by a supervisor — group talk, no signature",
    es: "La dio un supervisor — charla en grupo, sin firma",
  },
  "toolbox.group.chip": { en: "Group talk", es: "Charla en grupo" },
  "toolbox.group.chipBy": {
    en: "Group talk — {name}",
    es: "Charla en grupo — {name}",
  },
  "toolbox.group.count.one": {
    en: "{n} more was recorded by a supervisor, not signed.",
    es: "{n} más lo registró un supervisor, sin firma.",
  },
  "toolbox.group.count.many": {
    en: "{n} more were recorded by a supervisor, not signed.",
    es: "{n} más los registró un supervisor, sin firma.",
  },
  "toolbox.group.historyLine": {
    en: "group talk — recorded {time}",
    es: "charla en grupo — registrada a las {time}",
  },

  // ---- Warehouse actions are crew actions (ADR-0007, 2026-09-04) ---------
  // The whole wave takes gates OFF, so there is almost no new copy. This is
  // the one sentence it adds: on the Rewrite-a-set screen every control is
  // now anyone's, and the single card that is still a rank — "Start this set
  // over", which really does delete arrived material — would otherwise just
  // vanish with nothing said. A blank space teaches nobody; this line says
  // who to ask.
  "rewriteSet.startOverIsLeadOnly": {
    en: "Only a foreman or above can start a set over.",
    es: "Solo un supervisor o superior puede empezar un juego desde cero.",
  },

  // ---- A login that was removed for good (2026-09-04) -------------------
  // One word, on two lead screens: the Roster row and the timecard header. It
  // has to be distinguishable from "off today" (availability) and from "access
  // switched off" (reversible) — this one means the login is gone and the
  // email has been handed back, and there is nothing to switch back on. "Dado
  // de baja" is what a crew actually says about somebody taken off the books;
  // "eliminado" would read as though the PERSON's record had been deleted,
  // which is the exact thing this feature refuses to do.
  "crew.removedLogin": { en: "Removed", es: "Dado de baja" },

  // ---- Monday files (2026-09-04) ----------------------------------------
  // The office's job paperwork lived on the Monday item and nowhere the crew
  // could reach it. Two audiences here, and both go through t():
  //
  //   * The Build form is OFFICE-FACING (foreman+), and it is still written
  //     once, in both languages, because "office-facing" is not a promise
  //     about who is standing at the desk.
  //   * The Plans page block and the Documents card are read on a phone on a
  //     job site, which is the crew flow this catalog was seeded for.
  //
  // "Plans", "Specs" and "Document" are the three slot names, and they are the
  // same three words in the picker, the result line and the card heading — one
  // word per slot, everywhere, so nobody has to work out that "the plan set"
  // and "building plan" are the same thing.
  "mondayFiles.kind.building": { en: "Plans", es: "Planos" },
  "mondayFiles.kind.specs": { en: "Specs", es: "Especificaciones" },
  "mondayFiles.kind.document": { en: "Document", es: "Documento" },

  // The Build form's file list.
  "mondayFiles.build.heading": {
    en: "Files on this Monday job",
    es: "Archivos de este trabajo en Monday",
  },
  "mondayFiles.build.blurb": {
    en: "These come across with the job. Untick anything you don't want.",
    es: "Estos vienen con el trabajo. Desmarca lo que no quieras.",
  },
  "mondayFiles.build.none": {
    en: "Monday has no files on this job yet.",
    es: "Monday todavía no tiene archivos en este trabajo.",
  },
  "mondayFiles.build.lockedToDocument": {
    en: "Kept as a document — only PDF, DWG and DXF can be plans or specs.",
    es: "Se guarda como documento — solo PDF, DWG y DXF pueden ser planos o especificaciones.",
  },
  "mondayFiles.build.pulling": {
    en: "Getting the files…",
    es: "Trayendo los archivos…",
  },

  // How the pull went. One whole sentence per case rather than a stem with a
  // clause spliced in, so both languages can be written properly.
  "mondayFiles.result.allPulled": {
    en: "Job built. All {total} files came across.",
    es: "Trabajo creado. Los {total} archivos llegaron.",
  },
  "mondayFiles.result.onePulled": {
    en: "Job built. The file came across.",
    es: "Trabajo creado. El archivo llegó.",
  },
  "mondayFiles.result.somePulled": {
    en: "Job built. {pulled} of {total} files pulled — the rest can be pulled from the job's Plans page.",
    es: "Trabajo creado. Se trajeron {pulled} de {total} archivos — el resto se puede traer desde la página de Planos del trabajo.",
  },
  "mondayFiles.result.nonePulled": {
    en: "Job built, but no files came across. They can be pulled from the job's Plans page.",
    es: "El trabajo se creó, pero no llegó ningún archivo. Se pueden traer desde la página de Planos del trabajo.",
  },
  "mondayFiles.result.noFiles": {
    en: "Job built.",
    es: "Trabajo creado.",
  },
  "mondayFiles.result.toPlans": { en: "Added to Plans", es: "Añadido a Planos" },
  "mondayFiles.result.toSpecs": { en: "Added to Specs", es: "Añadido a Especificaciones" },
  "mondayFiles.result.toDocuments": {
    en: "Added to Documents",
    es: "Añadido a Documentos",
  },
  "mondayFiles.result.already": {
    en: "Already on the job",
    es: "Ya estaba en el trabajo",
  },
  "mondayFiles.result.failed": { en: "Not added", es: "No se añadió" },

  // The Plans page block: files Monday has that the job does not.
  "mondayFiles.new.heading": { en: "Files on Monday", es: "Archivos en Monday" },
  "mondayFiles.new.blurb": {
    en: "On the Monday job and not yet here. Nothing comes across until you tap Get.",
    es: "Están en el trabajo de Monday y todavía no aquí. Nada llega hasta que toques Traer.",
  },
  "mondayFiles.new.pull": { en: "Get", es: "Traer" },
  "mondayFiles.new.pulling": { en: "Getting…", es: "Trayendo…" },
  "mondayFiles.new.upToDate": {
    en: "Everything on Monday is already here.",
    es: "Todo lo de Monday ya está aquí.",
  },
  "mondayFiles.fromMonday": { en: "from Monday", es: "de Monday" },

  // Re-reading a pulled file. A plan the server put here has never been read,
  // so without this the pull would leave a file on the page and nothing on the
  // map — which looks exactly like a broken extraction.
  "mondayFiles.extract": { en: "Read this file", es: "Leer este archivo" },
  "mondayFiles.extracting": { en: "Reading…", es: "Leyendo…" },

  // The Documents card on the job.
  "jobDocuments.heading": { en: "Documents", es: "Documentos" },
  "jobDocuments.empty": {
    en: "No documents on this job yet.",
    es: "Todavía no hay documentos en este trabajo.",
  },
  "jobDocuments.open": { en: "Open", es: "Abrir" },
  "jobDocuments.opening": { en: "Opening…", es: "Abriendo…" },
  // Shown beside a document with the company's own price on it — a quote, a
  // signed order. Only somebody who can see costs is ever handed one to read,
  // so this tag only ever appears to a person who can already open it; it is
  // there to say WHY the crew on the site cannot, before somebody asks.
  "jobDocuments.officeOnly": { en: "Office only", es: "Solo oficina" },

  // ---- The before photo the chain used to delete (2026-09-04) -----------
  // The unit sheet's before-photo card only rendered while the unit had no
  // start time. On the chain — the default loop — the next unit's session is
  // started server-side by the previous unit's finish, so the sheet opens with
  // the clock already running and the card never appeared. Every unit after
  // the first of the day filed with no before photo, under a Capture-stage
  // caption promising "the before you took in step 1".
  //
  // Two of these five replace English that was hardcoded on that screen
  // (`requiredToStart`, `afterOverBefore`); they are here because their new
  // neighbours are, and a sentence pair where one half translates and the
  // other does not is worse than either.
  "opening.before.requiredToStart": {
    en: "The opening as you found it — required before the clock starts.",
    es: "La abertura como la encontraste — obligatoria antes de que arranque el reloj.",
  },
  "opening.before.clockRunning": {
    en: "The opening as you found it. Your clock is already running, so take it now.",
    es: "La abertura como la encontraste. Tu reloj ya está corriendo, así que tómala ahora.",
  },
  "opening.before.taken": {
    en: "Before photo taken — it files with the install.",
    es: "Foto de antes tomada — se guarda con la instalación.",
  },
  "opening.capture.afterOverBefore": {
    en: "The after lines up over the before you took.",
    es: "La foto de después se alinea con la de antes que tomaste.",
  },
  "opening.capture.afterOnly": {
    en: "Take the after photo of the finished window.",
    es: "Toma la foto de después de la ventana terminada.",
  },

  // ---- The one Capture button, on every screen (2026-09-05) -------------
  // The owner's ask: "you should see the capture button on every tab and view
  // through the app, it should also be able to capture a photo and assign it
  // to a job, in fact, thats how the receipt should work too."
  //
  // The sheet and the daily-log dialog were the two capture surfaces still
  // hardcoded in English, and this is the one aimed squarely at the installer
  // floor — most of whom read Spanish more comfortably. The English below is
  // exactly what those screens said before, so nothing changes for a reader
  // in English. Nothing here is safety copy, so none of it is a SAFETY_KEY.
  "capture.tab": { en: "Capture", es: "Capturar" },
  "capture.a11y.open": { en: "Quick capture", es: "Captura rápida" },
  "capture.title": { en: "Quick capture", es: "Captura rápida" },
  "capture.a11y.close": { en: "Close", es: "Cerrar" },

  // The job question at the top of the sheet.
  "capture.job.forJob": { en: "Capturing for", es: "Capturando para" },
  "capture.job.which": { en: "Which job? (optional)", es: "¿Qué trabajo? (opcional)" },
  "capture.job.pickForPhoto": {
    en: "Pick the job this photo belongs to.",
    es: "Elige el trabajo al que pertenece esta foto.",
  },
  "capture.job.pickForLog": {
    en: "Which job is this log for?",
    es: "¿De qué trabajo es este registro?",
  },
  "capture.job.change": { en: "Change", es: "Cambiar" },
  "capture.job.find": { en: "Find a job", es: "Buscar un trabajo" },
  "capture.job.hideList": { en: "Hide job list", es: "Ocultar la lista" },
  "capture.job.search": { en: "Search jobs…", es: "Buscar trabajos…" },
  "capture.job.a11ySearch": { en: "Search jobs", es: "Buscar trabajos" },
  "capture.job.noMatch": { en: "No jobs match “{q}”.", es: "Ningún trabajo coincide con “{q}”." },
  "capture.job.none": { en: "No job — general", es: "Sin trabajo — general" },
  // Every chip says why it is being offered, the way the receipt follow-up's
  // suggestions already do. A chip with no reason is a guess the person has
  // to audit; a chip with a reason is an answer they can accept.
  "capture.job.reason.near": { en: "You're near this one", es: "Estás cerca de este" },
  "capture.job.reason.last": { en: "Last time", es: "La vez pasada" },
  "capture.job.reason.recent": { en: "Recent", es: "Reciente" },

  // The tiles.
  "capture.tile.photo": { en: "Take a photo", es: "Tomar una foto" },
  "capture.tile.photoHint": {
    en: "Attach a progress or install photo",
    es: "Adjunta una foto del avance o de la instalación",
  },
  "capture.tile.receipt": { en: "Add a receipt", es: "Agregar un recibo" },
  "capture.tile.receiptHint": {
    en: "Snap or upload a materials receipt",
    es: "Toma o sube un recibo de materiales",
  },
  "capture.tile.dailyLog": { en: "Daily log", es: "Registro del día" },
  "capture.tile.dailyLogHint": {
    en: "Log today's progress and notes",
    es: "Anota el avance y las notas de hoy",
  },
  "capture.tile.gallery": { en: "Open gallery", es: "Abrir la galería" },
  "capture.tile.galleryHint": {
    en: "Browse the photo & receipt library",
    es: "Explora las fotos y los recibos",
  },
  "capture.tile.scan": { en: "Scan a unit", es: "Escanear una unidad" },
  "capture.tile.scanHint": {
    en: "Look up a unit by its QR/ID",
    es: "Busca una unidad por su QR o ID",
  },

  // After a photo queues.
  "capture.photo.queuedOne": {
    en: "Photo saved — syncing in the background.",
    es: "Foto guardada — sincronizando en segundo plano.",
  },
  "capture.photo.queuedMany": {
    en: "{n} photos saved — syncing in the background.",
    es: "{n} fotos guardadas — sincronizando en segundo plano.",
  },
  "capture.photo.toJob": { en: "Filed to {job}.", es: "Archivada en {job}." },
  "capture.photo.toNoJob": {
    en: "Filed with no job — you can set one later in the gallery.",
    es: "Archivada sin trabajo — puedes elegir uno después en la galería.",
  },
  "capture.photo.seeGallery": { en: "See it in the gallery", es: "Verla en la galería" },
  "capture.photo.another": { en: "Take another", es: "Tomar otra" },

  // The offer that appears once, when a foreman clocks off a job nobody has
  // logged today. Never for installers — they cannot read a log at all.
  "dailyLog.nudge.ask": { en: "Log today for {job}?", es: "¿Anotar el día de {job}?" },
  "dailyLog.nudge.write": { en: "Write it", es: "Anotarlo" },
  "dailyLog.nudge.dismiss": { en: "Not now", es: "Ahora no" },

  "capture.receipt.changeJob": {
    en: "That's the job it went to. Pick another below if it belongs somewhere else.",
    es: "Ese es el trabajo al que se archivó. Elige otro abajo si pertenece a otro lugar.",
  },
} satisfies Record<string, CatalogEntry>;

/** Every key the catalog knows. Later slices widen this by adding entries. */
export type TKey = keyof typeof CATALOG;
