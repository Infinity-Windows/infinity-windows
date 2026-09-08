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
  // Clock in once (2026-09-06): the nudge for a talk signed after the picks
  // above it came apart. Same family as clockblock.signFirst.
  "clockblock.signedPickCode",
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

  // ---- The trip editor's crew picker (2026-09-05) ----------------------
  // The strings a supervisor building a trip reads. The label carries the
  // count so somebody who has scrolled past the grid still knows how many
  // people are on the trip without scrolling back up. Spanish splits singular
  // from plural, same shape as crewclock.bar.count above — the caller picks
  // the key by count, because interpolate() has no plural rule of its own.
  "travel.crew.label": { en: "Assigned crew", es: "Cuadrilla asignada" },
  "travel.crew.labelCount.one": {
    en: "Assigned crew · {n} selected",
    es: "Cuadrilla asignada · {n} seleccionado",
  },
  "travel.crew.labelCount.many": {
    en: "Assigned crew · {n} selected",
    es: "Cuadrilla asignada · {n} seleccionados",
  },
  "travel.crew.empty": {
    en: "No crew found.",
    es: "No hay nadie en la lista.",
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
  "capture.job.which": { en: "Which job?", es: "¿Qué trabajo?" },
  // Stands in for the job's name in the gap where the sheet knows WHICH job
  // (the open shift told it) but the jobs list has not loaded yet, so there is
  // no code or name to print.
  "capture.job.yourJob": { en: "The job you're on", es: "El trabajo en el que estás" },
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
  // The line the camera sheet itself shows after a shot. It was hardcoded
  // English inside an otherwise fully translated component, and the global
  // Capture button now puts it in front of the installer floor several times a
  // day, which is where that gap started to matter.
  "photo.queuedOne": {
    en: "1 photo queued — syncing in the background.",
    es: "1 foto en cola — sincronizando en segundo plano.",
  },
  "photo.queuedMany": {
    en: "{n} photos queued — syncing in the background.",
    es: "{n} fotos en cola — sincronizando en segundo plano.",
  },
  "photo.receiptQueued": {
    en: "Receipt saved — syncing in the background.",
    es: "Recibo guardado — sincronizando en segundo plano.",
  },
  // The camera does not open without a job. A photo has nowhere to be filed
  // without one, and finding that out after the shot means losing the shot.
  "photo.needJob": {
    en: "Pick a job first — a photo has to belong to one. Choose it above, then come back.",
    es: "Elige primero un trabajo — una foto tiene que pertenecer a uno. Selecciónalo arriba y vuelve.",
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

  // ---- The daily log dialog ---------------------------------------------
  // Foreman-and-up only (Q7), but plenty of foremen on this crew read Spanish
  // first, and this is the one screen where somebody writes several sentences
  // in their own words. It was hardcoded English until now; the English below
  // is exactly what it said before.
  "dailyLog.title.edit": { en: "Edit the log", es: "Editar el registro" },
  "dailyLog.title.new": { en: "Log today", es: "Anotar el día" },
  "dailyLog.loading": {
    en: "Putting together what happened today…",
    es: "Reuniendo lo que pasó hoy…",
  },
  // Shown when the phone could not read today's log — no signal, usually. The
  // box below opens empty in that case, and without this line an empty box
  // reads as "nobody has written today", which may be untrue.
  "dailyLog.cannotCheck": {
    en: "Can't check today's log from here. Write what you've got — it gets added to whatever is already there, never written over it.",
    es: "No se puede revisar el registro de hoy desde aquí. Escribe lo que tengas — se agregará a lo que ya esté, nunca lo reemplaza.",
  },
  "dailyLog.field.headline": { en: "Headline", es: "Titular" },
  "dailyLog.field.dayFlow": { en: "Day flow", es: "Cómo fue el día" },
  "dailyLog.flow.smooth": { en: "Smooth", es: "Tranquilo" },
  "dailyLog.flow.fine": { en: "Fine", es: "Normal" },
  "dailyLog.flow.stuck": { en: "Stuck", es: "Atorado" },
  "dailyLog.field.wentWell": { en: "What went well", es: "Qué salió bien" },
  "dailyLog.field.wentPoorly": { en: "What went poorly", es: "Qué salió mal" },
  "dailyLog.field.wouldHaveHelped": {
    en: "What would have helped",
    es: "Qué habría ayudado",
  },
  "dailyLog.field.whatWorked": {
    en: "What's worth doing again",
    es: "Qué vale la pena repetir",
  },
  "dailyLog.field.notes": {
    en: "Notes — what did the crew get done today?",
    es: "Notas — ¿qué logró la cuadrilla hoy?",
  },
  "dailyLog.field.notesPlaceholder": {
    en: "What got done, what didn't, anything worth a word",
    es: "Qué se hizo, qué no, y cualquier cosa que valga mencionar",
  },
  "dailyLog.field.weather": { en: "Weather (optional)", es: "Clima (opcional)" },
  // The accessible names, shorter than the visible labels on purpose: a screen
  // reader announcing "Notes — what did the crew get done today?, edit text"
  // buries the field under its own prompt.
  "dailyLog.a11y.headline": { en: "Headline", es: "Titular" },
  "dailyLog.a11y.notes": { en: "Notes", es: "Notas" },
  "dailyLog.a11y.weather": { en: "Weather", es: "Clima" },
  "dailyLog.field.weatherPlaceholder": { en: "Clear, 88°, breezy", es: "Despejado, 88°, con brisa" },
  "dailyLog.action.save": { en: "Save", es: "Guardar" },
  "dailyLog.action.saving": { en: "Saving…", es: "Guardando…" },
  "dailyLog.action.cancel": { en: "Cancel", es: "Cancelar" },
  "dailyLog.notesGate": {
    en: "Add a few words about what got done before saving.",
    es: "Escribe unas palabras sobre lo que se hizo antes de guardar.",
  },
  "dailyLog.saved": { en: "Day logged.", es: "Día anotado." },
  // The calm sentence for no signal — the same voice the photo sheet uses,
  // because to the foreman standing in the canyon the log IS written.
  "dailyLog.savedOffline": {
    en: "Saved on your phone — it'll send itself.",
    es: "Guardado en tu teléfono — se enviará solo.",
  },

  // ---- Photos: the phone's own picker, and the Photos / Receipts toggle ----
  // (2026-09-05). "Upload files" used to carry a `capture` attribute, so it
  // could only ever open the camera; now it opens the library, the Files app
  // and Drive, and whatever comes back may not be a picture at all — hence the
  // first line. The rest is the toggle that finally makes a job's receipts
  // reachable from the Photos page and from the job's own Photos tab.
  "photo.fileUnreadable": {
    en: "That file isn't a photo this phone can read — try a JPG or PNG.",
    es: "Ese archivo no es una foto que este teléfono pueda leer — usa un JPG o PNG.",
  },
  "photos.kind.photos": { en: "Photos", es: "Fotos" },
  "photos.kind.receipts": { en: "Receipts", es: "Recibos" },
  "photos.kind.aria": { en: "Photos or receipts", es: "Fotos o recibos" },
  // An installer sees only the receipts they added (that is the receipts
  // table's own RLS), so an empty list here must not read as "nobody bought
  // anything for this job". A foreman, who sees them all, keeps the plain line.
  "feed.noReceiptsMineMsg": {
    en: "You only see receipts you added. Snap a gas or materials receipt — the job is optional.",
    es: "Solo ves los recibos que tú agregaste. Toma una foto de un recibo de gasolina o materiales — el trabajo es opcional.",
  },

  // ---- Photos: the camera that is only busy, not gone (2026-09-05) ----
  // Two different failures used to share one sentence. "Camera unavailable —
  // use Upload files instead" is the truth when the permission was refused or
  // the phone has no camera; it is wrong when another app simply had the lens
  // for a moment, which is the everyday Android one. That case keeps the live
  // shutter on the sheet, so the line has to say what to do to get it back.
  "photo.cameraBusy": {
    en: "Camera busy — close any other app using it, then tap Use camera again.",
    es: "Cámara ocupada — cierra la otra app que la esté usando y toca Usar cámara otra vez.",
  },

  // ---- Receipts that arrive as a PDF (2026-09-05) ----
  // The receipt picker takes a PDF now — the emailed fuel invoice, the
  // supply-house statement. The phone renders page one and files THAT as the
  // receipt's picture, and keeps the original file beside it. These are the two
  // ways that can go wrong, in words an installer standing in a parking lot can
  // act on: a file that will not open at all, and one too big to keep a copy of.
  // Shown WHILE a PDF is being read, in place of "Stamping GPS & time…". A PDF
  // gets the time and never a position — the watermark rule is about a photo
  // taken at the wall — and this is the slowest wait on the capture sheet, so
  // the wrong sentence would be the one an installer stares at longest.
  "photo.readingPdf": { en: "Reading the PDF…", es: "Leyendo el PDF…" },
  "photo.pdfUnreadable": {
    en: "That PDF couldn't be opened — it may be password-protected or damaged. Try saving it again, or take a photo of the receipt.",
    es: "No se pudo abrir ese PDF — puede estar protegido con contraseña o dañado. Vuelve a guardarlo, o toma una foto del recibo.",
  },
  // Said AFTER the receipt is already saved, which is the whole point of the
  // second sentence: what was lost is the copy of the original file, not the
  // receipt, and nobody should re-do the work thinking it failed.
  "photo.pdfTooBig": {
    en: "That PDF is too big to keep a copy of. The receipt was still saved — the first page is on it.",
    es: "Ese PDF es demasiado grande para guardar una copia. El recibo sí se guardó — la primera página está en él.",
  },
  // The tag on a receipt whose original file we kept, and the way back to it.
  // "Open original" and not "Download": the link opens the PDF in a new tab,
  // where a phone shows it and offers to save it if that is what somebody wants.
  "receipt.pdfTag": { en: "PDF", es: "PDF" },
  "receipt.openOriginal": { en: "Open original", es: "Abrir original" },
  "receipt.openOriginalFailed": {
    en: "Couldn't open that PDF just now — check your signal and try again.",
    es: "No se pudo abrir ese PDF ahora — revisa tu señal e inténtalo otra vez.",
  },

  // ---- Learn: points are for new content now (2026-09-05) ----
  // The Quiz and Sequence tabs used to write their own points after every
  // round, so "Another round" paid again for the same five terms, hundreds of
  // times over between two profiles in a single day. A term now pays the
  // first time it is answered correctly and never again, which means the
  // screen has to say two different things: what a round earned, and why a
  // round earned nothing. Neither is a telling-off — practising is still free
  // and still encouraged, so the "keep practising" half is the point.
  // The "How points work" line on the Points page. It used to read "+10 /
  // correct", which stopped being true the day a term started paying once.
  "points.rule.quiz": {
    en: "Quiz: +{points} the first time you get a term right — once per term",
    es: "Examen: +{points} la primera vez que aciertas un término — una vez por término",
  },
  "learn.points.progress": {
    en: "Earned {earned} of {total} terms",
    es: "Ganados {earned} de {total} términos",
  },
  "learn.points.newOne": {
    en: "+{points} points — 1 new term.",
    es: "+{points} puntos — 1 término nuevo.",
  },
  "learn.points.newMany": {
    en: "+{points} points — {count} new terms.",
    es: "+{points} puntos — {count} términos nuevos.",
  },
  "learn.points.none": {
    en: "No new points — you'd already earned these. Keep practising.",
    es: "Sin puntos nuevos — ya los habías ganado. Sigue practicando.",
  },
  // A round with nothing right is not the same round as one where every term
  // was already earned, and telling somebody "you'd already earned these"
  // after they missed all five is just untrue. The server returns the two
  // apart — new_terms and already_had — so the screen says them apart too.
  "learn.points.noneRight": {
    en: "No new points this round — none of those were right. Keep practising.",
    es: "Sin puntos nuevos en esta ronda — no acertaste ninguno. Sigue practicando.",
  },
  "learn.points.sequenceEarned": {
    en: "+{points} points — you've earned the install sequence.",
    es: "+{points} puntos — ganaste la secuencia de instalación.",
  },
  // The bar exists because the sequence is one procedure, not five facts: half
  // of it in the right order is not knowing it. 4 of 5 is the same bar a video
  // quiz passes at, so a crew member learns one number, not two.
  "learn.points.sequenceBar": {
    en: "Get 4 of 5 to earn the install sequence. Keep practising.",
    es: "Acierta 4 de 5 para ganar la secuencia de instalación. Sigue practicando.",
  },
  "learn.points.sequenceHad": {
    en: "No new points — you've already earned the install sequence. Keep practising.",
    es: "Sin puntos nuevos — ya ganaste la secuencia de instalación. Sigue practicando.",
  },
  "learn.points.newContentOnly": {
    en: "Points are for terms you haven't earned yet. Practise as much as you like.",
    es: "Los puntos son por términos que aún no has ganado. Practica todo lo que quieras.",
  },
  "learn.points.saving": {
    en: "Counting your points…",
    es: "Contando tus puntos…",
  },
  // The deploy window. The frontend and the database ship from one merge
  // through two independent workflows, so for a few minutes either can be
  // ahead — and the round an installer just played is not the place to say so
  // in red. Their answers are safe; the points land next time.
  "learn.points.notReadyYet": {
    en: "Points aren't ready yet — that round still counted as practice. Try again in a few minutes.",
    es: "Los puntos aún no están listos — esa ronda contó como práctica. Intenta otra vez en unos minutos.",
  },
  "learn.points.failed": {
    en: "Points didn't save: {reason}",
    es: "Los puntos no se guardaron: {reason}",
  },
  "learn.points.anotherRound": { en: "Another round", es: "Otra ronda" },

  // --- Save for offline (ticket 05, 2026-09-06) ----------------------------
  "offline.save": { en: "Save for offline", es: "Guardar sin señal" },
  "offline.savingStart": { en: "Saving…", es: "Guardando…" },
  "offline.saving": { en: "Saving… {done} of {total}", es: "Guardando… {done} de {total}" },
  "offline.saved": { en: "Saved offline · {ago}", es: "Guardado sin señal · {ago}" },
  "offline.savedMissing": {
    en: "Saved offline · {ago} · {n} items missing, refresh with better signal",
    es: "Guardado sin señal · {ago} · faltan {n} elementos, actualiza con mejor señal",
  },
  "offline.savedPartly": {
    en: "Saved, but {n} items could not be downloaded — try again with better signal",
    es: "Guardado, pero {n} elementos no se pudieron descargar — intenta de nuevo con mejor señal",
  },
  "offline.failed": {
    en: "Couldn't save this job. Try again with better signal.",
    es: "No se pudo guardar este trabajo. Intenta de nuevo con mejor señal.",
  },
  "offline.refresh": { en: "Refresh the offline copy", es: "Actualizar la copia sin señal" },
  "offline.strip": {
    en: "{saved} of {total} jobs saved on this phone",
    es: "{saved} de {total} trabajos guardados en este teléfono",
  },
  "offline.saveAll": { en: "Save all for offline", es: "Guardar todos sin señal" },
  "offline.refreshAll": { en: "Refresh offline copies", es: "Actualizar copias sin señal" },
  "offline.savingJobs": {
    en: "Saving job {i} of {n}… {done} of {total}",
    es: "Guardando trabajo {i} de {n}… {done} de {total}",
  },
  "offline.justNow": { en: "just now", es: "ahora mismo" },
  "offline.minAgo": { en: "{n} min ago", es: "hace {n} min" },
  "offline.hoursAgo": { en: "{n} h ago", es: "hace {n} h" },
  "offline.daysAgo": { en: "{n} d ago", es: "hace {n} d" },

  // --- Weak signal, saved copies, diagnostics (ticket 06, 2026-09-06) ------
  "offline.savedCopy.offline": {
    en: "Showing the last saved copy — no signal right now.",
    es: "Mostrando la última copia guardada — sin señal ahora.",
  },
  "offline.savedCopy.weak": {
    en: "Showing the last saved copy — the signal is weak.",
    es: "Mostrando la última copia guardada — la señal es débil.",
  },
  "offline.savedCopy.failed": {
    en: "Showing the last saved copy — the last refresh failed.",
    es: "Mostrando la última copia guardada — la última actualización falló.",
  },
  "pill.noSignal": { en: "No signal", es: "Sin señal" },
  "pill.noSignalDetail": {
    en: "No signal. Changes are saved on this phone and send when it returns.",
    es: "Sin señal. Los cambios se guardan en este teléfono y se envían cuando vuelva.",
  },
  "pill.weakSignal": { en: "Weak signal", es: "Señal débil" },
  "pill.weakDetail": {
    en: "Requests are timing out. Screens show the last saved copy.",
    es: "Las solicitudes están tardando demasiado. Las pantallas muestran la última copia guardada.",
  },
  "diag.eyebrow": { en: "Support", es: "Soporte" },
  "diag.title": { en: "Diagnostics", es: "Diagnóstico" },
  "diag.back": { en: "Settings", es: "Ajustes" },
  "diag.intro": {
    en: "What this phone knows about its connection and its queues. Copy the report into a message when something didn't save.",
    es: "Lo que este teléfono sabe de su conexión y sus colas. Copia el informe en un mensaje cuando algo no se guardó.",
  },
  "diag.copy": { en: "Copy report", es: "Copiar informe" },
  "diag.copied": { en: "Copied", es: "Copiado" },
  "diag.connection": { en: "Connection", es: "Conexión" },
  "diag.online": { en: "Online", es: "En línea" },
  "diag.offline": { en: "No signal", es: "Sin señal" },
  "diag.weak": { en: "Weak signal", es: "Señal débil" },
  "diag.lastOk": { en: "Last good request: {ago}", es: "Última solicitud correcta: {ago}" },
  "diag.never": { en: "never this session", es: "nunca en esta sesión" },
  "diag.queues": { en: "Waiting to send", es: "Pendiente de enviar" },
  "diag.needAttention": { en: "{n} need attention", es: "{n} necesitan atención" },
  "diag.savedJobs": { en: "Jobs saved on this phone", es: "Trabajos guardados en este teléfono" },
  "diag.missing": { en: "{n} items missing", es: "faltan {n} elementos" },
  "diag.none": { en: "None yet.", es: "Ninguno todavía." },
  "diag.events": { en: "What the connection did this session", es: "Qué hizo la conexión en esta sesión" },
  "diag.eventsSummary": {
    en: "{timeouts} timeouts · {copies} saved-copy screens · {sent} items sent · {jobs} jobs saved",
    es: "{timeouts} tiempos agotados · {copies} pantallas con copia guardada · {sent} elementos enviados · {jobs} trabajos guardados",
  },
  "diag.noEvents": { en: "Nothing yet.", es: "Nada todavía." },
  "settings.diagnostics.heading": { en: "Diagnostics", es: "Diagnóstico" },
  "settings.diagnostics.help": {
    en: "When something didn't save, this page shows what the phone knows and gives you a report to send.",
    es: "Cuando algo no se guardó, esta página muestra lo que sabe el teléfono y te da un informe para enviar.",
  },
  "settings.diagnostics.open": { en: "Open diagnostics", es: "Abrir diagnóstico" },

  // --- Stale chunk after a deploy (ticket 07, 2026-09-06) --------------------
  "pwa.staleChunk": {
    en: "The app updated while you were working. Finish and save, then pull down to refresh.",
    es: "La app se actualizó mientras trabajabas. Termina y guarda, luego desliza hacia abajo para actualizar.",
  },

  // ---- Learning time (2026-09-05) ----------------------------------------
  // The owner's ask: "a timer that I can see as an owner how long they spend in
  // the learning tab and on what item… as well as a timer for watching the
  // YouTube videos, to see if they watch the whole thing and how many times."
  //
  // Everything this build says, in one block, both languages. The two sentences
  // that MATTER most are `ltime.blurb` and `learn.time.why`: they are the same
  // promise said to the two different people it is about — the owner reading
  // the table, and the crew member being measured — and they have to agree with
  // each other and with the migration's own header.
  "ltime.section": { en: "Learning", es: "Aprendizaje" },
  "ltime.title": { en: "Learning time", es: "Tiempo de aprendizaje" },
  "ltime.back": { en: "Home", es: "Inicio" },
  // Says the idle gate out loud, in both places. A page left open on a desk
  // stops counting after ten minutes, and an owner reading these numbers has to
  // know that or they will read a parked tab as a long evening of study.
  "ltime.blurb": {
    en: "How long each person spends in Learn, and on what. Counted only while the screen is in front of them and they are using it — never while the phone is locked, the app is in the background, or the page has sat untouched for ten minutes.",
    es: "Cuánto tiempo pasa cada persona en Aprender, y en qué. Solo cuenta mientras la pantalla está frente a ellos y la están usando — nunca con el teléfono bloqueado, con la app en segundo plano, ni con la página sin tocar por diez minutos.",
  },
  "ltime.range.aria": { en: "Time range", es: "Rango de fechas" },
  "ltime.range.week": { en: "This week", es: "Esta semana" },
  "ltime.range.fourWeeks": { en: "Last 4 weeks", es: "Últimas 4 semanas" },
  "ltime.range.all": { en: "All time", es: "Todo el tiempo" },
  "ltime.sort.aria": { en: "Sort", es: "Ordenar" },
  "ltime.sort.time": { en: "Most time first", es: "Más tiempo primero" },
  "ltime.sort.name": { en: "By name", es: "Por nombre" },
  "ltime.loadError": {
    en: "Couldn't load learning time",
    es: "No se pudo cargar el tiempo de aprendizaje",
  },
  "ltime.empty.title": { en: "Nothing recorded yet", es: "Aún no hay nada registrado" },
  "ltime.empty.body": {
    en: "Time starts counting the next time somebody opens Learn.",
    es: "El tiempo empieza a contar la próxima vez que alguien abra Aprender.",
  },
  "ltime.inLearn": { en: "in Learn", es: "en Aprender" },
  "ltime.last": { en: "last {when}", es: "última vez {when}" },
  "ltime.kind.term": { en: "Glossary terms", es: "Términos del glosario" },
  "ltime.kind.quiz": { en: "Quiz", es: "Examen" },
  "ltime.kind.sequence": { en: "Sequence", es: "Secuencia" },
  "ltime.kind.video": { en: "Lessons playing", es: "Lecciones en reproducción" },
  // Said plainly because the alternative is an owner adding the chips up and
  // getting more than the total.
  "ltime.breakdownNote": {
    en: "These are part of the total above, not extra time on top of it.",
    es: "Esto es parte del total de arriba, no tiempo adicional.",
  },
  // The second half of the owner's question — "and on what item". The chips
  // above these say how long on glossary terms; these say WHICH terms.
  "ltime.items": { en: "What they were on", es: "En qué estuvieron" },
  "ltime.visitsOne": { en: "1 visit", es: "1 visita" },
  "ltime.visitsMany": { en: "{count} visits", es: "{count} visitas" },
  "ltime.moreItems": {
    en: "and {count} more",
    es: "y {count} más",
  },
  "ltime.lessons": { en: "Lessons", es: "Lecciones" },
  "ltime.timesWatched": { en: "watched {count}×", es: "visto {count}×" },
  "ltime.percentAll": { en: "{percent}% watched", es: "{percent}% visto" },
  "ltime.percentBest": { en: "best sitting {percent}%", es: "mejor sesión {percent}%" },
  "ltime.lengthUnknown": {
    en: "{time} played, length unknown",
    es: "{time} reproducidos, duración desconocida",
  },
  "ltime.finished": { en: "Finished", es: "Terminado" },
  "ltime.notFinished": { en: "Not finished", es: "Sin terminar" },
  // The definition, on screen, because "watched 3×" means nothing until the
  // reader knows what the app counts as a watch.
  // The other half of the same promise, said to the person it is about — the
  // footer at the bottom of Learn. `learn.time.why` and `ltime.blurb` are
  // deliberately the same sentence from the two sides, and both agree with the
  // migration's own header.
  "learn.time.yours": { en: "Your learning time:", es: "Tu tiempo de aprendizaje:" },
  "learn.time.week": { en: "{time} this week", es: "{time} esta semana" },
  "learn.time.lessonsOne": { en: "1 lesson finished", es: "1 lección terminada" },
  "learn.time.lessonsMany": {
    en: "{count} lessons finished",
    es: "{count} lecciones terminadas",
  },
  "learn.time.none": { en: "nothing yet this week", es: "nada aún esta semana" },
  "learn.time.why": {
    en: "Time in Learn is recorded so the company can see the effort you put in. It only counts while this screen is in front of you and you are using it — never while your phone is locked or the app is in the background, and it stops if the page sits untouched for ten minutes. A lesson that is playing always counts.",
    es: "El tiempo en Aprender se registra para que la empresa vea el esfuerzo que pones. Solo cuenta mientras esta pantalla está frente a ti y la estás usando — nunca con el teléfono bloqueado ni con la app en segundo plano, y se detiene si dejas la página sin tocar por diez minutos. Una lección que se está reproduciendo siempre cuenta.",
  },
  "ltime.watchNote": {
    en: "A watch is one visit that got through at least 30 seconds. The percentage is how much of the lesson was actually played — skipping to the end can finish a video without watching it.",
    es: "Una vista es una visita que pasó al menos 30 segundos. El porcentaje es cuánto de la lección se reprodujo de verdad — saltar al final puede terminar un video sin verlo.",
  },

  // ---- The crash screen, and the code the crew reads out (2026-09-05) ----
  // Shown by components/ErrorBoundary.tsx when a screen crashes. It is the one
  // screen an installer reaches with nothing else on it, so it is also the one
  // where English-only copy would cost the most — a Spanish-reading installer
  // has to understand that the work on the phone is safe and that there is a
  // code worth reading out before anyone can help them.
  //
  // The boundary sits ABOVE LanguageProvider (main.tsx), and the crash it
  // caught has just unmounted whatever provider was below it, so the screen
  // cannot read the live language through useT(). It reads the per-device
  // language cache instead — the same thing the very first paint uses before
  // any query returns. See ErrorBoundary.tsx.
  "crash.title": { en: "Something went wrong", es: "Algo salió mal" },
  // The reassurance first, because the fear is "did I just lose the morning's
  // installs?" — and the answer is no: the outbox is on the phone, untouched.
  "crash.saved": {
    en: "The screen crashed, but anything saved on this phone (installs and photos waiting to send) is still here.",
    es: "La pantalla falló, pero todo lo guardado en este teléfono (instalaciones y fotos en espera de enviarse) sigue aquí.",
  },
  // The five-character code is printed beside this line, not inside it: it is
  // the same characters in both languages and it must not be translated,
  // re-ordered or wrapped away from the sentence that asks for it.
  "crash.readCode": {
    en: "If you call this in, read out this code:",
    es: "Si llamas para reportarlo, di este código:",
  },
  "crash.tryAgain": { en: "Try again", es: "Intentar de nuevo" },
  "crash.reload": { en: "Reload", es: "Recargar" },

  // ---- The gallery an installer sees (2026-09-05) ----
  // Below foreman, the photo feed is the jobs this person has worked plus the
  // shots they took themselves — that is the attachments read policy
  // (20260995000000), not a filter the screen applies. Two consequences have
  // to be said out loud, or the screen lies by omission.
  //
  // 1. The "everything" option is not everything. A foreman picking it gets
  //    every job; an installer gets every job of THEIRS, and the word "my" is
  //    the whole difference between a list that looks broken and one that
  //    looks deliberate.
  "photos.filter.allJobs": { en: "All jobs", es: "Todos los trabajos" },
  "photos.filter.allMyJobs": { en: "All my jobs", es: "Todos mis trabajos" },
  // 2. An empty grid means "none of yours", not "nobody took any". Same
  //    distinction feed.noReceiptsMineMsg already draws for receipts, and it
  //    matters more here: photos are the thing a person goes looking for when
  //    somebody asks what a wall looked like before the trim went on.
  "feed.noPhotosMineMsg": {
    en: "Photos from the jobs you've worked show here. Take one and it lands on this list.",
    es: "Aquí aparecen las fotos de los trabajos en los que has trabajado. Toma una y se agrega a esta lista.",
  },

  // ---- Clock in once (2026-09-06) ----
  // The landing block's punch can still be refused — no signal, or a server
  // no — and then the full clock sheet opens with the picks carried in. The
  // old hand-off opened it in silence; a person whose tap "did nothing but
  // open a sheet" needs one sentence saying why, with the reason on the end.
  "clockblock.handoff": {
    en: "Couldn't clock in from here — finish in the clock sheet. {reason}",
    es: "No se pudo marcar entrada desde aquí — termina en la hoja del reloj. {reason}",
  },
  // The talk was signed, but the job or cost code above it changed while the
  // signature was uploading, so the punch did not fire (review, 2026-09-06).
  // The signature stands; one more pick and the plain Start button is live.
  // SAFETY / toolbox — needs bilingual review.
  "clockblock.signedPickCode": {
    en: "Talk signed. Pick a cost code to clock in.",
    es: "Charla firmada. Elige un código de costo para marcar entrada.",
  },
  // ---- Sign in (installer-spanish-first-fourteen) ----------------------
  // Everything on the pre-login screen. It renders with NO LanguageProvider
  // mounted (App.tsx only mounts one once a session exists), so SignIn.tsx
  // carries its own tiny reactive read of the same per-device cache — see
  // the comment there. Values stay informal "tú" throughout, matching the
  // rest of the catalog.
  "signin.tagline": { en: "Windows & Doors", es: "Ventanas y puertas" },
  "signin.notConfigured": {
    en: "Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.",
    es: "Supabase no está configurado. Define VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.",
  },
  "signin.requestSubmitted.title": { en: "Request submitted", es: "Solicitud enviada" },
  "signin.requestSubmitted.body": {
    en: "You're in the approval queue. An admin will review it — you'll be able to sign in once you're approved.",
    es: "Estás en la fila de aprobación. Un administrador la revisará — podrás iniciar sesión en cuanto te aprueben.",
  },
  "signin.backToStart": { en: "Back to start", es: "Volver al inicio" },
  "signin.requestIntro": {
    en: "Submit your info — an admin approves new accounts before you can sign in.",
    es: "Envía tus datos — un administrador aprueba las cuentas nuevas antes de que puedas iniciar sesión.",
  },
  "signin.fullName": { en: "Full name", es: "Nombre completo" },
  "signin.email": { en: "Email", es: "Correo electrónico" },
  "signin.phone": { en: "Cell phone (optional)", es: "Celular (opcional)" },
  "signin.roleLabel": {
    en: "Role you're joining as",
    es: "Puesto con el que te unes",
  },
  "signin.role.installer": { en: "Installer", es: "Instalador" },
  "signin.role.foreman": { en: "Foreman", es: "Capataz" },
  // i18n-same-on-purpose: "supervisor" is the same word in Spanish.
  "signin.role.supervisor": { en: "Supervisor", es: "Supervisor" },
  "signin.submitting": { en: "Submitting...", es: "Enviando..." },
  "signin.submitRequest": { en: "Submit request", es: "Enviar solicitud" },
  "signin.backToSignIn": { en: "Back to sign in", es: "Volver a iniciar sesión" },
  "signin.kicker": { en: "Sign in to your portal", es: "Inicia sesión en tu portal" },
  "signin.password": { en: "Password", es: "Contraseña" },
  "signin.signingIn": { en: "Signing in...", es: "Iniciando sesión..." },
  "signin.signIn": { en: "Sign in", es: "Iniciar sesión" },
  "signin.haveCode": { en: "I was given a code", es: "Me dieron un código" },
  "signin.resetPassword": { en: "Reset password", es: "Restablecer contraseña" },
  // The wait time (e.g. "1:30" or "45s") comes from cooldownLabel and is the
  // same characters in both languages — interpolated, never translated.
  "signin.resetWait": {
    en: "Reset password — wait {wait}",
    es: "Restablecer contraseña — espera {wait}",
  },
  "signin.requestAccess": { en: "Request access", es: "Solicitar acceso" },
  "signin.footnote": {
    en: "New crew members need admin approval before their first sign-in.",
    es: "Los nuevos miembros de la cuadrilla necesitan aprobación de un administrador antes de su primer inicio de sesión.",
  },
  "signin.enterEmailFirst": {
    en: "Enter your email first, then reset password.",
    es: "Escribe tu correo primero y luego restablece la contraseña.",
  },
  "signin.resetSent": {
    en: "Password reset email sent — check your inbox, then Sign in.",
    es: "Correo de restablecimiento enviado — revisa tu bandeja de entrada y luego inicia sesión.",
  },
  // ---- Join crew (installer-spanish-first-fourteen) --------------------
  // A new hire's first screen, reached from a texted link with no session
  // and no LanguageProvider — same usePreAuthT pattern as Sign in.
  "joinCrew.badCode": {
    en: "That code isn't right. It's 10 letters and numbers.",
    es: "Ese código no es correcto. Son 10 letras y números.",
  },
  "joinCrew.checkPassword": { en: "Check your password.", es: "Revisa tu contraseña." },
  "joinCrew.role.installer": { en: "Installer", es: "instalador" },
  "joinCrew.role.foreman": { en: "Foreman", es: "capataz" },
  "joinCrew.role.supervisor": { en: "Supervisor", es: "supervisor" },
  "joinCrew.role.owner": { en: "Owner", es: "dueño" },
  "joinCrew.alreadySignedIn": {
    en: "This phone is already signed in as {email}. Setting up a new person here will sign that account out.",
    es: "Este teléfono ya tiene una sesión iniciada como {email}. Configurar a otra persona aquí cerrará esa sesión.",
  },
  "joinCrew.signThatOut": { en: "Sign that account out", es: "Cerrar esa sesión" },
  "joinCrew.staySignedIn": { en: "Stay signed in", es: "Mantener la sesión" },
  "joinCrew.enterCode": { en: "Enter your code", es: "Escribe tu código" },
  "joinCrew.enterCodeHelp": {
    en: "Whoever added you sent you a 10-character code. Type it here — capitals, dashes and spaces don't matter.",
    es: "Quien te agregó te envió un código de 10 caracteres. Escríbelo aquí — mayúsculas, guiones y espacios no importan.",
  },
  "joinCrew.continue": { en: "Continue", es: "Continuar" },
  "joinCrew.haveLogin": { en: "I already have a login", es: "Ya tengo una cuenta" },
  "joinCrew.checkingCode": { en: "Checking your code…", es: "Revisando tu código…" },
  "joinCrew.hiName": { en: "Hi {name}", es: "Hola {name}" },
  "joinCrew.beingSetUp": { en: "You're being set up", es: "Te estamos configurando" },
  "joinCrew.pickPasswordExisting": {
    en: "Pick a new password for your {role} login. That's the only step.",
    es: "Elige una nueva contraseña para tu cuenta de {role}. Ese es el único paso.",
  },
  "joinCrew.pickPasswordNew": {
    en: "You've been added to Forge Windows as a {role}. Pick a password and you're in — there's no email to check.",
    es: "Te agregaron a Forge Windows como {role}. Elige una contraseña y listo — no hay correo que revisar.",
  },
  "joinCrew.pickPassword": { en: "Pick a password", es: "Elige una contraseña" },
  "joinCrew.minChars": {
    en: "At least {n} characters",
    es: "Al menos {n} caracteres",
  },
  "joinCrew.typeAgain": { en: "Type it again", es: "Escríbela de nuevo" },
  "joinCrew.samePassword": { en: "Same password", es: "Misma contraseña" },
  "joinCrew.hidePassword": { en: "Hide password", es: "Ocultar contraseña" },
  "joinCrew.showPassword": { en: "Show password", es: "Mostrar contraseña" },
  "joinCrew.settingUp": { en: "Setting you up…", es: "Configurándote…" },
  "joinCrew.startWorking": { en: "Start working", es: "Empezar a trabajar" },
  "joinCrew.codeWorksOnce": {
    en: "Code {code} · works once",
    es: "Código {code} · funciona una vez",
  },
  "joinCrew.backToSignIn": { en: "Back to sign in", es: "Volver a iniciar sesión" },
  // ---- Scan sheet (installer-spanish-first-fourteen) -------------------
  // The camera sheet every warehouse Scan button opens (components/warehouse/
  // ScanSheet.tsx) plus its verb labels (lib/warehouse/scanVerbs.ts, a pure
  // module used only here — `t` is threaded through it, defaulting to
  // English so its existing unit tests keep working unchanged). Also where
  // the audit's item C landed: the sheet used to stack TWO typed-entry boxes
  // (Scanner's own, plus this sheet's HandEntry) that called the exact same
  // lookup. Scanner's box is now suppressed here (showManualEntry={false})
  // and HandEntry is the one box left — it still takes a 6-character short
  // code OR a full serial, unchanged fallback lookup.
  "scan.title": { en: "Scan", es: "Escanear" },
  "scan.puttingAwayInto": { en: "Putting away into {place}", es: "Guardando en {place}" },
  "scan.selectedCount": { en: "{count} selected", es: "{count} seleccionados" },
  "scan.scanning": { en: "Scanning", es: "Escaneando" },
  "scan.leaveBox": { en: "Leave box", es: "Salir de la caja" },
  "scan.close": { en: "Close", es: "Cerrar" },
  "scan.boxBanner.before": {
    en: "Scan stickers — each one goes straight into",
    es: "Escanea etiquetas — cada una va directo a",
  },
  "scan.boxBanner.after": {
    en: "Scan another poster to switch boxes.",
    es: "Escanea otro cartel para cambiar de caja.",
  },
  "scan.hint": { en: "Point at any sticker or box poster", es: "Apunta a cualquier etiqueta o cartel de caja" },
  "scan.whichBox": { en: "Which box?", es: "¿Cuál caja?" },
  "scan.tapWhereOne": { en: "{item} — tap where it goes", es: "{item} — toca dónde va" },
  "scan.tapWhereMany": {
    en: "{count} packages — tap where they go",
    es: "{count} paquetes — toca dónde van",
  },
  // i18n-same-on-purpose: "conex" is the crew's own word in both languages (CONTEXT.md).
  "scan.conex": { en: "conex", es: "conex" },
  "scan.insideCount": { en: "{n} inside", es: "{n} adentro" },
  "scan.back": { en: "Back", es: "Atrás" },
  "scan.scanIntoBox": { en: "Scan what goes into {place}", es: "Escanea lo que va en {place}" },
  "scan.scanToSeeNext": {
    en: "Scan a sticker to see what to do next",
    es: "Escanea una etiqueta para ver qué sigue",
  },
  "scan.scanBoxFirst": {
    en: "Scan a box poster first and everything after it goes into that box.",
    es: "Escanea primero el cartel de una caja y todo lo que sigue va en esa caja.",
  },
  "scan.noPartNumber": { en: "no part number on label", es: "sin número de parte en la etiqueta" },
  "scan.multiSelected": { en: "{count} packages selected", es: "{count} paquetes seleccionados" },
  "scan.removeChip": { en: "Remove {code}", es: "Quitar {code}" },
  "scan.differentStates": {
    en: "These are in different states — scan them in smaller groups.",
    es: "Estos están en estados distintos — escanéalos en grupos más pequeños.",
  },
  "scan.keepScanning": { en: "Keep scanning to select several.", es: "Sigue escaneando para elegir varios." },
  "scan.clear": { en: "Clear", es: "Borrar" },
  "scan.noStickerLabel": { en: "No sticker? Type or pick", es: "¿Sin etiqueta? Escribe o elige" },
  "scan.codePlaceholder": {
    en: "Code on the label, e.g. AB7QLM or PKG-000214",
    es: "Código de la etiqueta, ej. AB7QLM o PKG-000214",
  },
  "scan.codeAria": { en: "Code", es: "Código" },
  "scan.go": { en: "Go", es: "Ir" },
  "scan.badCode": {
    en: "Not a code we know. Six letters and digits, or PKG- / CTR- and a number.",
    es: "No reconocemos ese código. Seis letras y números, o PKG- / CTR- y un número.",
  },
  "scan.pickByJobWindow": { en: "Pick it by job and window…", es: "Elígelo por trabajo y ventana…" },
  "scan.pickPiece": { en: "Pick the piece", es: "Elige la pieza" },
  "scan.jobAria": { en: "Job", es: "Trabajo" },
  "scan.jobPlaceholder": { en: "Job…", es: "Trabajo…" },
  "scan.windowAria": { en: "Window", es: "Ventana" },
  "scan.windowPlaceholder": { en: "Window…", es: "Ventana…" },
  "scan.windowOption": { en: "Window {mark}", es: "Ventana {mark}" },
  "scan.pieceOf": { en: "{index} of {total}", es: "{index} de {total}" },
  "scan.noPieces": {
    en: "No pieces tagged to window {mark} yet.",
    es: "Todavía no hay piezas etiquetadas a la ventana {mark}.",
  },
  "scan.putIn.one": { en: "1 package put in {place}.", es: "1 paquete guardado en {place}." },
  "scan.putIn.many": { en: "{count} packages put in {place}.", es: "{count} paquetes guardados en {place}." },
  "scan.arrived.one": { en: "Arrived. Now put it away.", es: "Llegó. Ahora guárdalo." },
  "scan.arrived.many": {
    en: "{count} arrived. Now put them away.",
    es: "Llegaron {count}. Ahora guárdalos.",
  },
  "scan.noPackageFound": { en: "No package found for {query}.", es: "No se encontró paquete para {query}." },
  "scan.noBoxFound": { en: "No box found for {serial}.", es: "No se encontró caja para {serial}." },
  "scan.slotLabel": {
    en: "That's a slot label. Scan a package sticker or a box poster.",
    es: "Esa es una etiqueta de casillero. Escanea una etiqueta de paquete o un cartel de caja.",
  },
  "scan.oldLabel": {
    en: "That's an old unit label — stickers replaced these. Scan the sticker instead.",
    es: "Esa es una etiqueta vieja de unidad — las etiquetas nuevas las reemplazaron. Escanea la etiqueta en su lugar.",
  },
  "scan.state.expected": { en: "expected — not arrived yet", es: "esperado — todavía no llega" },
  "scan.state.checkedOut": { en: "out on a job", es: "afuera en un trabajo" },
  "scan.state.blank": { en: "blank sticker — not on a package yet", es: "etiqueta en blanco — todavía sin paquete" },
  // scanVerbs.ts labels — the button text on the sheet's primary action.
  "scan.verb.sameBox": { en: "the same box", es: "la misma caja" },
  "scan.verb.putWithRest.label": {
    en: "Put with the rest of window {mark}",
    es: "Ponlo con el resto de la ventana {mark}",
  },
  "scan.verb.tag.label": { en: "Tag this sticker", es: "Registra esta etiqueta" },
  "scan.verb.tag.hint": { en: "say what it is and whose it is", es: "di qué es y de quién es" },
  "scan.verb.arrive.label": { en: "Arrived — it's off the truck", es: "Llegó — ya bajó del camión" },
  "scan.verb.arrive.hint": { en: "then put it away", es: "luego guárdalo" },
  "scan.verb.putAway.label": { en: "Put away", es: "Guardar" },
  "scan.verb.putAway.hint": { en: "tap a box", es: "toca una caja" },
  "scan.verb.checkOut.label": { en: "Check out to a job", es: "Sacar para un trabajo" },
  "scan.verb.move.label": { en: "Move to another box", es: "Mover a otra caja" },
  "scan.verb.backIn.label": { en: "Back in storage", es: "De vuelta en el almacén" },
  "scan.verb.fix.label": { en: "Fix something on this piece", es: "Corregir algo en esta pieza" },
  "scan.verb.fix.hint": {
    en: "label · job · window · note · photo",
    es: "etiqueta · trabajo · ventana · nota · foto",
  },
  "scan.verb.arriveAll": { en: "Arrived — all {n}", es: "Llegaron — los {n}" },
  "scan.verb.thenPutAway": { en: "then put them away", es: "luego guárdalos" },
  "scan.verb.putAllAway": { en: "Put all {n} away", es: "Guardar los {n}" },
  "scan.verb.checkOutAll": { en: "Check out all {n}", es: "Sacar los {n}" },
  // ---- My Schedule (installer-spanish-first-fourteen) ------------------
  "mySchedule.title": { en: "My Schedule", es: "Mi horario" },
  "mySchedule.subtitle": { en: "Your published jobs, day by day.", es: "Tus trabajos publicados, día por día." },
  "mySchedule.home": { en: "Home", es: "Inicio" },
  "mySchedule.loadError": { en: "Couldn't load your schedule", es: "No se pudo cargar tu horario" },
  "mySchedule.emptyTitle": { en: "Nothing scheduled yet", es: "Todavía no hay nada programado" },
  "mySchedule.emptyMessage": {
    en: "When your crew lead publishes a schedule, your jobs show up here.",
    es: "Cuando tu líder de cuadrilla publique un horario, tus trabajos aparecerán aquí.",
  },
  "mySchedule.todayPrefix": { en: "Today · ", es: "Hoy · " },
  "mySchedule.meetTruck": { en: "Meet the truck — {label}", es: "Recibe el camión — {label}" },
  "mySchedule.deliveryFallback": { en: "delivery", es: "entrega" },
  "mySchedule.jobFallback": { en: "Job", es: "Trabajo" },
  "mySchedule.withCrew": { en: "with {names}", es: "con {names}" },
  "mySchedule.travelLabel": { en: "Travel: {label}", es: "Viaje: {label}" },
  "mySchedule.cont": { en: "cont.", es: "continúa" },
  "mySchedule.startWork": { en: "Start work ›", es: "Empezar a trabajar ›" },
  "mySchedule.showMore": { en: "Show more", es: "Mostrar más" },
  // ---- My timecard (installer-spanish-first-fourteen) ------------------
  // Timecard.tsx, TimecardPanel.tsx (shared with the lead's TeamTimecards
  // drill-down — an installer only ever sees isLead=false, canEdit=false,
  // but the same file renders both, so every string here is translated
  // regardless of which caller reaches it), PunchCard.tsx, and SignOffCard.tsx.
  // ShiftEditor.tsx / ShiftHistory (sup-only edit form and its per-field
  // history) are left English — same carve-out as the travel editors, and
  // unreachable from an installer's own read-only view (canEdit=false).
  "timecard.pageTitle": { en: "My timecard", es: "Mi tarjeta de horas" },
  "timecard.pageSubtitle": { en: "Your hours", es: "Tus horas" },
  "timecard.home": { en: "Home", es: "Inicio" },
  "timecard.push.revertedTitle": { en: "Week approval reverted", es: "Se revirtió la aprobación de la semana" },
  "timecard.push.revertedBody": {
    en: "Your approved week was reverted: {reason}. Check My timecard — it needs re-approval.",
    es: "Se revirtió la aprobación de tu semana: {reason}. Revisa Mi tarjeta de horas — necesita aprobarse de nuevo.",
  },
  "timecard.push.restoredTitle": { en: "Timecard punch restored", es: "Se restauró un registro de la tarjeta de horas" },
  "timecard.push.restoredBody": {
    en: "A punch that was deleted from your timecard was put back.",
    es: "Un registro que se había eliminado de tu tarjeta de horas fue restaurado.",
  },
  "timecard.onBreak": { en: "On break", es: "En descanso" },
  "timecard.onClock": { en: "On the clock", es: "En turno" },
  "timecard.notClockedOut": { en: "Not clocked out", es: "Sin marcar salida" },
  "timecard.tooLongToTotal": {
    en: "On the clock {duration} — too long to total up. Needs a real finish time.",
    es: "En turno {duration} — demasiado tiempo para sumarlo. Necesita una hora de salida real.",
  },
  "timecard.since": { en: "since {time}", es: "desde {time}" },
  "timecard.onBreaksHours": { en: "{h} on breaks", es: "{h} en descansos" },
  "timecard.rangeAria": { en: "Timecard range", es: "Rango de la tarjeta de horas" },
  "timecard.tab.day": { en: "Day", es: "Día" },
  "timecard.tab.week": { en: "Week", es: "Semana" },
  "timecard.tab.pay": { en: "Pay period", es: "Periodo de pago" },
  "timecard.previous": { en: "Previous", es: "Anterior" },
  "timecard.next": { en: "Next", es: "Siguiente" },
  "timecard.jumpToNow": { en: "Jump back to now", es: "Volver a hoy" },
  "timecard.regular": { en: "Regular {h}", es: "Regulares {h}" },
  "timecard.overtime": { en: "Overtime {h}", es: "Tiempo extra {h}" },
  "timecard.doubleTime": { en: "Double {h}", es: "Doble {h}" },
  "timecard.onBreaksExcluded": { en: "{h} on breaks (excluded)", es: "{h} en descansos (no cuentan)" },
  "timecard.totalToday": { en: "Total today", es: "Total de hoy" },
  "timecard.totalPayPeriod": { en: "Total this pay period", es: "Total de este periodo de pago" },
  "timecard.totalWeek": { en: "Total this week", es: "Total de esta semana" },
  "timecard.approving": { en: "Approving…", es: "Aprobando…" },
  "timecard.approveWeek": { en: "Approve week ({n})", es: "Aprobar semana ({n})" },
  "timecard.weekApproved": { en: "Week approved", es: "Semana aprobada" },
  "timecard.keepApproved": { en: "Keep approved", es: "Mantener aprobada" },
  "timecard.unapproveWeek": { en: "Unapprove week", es: "Anular aprobación de la semana" },
  "timecard.unapproveExplain": {
    en: "The hours stay exactly as they are — only the approval is taken back. {name} gets notified with your reason, and the week can be re-approved after the fix.",
    es: "Las horas quedan exactamente igual — solo se retira la aprobación. {name} recibirá una notificación con tu motivo, y la semana se puede aprobar de nuevo después de corregirla.",
  },
  "timecard.unapproveReasonPlaceholder": {
    en: "Why is this approval being reverted?",
    es: "¿Por qué se está revirtiendo esta aprobación?",
  },
  "timecard.reverting": { en: "Reverting…", es: "Revirtiendo…" },
  "timecard.revertApproval": { en: "Revert approval", es: "Revertir aprobación" },
  "timecard.entries": { en: "Entries", es: "Registros" },
  "timecard.export": { en: "Export", es: "Exportar" },
  "timecard.exportCsv": { en: "Export CSV", es: "Exportar CSV" },
  "timecard.copyForSheets": { en: "Copy for Sheets", es: "Copiar para Sheets" },
  "timecard.printPdf": { en: "Print · PDF", es: "Imprimir · PDF" },
  "timecard.close": { en: "Close", es: "Cerrar" },
  "timecard.addEntry": { en: "+ Add entry", es: "+ Agregar registro" },
  "timecard.showRemoved": { en: "Show removed entries", es: "Mostrar registros eliminados" },
  "timecard.loadError": { en: "Couldn't load the timecard", es: "No se pudo cargar la tarjeta de horas" },
  "timecard.windowsInstalled.one": { en: "1 window installed:", es: "1 ventana instalada:" },
  "timecard.windowsInstalled.many": { en: "{count} windows installed:", es: "{count} ventanas instaladas:" },
  "timecard.noEntries": { en: "No entries", es: "Sin registros" },
  "timecard.add": { en: "+ Add", es: "+ Agregar" },
  "timecard.status.open": { en: "open", es: "abierto" },
  "timecard.status.submitted": { en: "submitted", es: "enviado" },
  "timecard.status.approved": { en: "approved", es: "aprobado" },
  "timecard.status.rejected": { en: "rejected", es: "rechazado" },
  "timecard.status.needsFinish": { en: "needs a finish time", es: "necesita hora de salida" },
  "timecard.status.voided": { en: "voided", es: "anulado" },
  "timecard.needsFinishTime": { en: "needs a finish time", es: "necesita hora de salida" },
  "timecard.injury": { en: "injury", es: "lesión" },
  "timecard.timeFlagged": { en: "time flagged by crew", es: "tiempo marcado por la cuadrilla" },
  "timecard.editedByHistory": { en: "edited by {name} · history", es: "editado por {name} · historial" },
  "timecard.editedBy": { en: "edited by {name}", es: "editado por {name}" },
  "timecard.someone": { en: "someone", es: "alguien" },
  "timecard.removedBy": { en: "Removed by {name}", es: "Eliminado por {name}" },
  "timecard.removed": { en: "Removed", es: "Eliminado" },
  // i18n-same-on-purpose: punctuation around an interpolated value, no words of its own.
  "timecard.removedReason": { en: ": “{reason}”", es: ": “{reason}”" },
  "timecard.restoring": { en: "Restoring…", es: "Restaurando…" },
  "timecard.restore": { en: "Restore", es: "Restaurar" },
  "timecard.sinceClockInLong": {
    en: "{duration} since clock-in — longer than a normal day",
    es: "{duration} desde la entrada — más que un día normal",
  },
  "timecard.noteLabel": { en: "Note: {note}", es: "Nota: {note}" },
  "timecard.reject": { en: "Reject", es: "Rechazar" },
  "timecard.edit": { en: "Edit", es: "Editar" },
  "timecard.reasonOptional": { en: "Reason (optional)", es: "Motivo (opcional)" },
  "timecard.sendBack": { en: "Send back", es: "Devolver" },
  "timecard.active": { en: "active", es: "activo" },
  "timecard.autoClosed": {
    en: "Auto-closed when the next shift started",
    es: "Se cerró automáticamente cuando empezó el siguiente turno",
  },
  "timecard.noJob": { en: "No job", es: "Sin trabajo" },
  "timecard.deleted": { en: "Deleted", es: "Eliminado" },
  "timecard.signOff.title": { en: "Sign your timecard", es: "Firma tu tarjeta de horas" },
  "timecard.signOff.help": {
    en: "{period} has ended. Signing says the hours in it are correct — it doesn't change anything, and a supervisor still countersigns it after you.",
    es: "{period} ya terminó. Firmar dice que las horas son correctas — no cambia nada, y un supervisor todavía la contrafirma después de ti.",
  },
  "timecard.signOff.signing": { en: "Signing…", es: "Firmando…" },
  "timecard.signOff.signButton": { en: "Sign my timecard", es: "Firmar mi tarjeta de horas" },
  "timecard.signOff.aSupervisor": { en: "a supervisor", es: "un supervisor" },
  "timecard.signOff.signedCountersigned": {
    en: "You signed {period} on {signedDay} · countersigned by {supervisor} {counterDay}.",
    es: "Firmaste {period} el {signedDay} · contrafirmado por {supervisor} el {counterDay}.",
  },
  "timecard.signOff.signedWaiting": {
    en: "You signed {period} on {signedDay} · waiting on a supervisor countersign.",
    es: "Firmaste {period} el {signedDay} · esperando la contrafirma de un supervisor.",
  },
  "timecard.signOff.signed": { en: "Signed {day}", es: "Firmado el {day}" },
  "timecard.signOff.countersignedBy": { en: "Countersigned by {supervisor}", es: "Contrafirmado por {supervisor}" },
  "timecard.signOff.countersigning": { en: "Countersigning…", es: "Contrafirmando…" },
  "timecard.signOff.countersign": { en: "Countersign", es: "Contrafirmar" },
  "timecard.signOff.waitingCountersign": {
    en: "Waiting on a supervisor countersign",
    es: "Esperando la contrafirma de un supervisor",
  },
  // ---- Travel list (installer-spanish-first-fourteen) ------------------
  // Travel.tsx and lib/travel/status.ts's phaseLabel (2 call sites only,
  // `t` threaded through with an English default like scanVerbs). The
  // TripEditor form (new/edit trip) stays English — supervisor-only editor,
  // same carve-out as the rest of travel's edit surfaces.
  "travel.title": { en: "Travel Info", es: "Información de viaje" },
  "travel.subtitleCrew": {
    en: "Trips for the crew — flights, lodging, and more.",
    es: "Viajes de la cuadrilla — vuelos, hospedaje y más.",
  },
  "travel.subtitleMine": {
    en: "Your trips — flights, lodging, and more.",
    es: "Tus viajes — vuelos, hospedaje y más.",
  },
  "travel.home": { en: "Home", es: "Inicio" },
  "travel.syncedJustNow": { en: "Synced just now", es: "Sincronizado hace un momento" },
  "travel.syncedMinAgo": { en: "Last synced {mins} min ago", es: "Última sincronización hace {mins} min" },
  "travel.syncedHrAgo": { en: "Last synced {hrs} hr ago", es: "Última sincronización hace {hrs} h" },
  "travel.offlineSuffix": { en: " · offline", es: " · sin conexión" },
  "travel.newTrip": { en: "New trip", es: "Nuevo viaje" },
  "travel.loadError": { en: "Couldn't load trips", es: "No se pudieron cargar los viajes" },
  "travel.emptyTitle": { en: "No trips yet", es: "Todavía no hay viajes" },
  "travel.emptyMessageSup": {
    en: "Tap “New trip” to plan crew travel.",
    es: "Toca “Nuevo viaje” para planear un viaje de la cuadrilla.",
  },
  "travel.emptyMessageMine": {
    en: "When you're assigned to a trip, it shows up here.",
    es: "Cuando te asignen a un viaje, aparecerá aquí.",
  },
  "travel.draft": { en: "Draft", es: "Borrador" },
  "travel.crewCount": { en: "{n} crew", es: "{n} en la cuadrilla" },
  "travel.phase.upcoming": { en: "Upcoming", es: "Próximo" },
  "travel.phase.inProgress": { en: "In progress", es: "En curso" },
  "travel.phase.past": { en: "Past", es: "Pasado" },
  // ---- Trip detail (installer-spanish-first-fourteen) ------------------
  // TripDetail.tsx itself. The six editor forms it can open (TripEditor,
  // FlightEditor, LodgingEditor, GroundEditor, ProcedureEditor,
  // ContactEditor) stay English — supervisor-only, same carve-out noted in
  // the PR body; canEdit gates every one of them off for an installer.
  "travelDetail.crewFallback": { en: "Crew", es: "Cuadrilla" },
  "travelDetail.loadError": { en: "Couldn't load this trip", es: "No se pudo cargar este viaje" },
  "travelDetail.notFoundTitle": { en: "Trip not found", es: "No se encontró el viaje" },
  "travelDetail.notFoundMessage": { en: "It may have been removed.", es: "Puede que lo hayan eliminado." },
  "travelDetail.backToTravel": { en: "Back to Travel", es: "Volver a Viajes" },
  "travelDetail.editTrip": { en: "Edit trip", es: "Editar viaje" },
  "travelDetail.publishing": { en: "Publishing…", es: "Publicando…" },
  "travelDetail.publishToCrew": { en: "Publish to crew", es: "Publicar a la cuadrilla" },
  "travelDetail.jobsite": { en: "Jobsite", es: "Obra" },
  "travelDetail.job": { en: "Job", es: "Trabajo" },
  "travelDetail.openJob": { en: "Open job", es: "Abrir trabajo" },
  "travelDetail.directions": { en: "Directions:", es: "Direcciones:" },
  "travelDetail.tab.timeline": { en: "Timeline", es: "Cronología" },
  "travelDetail.tab.flights": { en: "Flights", es: "Vuelos" },
  "travelDetail.tab.lodging": { en: "Lodging", es: "Hospedaje" },
  "travelDetail.tab.ground": { en: "Getting around", es: "Cómo moverte" },
  "travelDetail.tab.rules": { en: "House rules", es: "Reglas de la casa" },
  "travelDetail.tab.contacts": { en: "Contacts", es: "Contactos" },
  "travelDetail.tripFiles": { en: "Trip files", es: "Archivos del viaje" },
  // ---- Trip timeline + copy chip (installer-spanish-first-fourteen) ----
  // lib/travel/timeline.ts (buildTimeline + its item builders) and
  // lib/travel/dates.ts's humanizeCountdown — both pure, `t` threaded
  // through with an English default (scanVerbs pattern) so their existing
  // unit tests keep passing unchanged. Plus the viewing components:
  // NextUpBanner, TripTimeline, TimelineActionButton, CopyButton.
  "travelTimeline.flightFallback": { en: "Flight", es: "Vuelo" },
  "travelTimeline.groundFallback": { en: "Ground transport", es: "Transporte terrestre" },
  "travelTimeline.lodgingFallback": { en: "Lodging", es: "Hospedaje" },
  "travelTimeline.leaveForAirport": { en: "Leave for the airport", es: "Sal hacia el aeropuerto" },
  "travelTimeline.beAtAirport": { en: "Be at the airport", es: "Llega al aeropuerto" },
  "travelTimeline.forLabel": { en: "for {label}", es: "para {label}" },
  "travelTimeline.departs": { en: "Departs {place}", es: "Sale de {place}" },
  "travelTimeline.arrives": { en: "Arrives {place}", es: "Llega a {place}" },
  "travelTimeline.pickup": { en: "Pickup", es: "Recogida" },
  "travelTimeline.pickupAt": { en: "Pickup — {place}", es: "Recogida — {place}" },
  "travelTimeline.dropoff": { en: "Drop-off", es: "Entrega" },
  "travelTimeline.dropoffAt": { en: "Drop-off — {place}", es: "Entrega — {place}" },
  "travelTimeline.checkIn": { en: "Check in — {name}", es: "Registro — {name}" },
  "travelTimeline.checkOut": { en: "Check out — {name}", es: "Salida — {name}" },
  "travelTimeline.doorCodeReady": { en: "Door code ready to copy", es: "Código de la puerta listo para copiar" },
  "travelTimeline.doorCode": { en: "Door code", es: "Código de la puerta" },
  "travelTimeline.countdownNow": { en: "now", es: "ahora" },
  "travelTimeline.countdownMin": { en: "in {mins} min", es: "en {mins} min" },
  "travelTimeline.countdownHr": { en: "in {hrs} hr", es: "en {hrs} h" },
  "travelTimeline.countdownDay": { en: "in {days} day", es: "en {days} día" },
  "travelTimeline.countdownDays": { en: "in {days} days", es: "en {days} días" },
  "travelTimeline.directions": { en: "Directions", es: "Direcciones" },
  "travelTimeline.call": { en: "Call", es: "Llamar" },
  "travelTimeline.nextUp": { en: "Next up", es: "Lo siguiente" },
  "travelTimeline.noScheduledTimes": { en: "No scheduled times yet.", es: "Todavía no hay horarios programados." },
  "travelCopy.copiedToast": { en: "{label} copied", es: "{label} copiado" },
  "travelCopy.copied": { en: "Copied", es: "Copiado" },
  "travelCopy.couldNotCopy": { en: "Could not copy", es: "No se pudo copiar" },
  "travelCopy.copyAria": { en: "Copy {label}", es: "Copiar {label}" },
  "travelCopy.copy": { en: "Copy", es: "Copiar" },
  // ---- Trip viewing panels (installer-spanish-first-fourteen) ----------
  // FlightsSection, LodgingSection, GettingAroundSection, HouseRulesSection,
  // ContactsSection, AttachmentsPanel — the read side of each tab. Their
  // Add/Edit/Delete triggers are canEdit-gated (supervisor+ only, an
  // installer never sees them) but translated anyway so the file reads as
  // one language throughout; the editor FORMS they open stay English.
  "travelFlights.addFlight": { en: "Add flight", es: "Agregar vuelo" },
  "travelFlights.noFlights": { en: "No flights yet.", es: "Todavía no hay vuelos." },
  "travelFlights.wholeCrew": { en: "Whole crew", es: "Toda la cuadrilla" },
  "travelFlights.editFlight": { en: "Edit flight", es: "Editar vuelo" },
  "travelFlights.deleteFlight": { en: "Delete flight", es: "Eliminar vuelo" },
  "travelFlights.airport": { en: "Airport", es: "Aeropuerto" },
  "travelFlights.departs": { en: "Departs", es: "Sale" },
  "travelFlights.arrives": { en: "Arrives", es: "Llega" },
  "travelFlights.leaveBy": { en: "Leave by", es: "Sal antes de" },
  "travelFlights.airportBy": { en: "Airport by", es: "En el aeropuerto antes de" },
  "travelFlights.minBefore": { en: "{n} min before", es: "{n} min antes" },
  "travelFlights.seat": { en: "Seat", es: "Asiento" },
  "travelFlights.confirmation": { en: "Confirmation", es: "Confirmación" },
  "travelFlights.confirmationCode": { en: "Confirmation code", es: "Código de confirmación" },
  "travelLodging.addLodging": { en: "Add lodging", es: "Agregar hospedaje" },
  "travelLodging.noLodging": { en: "No lodging yet.", es: "Todavía no hay hospedaje." },
  "travelLodging.editLodging": { en: "Edit lodging", es: "Editar hospedaje" },
  "travelLodging.deleteLodging": { en: "Delete lodging", es: "Eliminar hospedaje" },
  // i18n-same-on-purpose: "Wi-Fi" is the same brand term in Spanish.
  "travelLodging.wifi": { en: "Wi-Fi", es: "Wi-Fi" },
  "travelLodging.wifiPassword": { en: "Wi-Fi password", es: "Contraseña de Wi-Fi" },
  "travelLodging.doorLockboxCode": { en: "Door / lockbox code", es: "Código de puerta / caja de seguridad" },
  "travelLodging.codesHidden": { en: "Codes are hidden for past trips.", es: "Los códigos se ocultan en viajes pasados." },
  "travelLodging.checkIn": { en: "Check-in", es: "Entrada" },
  "travelLodging.checkOut": { en: "Check-out", es: "Salida" },
  "travelLodging.nights": { en: "Nights", es: "Noches" },
  "travelLodging.layout": { en: "Layout", es: "Distribución" },
  "travelLodging.bd": { en: "{n} bd", es: "{n} rec" },
  "travelLodging.beds": { en: "{n} beds", es: "{n} camas" },
  "travelLodging.ba": { en: "{n} ba", es: "{n} baños" },
  "travelLodging.amenities": { en: "Amenities", es: "Comodidades" },
  "travelLodging.washerDryer": { en: "Washer/dryer", es: "Lavadora/secadora" },
  "travelLodging.kitchen": { en: "Kitchen", es: "Cocina" },
  "travelLodging.parking": { en: "Parking", es: "Estacionamiento" },
  "travelLodging.quietHours": { en: "Quiet hours", es: "Horario de silencio" },
  "travelLodging.host": { en: "Host", es: "Anfitrión" },
  "travelLodging.hostFallback": { en: "Host", es: "Anfitrión" },
  "travelLodging.gettingIn": { en: "Getting in", es: "Cómo entrar" },
  "travelLodging.backupEntry": { en: "Backup entry", es: "Entrada alterna" },
  "travelLodging.beforeCheckout": { en: "Before checkout", es: "Antes de la salida" },
  "travelGround.addTransport": { en: "Add transport", es: "Agregar transporte" },
  "travelGround.noTransport": { en: "No ground transport yet.", es: "Todavía no hay transporte terrestre." },
  "travelGround.transportFallback": { en: "Transport", es: "Transporte" },
  "travelGround.editTransport": { en: "Edit transport", es: "Editar transporte" },
  "travelGround.deleteTransport": { en: "Delete transport", es: "Eliminar transporte" },
  "travelRules.heading": { en: "House rules & living", es: "Reglas de la casa y convivencia" },
  "travelRules.addRule": { en: "Add rule", es: "Agregar regla" },
  "travelRules.noProcedures": { en: "No procedures yet.", es: "Todavía no hay procedimientos." },
  "travelRules.company": { en: "Company", es: "Empresa" },
  "travelRules.editRule": { en: "Edit rule", es: "Editar regla" },
  "travelRules.deleteRule": { en: "Delete rule", es: "Eliminar regla" },
  "travelContacts.addContact": { en: "Add contact", es: "Agregar contacto" },
  "travelContacts.noContacts": { en: "No contacts yet.", es: "Todavía no hay contactos." },
  "travelContacts.editContact": { en: "Edit contact", es: "Editar contacto" },
  "travelContacts.deleteContact": { en: "Delete contact", es: "Eliminar contacto" },
  "travelAttach.couldNotOpen": { en: "Couldn't open that file", es: "No se pudo abrir ese archivo" },
  "travelAttach.added": { en: "Attachment added", es: "Archivo adjunto agregado" },
  "travelAttach.uploadFailed": {
    en: "Upload failed — apply the migration first?",
    es: "Falló la subida — ¿aplicaste la migración primero?",
  },
  "travelAttach.attachment": { en: "Attachment", es: "Archivo adjunto" },
  "travelAttach.removeAttachment": { en: "Remove attachment", es: "Quitar archivo adjunto" },
  "travelAttach.uploading": { en: "Uploading…", es: "Subiendo…" },
  "travelAttach.addFile": { en: "Add file", es: "Agregar archivo" },
  // ---- Tools (installer-spanish-first-fourteen) -------------------------
  // Not currently routed anywhere in App.tsx (no <Route> imports it) — the
  // task named it explicitly, so it's translated like any other page, but
  // the installer floor test has nothing to check it against.
  "tools.title": { en: "Tools", es: "Herramientas" },
  "tools.subtitle": { en: "Who has what — and what's due for calibration.", es: "Quién tiene qué — y qué necesita calibración." },
  "tools.home": { en: "Home", es: "Inicio" },
  "tools.withPerson": { en: "With {name}", es: "Con {name}" },
  "tools.inShop": { en: "In the shop", es: "En el taller" },
  "tools.calibDue": { en: "· calib due {date}", es: "· calibración vence {date}" },
  "tools.shop": { en: "Shop", es: "Taller" },
  "tools.noneTracked": { en: "No tools tracked yet.", es: "Todavía no hay herramientas registradas." },
  "tools.addToolHeading": { en: "Add a tool", es: "Agregar una herramienta" },
  "tools.addTool": { en: "Add tool", es: "Agregar herramienta" },
  "tools.toolName": { en: "Tool name", es: "Nombre de la herramienta" },
  "tools.calibrationDue": { en: "Calibration due (optional)", es: "Vencimiento de calibración (opcional)" },
  // ---- Memo review (installer-spanish-first-fourteen) ------------------
  "memoReview.title": { en: "Review AI memos", es: "Revisar notas de IA" },
  "memoReview.subtitle": {
    en: "Confirm fields so the brain gets smarter.",
    es: "Confirma los campos para que el sistema aprenda más.",
  },
  "memoReview.myWork": { en: "My work", es: "Mi trabajo" },
  "memoReview.explain": {
    en: "The AI split your voice memos into fields. A quick confirm makes the brain smarter for the next installer.",
    es: "La IA dividió tus notas de voz en campos. Confirmarlos rápido ayuda al sistema a aprender para el siguiente instalador.",
  },
  "memoReview.aiFilled": {
    en: "{date} · AI-filled from your voice memo — fix anything, then confirm.",
    es: "{date} · Llenado por IA a partir de tu nota de voz — corrige lo que haga falta y confirma.",
  },
  "memoReview.saving": { en: "Saving…", es: "Guardando…" },
  "memoReview.confirmMemo": { en: "Confirm memo", es: "Confirmar nota" },
  "memoReview.allCaughtUp": { en: "Nothing to review — all caught up.", es: "Nada que revisar — todo al día." },
  "memoReview.topic.difficulty": { en: "Difficulty / how it felt", es: "Dificultad / cómo se sintió" },
  "memoReview.topic.wentWell": { en: "What went well", es: "Qué salió bien" },
  "memoReview.topic.wentPoorly": { en: "What didn't go well", es: "Qué no salió bien" },
  "memoReview.topic.obstacles": { en: "Obstacles", es: "Obstáculos" },
  "memoReview.topic.toolsHelped": { en: "Tools / materials that helped", es: "Herramientas / materiales que ayudaron" },
  "memoReview.topic.timeVsEstimate": { en: "Time estimate vs actual", es: "Tiempo estimado vs. real" },
  "memoReview.topic.safetyNotes": { en: "Safety notes", es: "Notas de seguridad" },
  "memoReview.topic.doAgain": { en: "What we'd do again next time", es: "Qué haríamos igual la próxima vez" },
  // ---- Suggestions / app feedback (installer-spanish-first-fourteen) ---
  "suggestions.title": { en: "Suggestions", es: "Sugerencias" },
  "suggestions.appIssues": { en: "App issues", es: "Problemas de la app" },
  "suggestions.heading": { en: "Make the app better", es: "Mejora la app" },
  "suggestions.home": { en: "Home", es: "Inicio" },
  "suggestions.explain": {
    en: "Something broken? Something the app should do? Say it here — every report goes straight to the owners.",
    es: "¿Algo está roto? ¿Algo que la app debería hacer? Dilo aquí — cada reporte va directo a los dueños.",
  },
  "suggestions.somethingBroken": { en: "Something's broken", es: "Algo está roto" },
  "suggestions.anIdea": { en: "An idea", es: "Una idea" },
  "suggestions.bugPlaceholder": {
    en: "What happened, and what were you doing when it happened?",
    es: "¿Qué pasó, y qué estabas haciendo cuando pasó?",
  },
  "suggestions.ideaPlaceholder": { en: "What should the app do?", es: "¿Qué debería hacer la app?" },
  "suggestions.yourReport": { en: "Your report", es: "Tu reporte" },
  "suggestions.sending": { en: "Sending…", es: "Enviando…" },
  "suggestions.sendToOwners": { en: "Send to the owners", es: "Enviar a los dueños" },
  "suggestions.sent": { en: "Sent — it's on the owners' list.", es: "Enviado — está en la lista de los dueños." },
  "suggestions.appIssuesCount": { en: "App issues ({n})", es: "Problemas de la app ({n})" },
  "suggestions.yourReports": { en: "Your reports", es: "Tus reportes" },
  "suggestions.hideResolved": { en: "Hide resolved", es: "Ocultar resueltos" },
  "suggestions.showResolved": { en: "Show resolved", es: "Mostrar resueltos" },
  "suggestions.broken": { en: "Broken", es: "Roto" },
  // i18n-same-on-purpose: "idea" is spelled the same in Spanish.
  "suggestions.idea": { en: "Idea", es: "Idea" },
  "suggestions.someone": { en: "someone", es: "alguien" },
  "suggestions.resolved": { en: "resolved", es: "resuelto" },
  "suggestions.resolve": { en: "Resolve", es: "Resolver" },
  "suggestions.nothingOpen": { en: "Nothing open. The app is perfect — for now.", es: "Nada pendiente. La app es perfecta — por ahora." },
  "suggestions.nothingYet": { en: "Nothing yet.", es: "Todavía nada." },
  // ---- Settings (installer-spanish-first-fourteen) ---------------------
  // Settings.tsx's own sections (language.*/diagnostics.* already existed).
  // PermissionsSettings.tsx and its pure settingsView() (lib/permissions/
  // permissionCore.ts, `t` threaded through, English default so existing
  // tests keep passing). BuildIdentityCard.tsx's own strings are translated;
  // buildIdentity.ts's verdict text stays English (developer diagnostic
  // copy, shared with Diagnostics.tsx — out of this sweep's scope).
  "settings.pageTitle": { en: "Settings", es: "Ajustes" },
  "settings.back": { en: "Back", es: "Atrás" },
  "settings.appearance.heading": { en: "Appearance", es: "Apariencia" },
  "settings.appearance.help": {
    en: "Light reads best in the sun; dark is easy on the eyes indoors. System follows your phone.",
    es: "El modo claro se lee mejor bajo el sol; el oscuro descansa la vista adentro. Sistema sigue el ajuste del teléfono.",
  },
  "settings.appearance.system": { en: "System", es: "Sistema" },
  "settings.appearance.light": { en: "Light", es: "Claro" },
  "settings.appearance.dark": { en: "Dark", es: "Oscuro" },
  "settings.sounds.heading": { en: "Warehouse sounds", es: "Sonidos del almacén" },
  "settings.sounds.help": {
    en: "A soft tick on a scan or check-in that goes through, a buzz on one that doesn't. Off by default.",
    es: "Un clic suave cuando un escaneo o registro funciona, un zumbido cuando no. Apagado por defecto.",
  },
  "settings.sounds.on": { en: "On", es: "Encendido" },
  "settings.sounds.off": { en: "Off", es: "Apagado" },
  "permSettings.ariaLabel": { en: "Notifications and location", es: "Notificaciones y ubicación" },
  "permSettings.heading": { en: "Notifications & location", es: "Notificaciones y ubicación" },
  "permSettings.subheading": {
    en: "Control the alerts and location access this app can use.",
    es: "Controla las alertas y el acceso a ubicación que esta app puede usar.",
  },
  "permSettings.setupGuide": { en: "Setup guide", es: "Guía de configuración" },
  "permSettings.iosHomeScreenHint": {
    en: "Add Forge Windows to your home screen to get alerts when the app is closed.",
    es: "Agrega Forge Windows a tu pantalla de inicio para recibir alertas cuando la app esté cerrada.",
  },
  "permSettings.turnOffAria": { en: "Turn off {name} on this device", es: "Apagar {name} en este dispositivo" },
  "permSettings.turnOffDevice": { en: "Turn off on this device", es: "Apagar en este dispositivo" },
  "permSettings.turnOn": { en: "Turn on", es: "Activar" },
  "permSettings.kind.notifications": { en: "Notifications", es: "Notificaciones" },
  "permSettings.kind.location": { en: "Location", es: "Ubicación" },
  "permSettings.kindLower.notifications": { en: "notifications", es: "notificaciones" },
  "permSettings.kindLower.location": { en: "location", es: "ubicación" },
  "permSettings.on": { en: "On", es: "Activado" },
  "permSettings.off": { en: "Off", es: "Desactivado" },
  "permSettings.blocked": { en: "Blocked", es: "Bloqueado" },
  "permSettings.notSupported": { en: "Not supported", es: "No compatible" },
  "permSettings.unavailable": { en: "Unavailable", es: "No disponible" },
  "permSettings.hint.grantedNotifications": {
    en: "You'll get alerts for the things that need you.",
    es: "Recibirás alertas de las cosas que necesitan de ti.",
  },
  "permSettings.hint.grantedLocation": {
    en: "Clock-ins and on-site reminders can use your location.",
    es: "Los registros de entrada y recordatorios en obra pueden usar tu ubicación.",
  },
  "permSettings.hint.denied": {
    en: "{noun} are blocked for this site. To turn them back on, open your browser's site settings for this page and allow {nounLower}, then reload.",
    es: "{noun} están bloqueadas para este sitio. Para reactivarlas, abre la configuración del sitio en tu navegador para esta página y permite {nounLower}, luego recarga.",
  },
  "permSettings.hint.offNotifications": {
    en: "Turn on to get alerted for schedule changes, timecard approvals, and today's toolbox talk.",
    es: "Actívalas para recibir alertas de cambios de horario, aprobaciones de tarjeta de horas y la charla de seguridad de hoy.",
  },
  "permSettings.hint.offLocation": {
    en: "Turn on for accurate clock-in/out stamps and on-site reminders.",
    es: "Actívala para marcas de entrada/salida precisas y recordatorios en obra.",
  },
  "permSettings.hint.unsupported": {
    en: "This device or browser doesn't support {nounLower}.",
    es: "Este dispositivo o navegador no admite {nounLower}.",
  },
  "permSettings.hint.insecure": {
    en: "{noun} need a secure (https) connection. They'll be available once the app is served over https.",
    es: "{noun} necesita una conexión segura (https). Estará disponible una vez que la app se sirva por https.",
  },
  "buildId.ariaLabel": { en: "Which app am I on", es: "En qué app estoy" },
  "buildId.heading": { en: "Which app am I on?", es: "¿En qué app estoy?" },
  "buildId.explain": {
    en: "Compare this line with someone else. If they match, you are both looking at the same app and the same data.",
    es: "Compara esta línea con la de alguien más. Si coinciden, ambos están viendo la misma app y los mismos datos.",
  },
  "buildId.copyLine": { en: "Copy this line", es: "Copiar esta línea" },
  "buildId.copied": { en: "Copied", es: "Copiado" },
  "buildId.copy": { en: "Copy", es: "Copiar" },
  "buildId.code": { en: "Code", es: "Código" },
  "buildId.database": { en: "Database", es: "Base de datos" },
  "buildId.unknown": { en: "unknown", es: "desconocido" },
  "buildId.none": { en: "none", es: "ninguna" },
  "buildId.uncommittedChanges": { en: "with uncommitted changes", es: "con cambios sin confirmar" },
  "buildId.built": { en: "built {time}", es: "compilado {time}" },
  "buildId.sharedOneIs": { en: "shared one is {ref}", es: "la compartida es {ref}" },
  // ---- Stuck writes (installer-spanish-first-fourteen) -----------------
  // StuckWrites.test.tsx mounts the real page with no LanguageProvider and
  // asserts exact English text — every en value below is copied verbatim
  // from what the page said before this sweep, so that test needs no changes.
  "stuck.op.clockIn": { en: "Clock in", es: "Marcar entrada" },
  "stuck.op.clockOut": { en: "Clock out", es: "Marcar salida" },
  "stuck.op.breakStart": { en: "Break started", es: "Descanso iniciado" },
  "stuck.op.breakStop": { en: "Break ended", es: "Descanso terminado" },
  "stuck.op.dailyLog": { en: "Daily log", es: "Registro diario" },
  "stuck.op.photoUpload": { en: "Photo", es: "Foto" },
  "stuck.op.receiptUpload": { en: "Receipt", es: "Recibo" },
  "stuck.op.pinChange": { en: "Plan pin change", es: "Cambio de pin en el plano" },
  "stuck.op.storePackages": { en: "Packages checked in", es: "Paquetes registrados" },
  "stuck.op.checkoutPackages": { en: "Packages checked out", es: "Paquetes sacados" },
  "stuck.op.takeSupply": { en: "Supplies taken", es: "Suministros tomados" },
  "stuck.op.bindPackage": { en: "Package tagged", es: "Paquete etiquetado" },
  "stuck.op.stagePackages": { en: "Packages set aside", es: "Paquetes apartados" },
  "stuck.op.moveContainer": { en: "Container moved", es: "Contenedor movido" },
  "stuck.op.setPackageArea": { en: "Package pointed at", es: "Paquete señalado" },
  "stuck.op.setPackageNote": { en: "Package note", es: "Nota de paquete" },
  "stuck.op.receiveMinted": { en: "Delivery confirmed", es: "Entrega confirmada" },
  "stuck.op.pickupTakeoff": { en: "Takeoff picked up", es: "Conteo recogido" },
  "stuck.op.issuePhotoUpload": { en: "Damage photo", es: "Foto de daño" },
  "stuck.op.receiptCapture": { en: "Receipt", es: "Recibo" },
  "stuck.op.receiptAnswer": { en: "Receipt details", es: "Detalles del recibo" },
  "stuck.op.receiptDocumentUpload": { en: "Receipt PDF", es: "PDF del recibo" },
  "stuck.op.videoQuizSubmit": { en: "Quiz result", es: "Resultado del cuestionario" },
  "stuck.windowFinished": { en: "Window {code} finished", es: "Ventana {code} terminada" },
  "stuck.windowFinishedNoCode": { en: "Window finished", es: "Ventana terminada" },
  "stuck.offlineWrites": { en: "Offline writes", es: "Escrituras sin conexión" },
  "stuck.title": { en: "Stuck writes", es: "Escrituras atascadas" },
  "stuck.back": { en: "Back", es: "Atrás" },
  "stuck.explain1": {
    en: "These are saves that never made it to the server — a clock punch, a photo, a plan change. Nothing here was thrown away on its own; each one is waiting for you to try it again or throw it away yourself.",
    es: "Estos son guardados que nunca llegaron al servidor — un marcaje de reloj, una foto, un cambio de plano. Nada aquí se eliminó por su cuenta; cada uno espera que tú lo intentes de nuevo o lo elimines.",
  },
  "stuck.explain2": {
    en: "Try again sends a write exactly as it was written, with the details from the moment it was made. Check how long one has been waiting before you send it — an old write may not match what is there now.",
    es: "Intentar de nuevo envía el guardado exactamente como se escribió, con los datos del momento en que se hizo. Revisa cuánto tiempo lleva esperando antes de enviarlo — uno viejo puede no coincidir con lo que hay ahora.",
  },
  "stuck.checking": { en: "Checking for stuck writes…", es: "Buscando escrituras atascadas…" },
  "stuck.checkError": {
    en: "Couldn't check for stuck writes. Try again shortly.",
    es: "No se pudo buscar escrituras atascadas. Intenta de nuevo en un momento.",
  },
  "stuck.retryError": {
    en: "Couldn't try that write again. Try again shortly.",
    es: "No se pudo reintentar ese guardado. Intenta de nuevo en un momento.",
  },
  "stuck.discardError": {
    en: "Couldn't throw that away. Try again shortly.",
    es: "No se pudo eliminar eso. Intenta de nuevo en un momento.",
  },
  "stuck.nothingStuck": { en: "Nothing stuck. Every save has made it to the server.", es: "Nada atascado. Todos los guardados llegaron al servidor." },
  "stuck.tryingAgain": { en: "Trying again…", es: "Intentando de nuevo…" },
  "stuck.tryAgain": { en: "Try again", es: "Intentar de nuevo" },
  "stuck.throwingAway": { en: "Throwing away…", es: "Eliminando…" },
  "stuck.sureDeletes": { en: "Sure? this deletes it", es: "¿Seguro? esto lo elimina" },
  "stuck.throwAway": { en: "Throw away", es: "Eliminar" },
  "stuck.queuedNoTime": { en: "Queued — no time recorded", es: "En espera — sin hora registrada" },
  "stuck.queuedJustNow": { en: "Queued just now", es: "En espera desde hace un momento" },
  "stuck.queuedMinAgo": { en: "Queued {min} min ago", es: "En espera desde hace {min} min" },
  "stuck.queuedHrAgo": { en: "Queued {hr} hr ago", es: "En espera desde hace {hr} h" },
  "stuck.queuedDayAgo": { en: "Queued 1 day ago", es: "En espera desde hace 1 día" },
  "stuck.queuedDaysAgo": { en: "Queued {days} days ago", es: "En espera desde hace {days} días" },
  // Added post-merge with #583 (job facts / S4), which introduced this
  // OutboxOp — OP_LABEL_KEY's exhaustive Record<OutboxOp, TKey> would not
  // compile without an entry for it.
  "stuck.op.saveBuildFacts": { en: "Job fact", es: "Dato del trabajo" },
  // ---- Supplies data helpers (installer-spanish-first-fourteen) --------
  // lib/ops.ts's onHandLabel/supplyHomeLabel are shared with Warehouse.tsx
  // (out of scope, on the allow-list) — `t` defaults to English so its
  // calls there are unaffected; Supplies.tsx passes the live language.
  // ops.test.ts asserts the exact English strings below.
  "ops.notCountedYet": { en: "not counted yet", es: "todavía sin contar" },
  "ops.onHand": { en: "about {n} on hand · last counted {when}", es: "unos {n} disponibles · último conteo {when}" },
  "ops.aContainer": { en: "a container", es: "un contenedor" },
  "ops.noHomeSpotYet": { en: "no home spot yet", es: "sin lugar asignado todavía" },
  // ---- Supplies (installer-spanish-first-fourteen) ---------------------
  // Also where audit item I lands for this page: the shelf list now sorts
  // running-low-first (lowStockFirst, lib/ops.ts) instead of alphabetically —
  // reusing Warehouse.tsx's existing definition, no new threshold invented.
  "supplies.title": { en: "Supplies", es: "Suministros" },
  "supplies.subtitle": { en: "Find it, take it, log it — three taps.", es: "Encuéntralo, tómalo, regístralo — tres toques." },
  "supplies.warehouse": { en: "Warehouse", es: "Almacén" },
  "supplies.howItWorks": {
    en: "Every supply has one home spot, so you always know where to go. Tap Take, say how many and which job — that's the whole log. The count is an estimate, not a promise: it drops when people take, and counting the shelf is what sets it right. Foremen can still request material for a job ahead of time under Request, and a take that matches a request ticks it off on its own.",
    es: "Cada suministro tiene un lugar fijo, así siempre sabes a dónde ir. Toca Tomar, di cuántos y para qué trabajo — eso es todo el registro. El conteo es un estimado, no una promesa: baja cuando la gente toma, y contar el estante es lo que lo corrige. Los capataces todavía pueden solicitar material para un trabajo por adelantado en Solicitar, y una toma que coincide con una solicitud la marca sola.",
  },
  "supplies.onTheShelf": { en: "On the shelf", es: "En el estante" },
  "supplies.searchPlaceholder": { en: "Search supplies — caulk, screws…", es: "Buscar suministros — sellador, tornillos…" },
  "supplies.searchAria": { en: "Search supplies", es: "Buscar suministros" },
  "supplies.take": { en: "Take", es: "Tomar" },
  "supplies.count": { en: "Count", es: "Contar" },
  "supplies.home": { en: "Home", es: "Lugar" },
  "supplies.history": { en: "History", es: "Historial" },
  "supplies.nothingNamedLike": { en: "Nothing named like “{q}”.", es: "Nada con un nombre parecido a “{q}”." },
  "supplies.catalogEmpty": { en: "Nothing in the catalog yet — add supplies below.", es: "Todavía no hay nada en el catálogo — agrega suministros abajo." },
  "supplies.requestForJob": { en: "Request for a job (ahead of time)", es: "Solicitar para un trabajo (por adelantado)" },
  "supplies.addToRequestList": { en: "Add to the request list", es: "Agregar a la lista de solicitudes" },
  "supplies.supplyPlaceholder": { en: "— supply —", es: "— suministro —" },
  "supplies.qty": { en: "Qty", es: "Cant." },
  "supplies.addToJob": { en: "Add to job", es: "Agregar al trabajo" },
  "supplies.requested": { en: "Requested", es: "Solicitado" },
  "supplies.nothingRequested": { en: "Nothing requested yet.", es: "Todavía no hay nada solicitado." },
  "supplies.status.needed": { en: "needed", es: "necesario" },
  "supplies.status.ordered": { en: "ordered", es: "pedido" },
  "supplies.status.picked": { en: "picked", es: "recogido" },
  "supplies.status.used": { en: "used", es: "usado" },
  "supplies.addToCatalog": { en: "Add to catalog", es: "Agregar al catálogo" },
  "supplies.newSupplyType": { en: "New supply type", es: "Nuevo tipo de suministro" },
  "supplies.unit": { en: "Unit", es: "Unidad" },
  "supplies.otherEllipsis": { en: "other…", es: "otro…" },
  "supplies.otherUnit": { en: "Other unit", es: "Otra unidad" },
  "supplies.otherUnitPlaceholder": { en: "spool, sheet, box…", es: "carrete, lámina, caja…" },
  "supplies.add": { en: "Add", es: "Agregar" },
  "supplies.unitHelp": {
    en: "How it is counted on the shelf — a roll of tape, a tube of sealant. Pick",
    es: "Cómo se cuenta en el estante — un rollo de cinta, un tubo de sellador. Elige",
  },
  "supplies.unitHelpEnd": { en: "to type your own.", es: "para escribir la tuya." },
  "supplies.took": { en: "Took {n} {name}.", es: "Se tomaron {n} {name}." },
  "supplies.takeName": { en: "Take {name}", es: "Tomar {name}" },
  "supplies.howMany": { en: "How many ({unit})", es: "Cuántos ({unit})" },
  "supplies.forWhichJob": { en: "For which job", es: "Para qué trabajo" },
  "supplies.pickTheJob": { en: "Pick the job…", es: "Elige el trabajo…" },
  "supplies.logging": { en: "Logging…", es: "Registrando…" },
  "supplies.takeIt": { en: "Take it", es: "Tomarlo" },
  "supplies.cancel": { en: "Cancel", es: "Cancelar" },
  "supplies.countedToast": { en: "{name}: counted {n}.", es: "{name}: contado {n}." },
  "supplies.countName": { en: "Count {name}", es: "Contar {name}" },
  "supplies.countHelp": {
    en: "What's physically on the shelf right now. This replaces the estimate — it doesn't add to it.",
    es: "Lo que hay físicamente en el estante ahora mismo. Esto reemplaza el estimado — no se le suma.",
  },
  "supplies.counted": { en: "Counted ({unit})", es: "Contado ({unit})" },
  "supplies.savingEllipsis": { en: "Saving…", es: "Guardando…" },
  "supplies.saveCount": { en: "Save count", es: "Guardar conteo" },
  "supplies.livesAtNewSpot": { en: "{name} lives at its new spot.", es: "{name} ahora vive en su nuevo lugar." },
  "supplies.whereDoesLive": { en: "Where does {name} live?", es: "¿Dónde vive {name}?" },
  "supplies.whichBox": { en: "Which box", es: "Cuál caja" },
  "supplies.nowhereYet": { en: "— nowhere yet —", es: "— sin lugar todavía —" },
  "supplies.whereInIt": { en: "Where in it (optional)", es: "Dónde exactamente (opcional)" },
  "supplies.whereInItPlaceholder": { en: "e.g. north wall, blue bins", es: "ej. pared norte, contenedores azules" },
  "supplies.save": { en: "Save", es: "Guardar" },
  "supplies.noJobOnFile": { en: "no job on file", es: "sin trabajo registrado" },
  "supplies.takeLine": { en: "{actor} took {qty} · {job} · {when}", es: "{actor} tomó {qty} · {job} · {when}" },
  "supplies.whoTookIt": { en: "{name}: who took it", es: "{name}: quién lo tomó" },
  "supplies.nothingTakenYet": { en: "Nothing taken yet.", es: "Todavía nadie ha tomado nada." },
  "supplies.close": { en: "Close", es: "Cerrar" },
  // ---- Takeoffs (installer-spanish-first-fourteen) ---------------------
  // lib/takeoffs.ts's label/line helpers only ever render on this page
  // (Warehouse.tsx imports listTakeoffs only, no strings) — `t` threaded
  // through with an English default so takeoffs.test.ts needs no changes.
  "takeoffs.eta.thirtyMin": { en: "about 30 minutes", es: "unos 30 minutos" },
  "takeoffs.eta.today": { en: "later today", es: "más tarde hoy" },
  "takeoffs.eta.tomorrow": { en: "tomorrow", es: "mañana" },
  "takeoffs.eta.thisWeek": { en: "this week", es: "esta semana" },
  "takeoffs.status.requested": { en: "Requested", es: "Solicitado" },
  "takeoffs.status.acknowledged": { en: "In the works", es: "En proceso" },
  "takeoffs.status.ready": { en: "Ready for pickup", es: "Listo para recoger" },
  "takeoffs.status.pickedUp": { en: "Picked up", es: "Recogido" },
  "takeoffs.line.requested": { en: "Requested — waiting on the warehouse", es: "Solicitado — esperando al almacén" },
  "takeoffs.line.acknowledged": { en: "In the works", es: "En proceso" },
  "takeoffs.line.acknowledgedEta": { en: "In the works — {eta}{note}", es: "En proceso — {eta}{note}" },
  // i18n-same-on-purpose: punctuation around an interpolated value, no words of its own.
  "takeoffs.line.etaNote": { en: " ({note})", es: " ({note})" },
  "takeoffs.line.ready": { en: "Ready for pickup", es: "Listo para recoger" },
  "takeoffs.line.pickedUp": { en: "Picked up — supplies are on the job's tab", es: "Recogido — los suministros están en la cuenta del trabajo" },
  "takeoffs.shortage.neverCounted": {
    en: "{name} — never counted, so nobody knows if {qty} is there",
    es: "{name} — nunca se ha contado, así que nadie sabe si hay {qty}",
  },
  "takeoffs.shortage.wantsHas": {
    en: "{name} — wants {qty}, about {onHand} on hand",
    es: "{name} — se necesitan {qty}, hay unos {onHand} disponibles",
  },
  "takeoffs.warehouse": { en: "Warehouse", es: "Almacén" },
  "takeoffs.title": { en: "Takeoffs", es: "Conteos" },
  "takeoffs.explain": {
    en: "A takeoff is a job's supplies, bundled by the warehouse for a named person. Anyone on the crew can ask for one; whoever is filling it answers with a rough when, marks it ready, and picking it up logs every line against the job — pickup is the take.",
    es: "Un conteo son los suministros de un trabajo, reunidos por el almacén para una persona específica. Cualquiera de la cuadrilla puede pedir uno; quien lo prepara responde con un cuándo aproximado, lo marca listo, y recogerlo registra cada línea contra el trabajo — recogerlo es la toma.",
  },
  "takeoffs.newTakeoff": { en: "New takeoff", es: "Nuevo conteo" },
  "takeoffs.nothingWaiting": { en: "Nothing waiting. New takeoffs land here.", es: "Nada en espera. Los conteos nuevos aparecen aquí." },
  "takeoffs.pickedUpHeading": { en: "Picked up", es: "Recogidos" },
  "takeoffs.answered": { en: "Answered.", es: "Respondido." },
  "takeoffs.push.answeredTitle": { en: "Takeoff for {job}: {eta}", es: "Conteo para {job}: {eta}" },
  "takeoffs.push.answeredBody": { en: "The warehouse has your list.", es: "El almacén tiene tu lista." },
  "takeoffs.yourJob": { en: "your job", es: "tu trabajo" },
  "takeoffs.markedReady": { en: "Marked ready — they know.", es: "Marcado como listo — ya lo saben." },
  "takeoffs.push.readyTitle": { en: "Your takeoff for {job} is ready", es: "Tu conteo para {job} está listo" },
  "takeoffs.push.readyBody": { en: "Pick it up at the warehouse.", es: "Recógelo en el almacén." },
  "takeoffs.pickedUpToast": {
    en: "Picked up — the supplies are on the job's tab now.",
    es: "Recogido — los suministros ya están en la cuenta del trabajo.",
  },
  "takeoffs.push.pickedUpTitle": { en: "Takeoff for {job} picked up", es: "Se recogió el conteo para {job}" },
  "takeoffs.aJob": { en: "a job", es: "un trabajo" },
  "takeoffs.push.requestTitle": { en: "Supply request — {job}", es: "Solicitud de suministros — {job}" },
  "takeoffs.push.requestBody": { en: "Somebody needs a takeoff built.", es: "Alguien necesita que se arme un conteo." },
  "takeoffs.jobFor": { en: "{job} · for {name}", es: "{job} · para {name}" },
  "takeoffs.lineCount.one": { en: "1 line", es: "1 línea" },
  "takeoffs.lineCount.many": { en: "{count} lines", es: "{count} líneas" },
  "takeoffs.roughlyWhen": { en: "Roughly when?", es: "¿Aproximadamente cuándo?" },
  "takeoffs.etaNotePlaceholder": {
    en: "note (optional) — e.g. waiting on the caulk order",
    es: "nota (opcional) — ej. esperando el pedido de sellador",
  },
  "takeoffs.gotItSendWhen": { en: "Got it — send the when", es: "Entendido — enviar el cuándo" },
  "takeoffs.readyNow": { en: "It's ready now", es: "Ya está listo" },
  "takeoffs.markReadyTellThem": { en: "Mark ready — tell them", es: "Marcar listo — avisarles" },
  "takeoffs.pickedUpPutOnTab": { en: "Picked up — put it on the job's tab", es: "Recogido — agregarlo a la cuenta del trabajo" },
  "takeoffs.readyTheyKnow": { en: "Takeoff ready — they know.", es: "Conteo listo — ya lo saben." },
  "takeoffs.requestSent": { en: "Request sent to the warehouse.", es: "Solicitud enviada al almacén." },
  "takeoffs.job": { en: "Job", es: "Trabajo" },
  "takeoffs.pickTheJob": { en: "Pick the job…", es: "Elige el trabajo…" },
  "takeoffs.for": { en: "For", es: "Para" },
  "takeoffs.myself": { en: "Myself", es: "Yo mismo" },
  "takeoffs.lines": { en: "Lines", es: "Líneas" },
  "takeoffs.pickASupply": { en: "Pick a supply…", es: "Elige un suministro…" },
  "takeoffs.howMany": { en: "How many", es: "Cuántos" },
  "takeoffs.add": { en: "Add", es: "Agregar" },
  "takeoffs.remove": { en: "remove", es: "quitar" },
  "takeoffs.warningNotStop": {
    en: "A warning, not a stop — short lines get filled when stock lands.",
    es: "Es una advertencia, no un alto — las líneas cortas se completan cuando llega el suministro.",
  },
  "takeoffs.noteOptional": { en: "Note (optional)", es: "Nota (opcional)" },
  "takeoffs.requestIt": { en: "Request it", es: "Solicitarlo" },
  "takeoffs.itsBuiltMarkReady": { en: "It's built — mark ready", es: "Ya está armado — marcar listo" },
  "takeoffs.cancel": { en: "Cancel", es: "Cancelar" },

  // ---- S4 — Job facts and the green-light checklist (2026-09-06) ----------
  // The card lives on a job's Overview tab (foreman+) and reads through
  // app/src/lib/install/buildFacts.ts. See docs/adr/0011.
  "buildFacts.title": { en: "Job facts", es: "Datos del trabajo" },
  "buildFacts.intro": {
    en: "Record these once and the whole crew stops having to ask.",
    es: "Anota esto una vez y el resto del equipo deja de tener que preguntar.",
  },
  "buildFacts.saved": { en: "Job facts saved.", es: "Datos del trabajo guardados." },
  "buildFacts.saveError": {
    en: "That field didn't save. It's queued and will try again with signal.",
    es: "Ese campo no se guardó. Está en espera y se reintentará con señal.",
  },
  "buildFacts.empty": {
    en: "No job facts yet. Tap a field below to add one.",
    es: "Todavía no hay datos del trabajo. Toca un campo abajo para agregar uno.",
  },

  "buildFacts.field.exteriorFinish": { en: "Exterior finish", es: "Acabado exterior" },
  "buildFacts.field.exteriorNote": { en: "Exterior note", es: "Nota del exterior" },
  // The exterior situations (owner, 2026-09-07): a house is brick on the
  // front and stucco on the sides, so the finish + set depth is a LIST, one
  // line per situation, saved whole through app/src/lib/install/buildFacts.ts.
  "buildFacts.lines.title": { en: "Exterior situations", es: "Situaciones del exterior" },
  "buildFacts.lines.intro": {
    en: "One line for each finish on the house — brick outset an inch, stucco inset an inch and a quarter.",
    es: "Una línea por cada acabado de la casa — ladrillo sobrepuesto una pulgada, estuco empotrado una pulgada y cuarto.",
  },
  "buildFacts.lines.empty": {
    en: "No situations recorded yet.",
    es: "Todavía no hay situaciones anotadas.",
  },
  "buildFacts.lines.add": { en: "Add a situation", es: "Agregar una situación" },
  "buildFacts.lines.remove": { en: "Remove", es: "Quitar" },
  "buildFacts.lines.removeLabel": { en: "Remove situation {n}", es: "Quitar la situación {n}" },
  // Shown beside a pick-list the moment "Other" is chosen, so the foreman can
  // name the real thing instead of leaving "Other" on every unit sheet.
  "buildFacts.field.otherWhich": { en: "Which one?", es: "¿Cuál?" },
  "buildFacts.field.elevationNotes": { en: "Elevation notes", es: "Notas de las fachadas" },
  "buildFacts.exteriorFinish.stucco": { en: "Stucco", es: "Estuco" },
  "buildFacts.exteriorFinish.rock": { en: "Rock", es: "Piedra" },
  "buildFacts.exteriorFinish.siding": { en: "Siding", es: "Revestimiento" },
  "buildFacts.exteriorFinish.brick": { en: "Brick", es: "Ladrillo" },
  "buildFacts.exteriorFinish.other": { en: "Other", es: "Otro" },

  "buildFacts.field.setDepth": { en: "Set depth", es: "Profundidad de colocación" },
  "buildFacts.field.setDepthInches": { en: "Set depth (inches)", es: "Profundidad (pulgadas)" },
  "buildFacts.setDepth.inset": { en: "Inset", es: "Empotrado (inset)" },
  "buildFacts.setDepth.outset": { en: "Outset", es: "Sobrepuesto (outset)" },
  "buildFacts.setDepth.unknown": { en: "Unknown", es: "No se sabe" },

  "buildFacts.field.flashingSystem": { en: "Flashing system", es: "Sistema de tapajuntas" },
  "buildFacts.field.flashingNote": { en: "Flashing note", es: "Nota de tapajuntas" },
  "buildFacts.flashingSystem.butylTape": { en: "Butyl tape", es: "Cinta de butilo" },
  "buildFacts.flashingSystem.paperFlashing": { en: "Paper flashing", es: "Papel de tapajuntas" },
  "buildFacts.flashingSystem.fluidApplied": { en: "Fluid-applied", es: "Aplicado en líquido" },
  "buildFacts.flashingSystem.other": { en: "Other", es: "Otro" },

  "buildFacts.field.fastenerType": { en: "Fastener", es: "Sujetador" },
  "buildFacts.field.fastenerLength": { en: "Fastener length (in)", es: "Largo del sujetador (pulg)" },
  "buildFacts.field.fastenerSpacing": { en: "Fastener spacing (in)", es: "Espaciado del sujetador (pulg)" },
  "buildFacts.field.fastenerNote": { en: "Fastener note", es: "Nota de sujetadores" },
  "buildFacts.fastenerType.flangeScrew": { en: "Flange screw", es: "Tornillo de aleta" },
  "buildFacts.fastenerType.jambScrew": { en: "Jamb screw", es: "Tornillo de jamba" },
  "buildFacts.fastenerType.concreteScrew": { en: "Concrete screw", es: "Tornillo para concreto" },
  "buildFacts.fastenerType.other": { en: "Other", es: "Otro" },

  "buildFacts.field.siteRules": { en: "Site rules", es: "Reglas del sitio" },
  "buildFacts.field.gcContactName": { en: "GC contact", es: "Contacto del GC" },
  "buildFacts.field.gcContactPhone": { en: "GC phone", es: "Teléfono del GC" },

  // The green-light checklist (supervisor+, above the fields). Item labels
  // themselves come back from the server (green_light_items.label_en) since
  // the six sources live in SQL — only the chrome around the list is here.
  "buildFacts.checklist.title": { en: "Green light checklist", es: "Lista de luz verde" },
  "buildFacts.checklist.intro": {
    en: "Warns, never blocks — the job runs either way.",
    es: "Advierte, nunca bloquea — el trabajo sigue de todas formas.",
  },
  "buildFacts.checklist.who": { en: "Who answers: {who}", es: "Quién responde: {who}" },
  "buildFacts.checklist.answered": { en: "Answered", es: "Contestado" },
  "buildFacts.checklist.open": { en: "Open", es: "Pendiente" },
  "buildFacts.who.foreman": { en: "foreman", es: "capataz" },
  // i18n-same-on-purpose: "supervisor" is the same word in Spanish.
  "buildFacts.who.supervisor": { en: "supervisor", es: "supervisor" },

  // The supervisor's "Awaiting you" row on Home and Heartbeat (S4).
  "home.awaitingYou.greenLight": {
    en: "{job} · {count} green-light items open",
    es: "{job} · {count} elementos de luz verde pendientes",
  },

  // ---- Tomorrow line + week chips (S6) -----------------------------------
  // The next PUBLISHED assignment after today, on all three landings. The
  // one/many split for "others" and units is the same trick as
  // mywork.newUnits.one/.many — the framework interpolates {n} but has no
  // plural rule, so the caller picks the key by count.
  "tomorrow.kicker": { en: "Tomorrow", es: "Mañana" },
  "tomorrow.notScheduled": {
    en: "Tomorrow: not scheduled yet",
    es: "Mañana: aún sin turno asignado",
  },
  "tomorrow.field.starts": { en: "Starts", es: "Empieza" },
  "tomorrow.field.truck": { en: "Truck", es: "Camión" },
  "tomorrow.withOthers.one": { en: "with {n} other", es: "con {n} compañero más" },
  "tomorrow.withOthers.many": { en: "with {n} others", es: "con {n} compañeros más" },
  "tomorrow.units.one": { en: "{n} unit", es: "{n} unidad" },
  "tomorrow.units.many": { en: "{n} units", es: "{n} unidades" },
  "tomorrow.weekAria": { en: "This week", es: "Esta semana" },

  // ---- Today, rebuilt (S6) ------------------------------------------------
  "mywork.more.summary": { en: "More", es: "Más" },
  "mywork.more.doneToday": { en: "Done today", es: "Hechas hoy" },
  "mywork.more.doneToday.empty": { en: "Nothing yet", es: "Nada todavía" },
  "mywork.more.points": { en: "Points & badges", es: "Puntos e insignias" },
  "mywork.more.howYourDayWorks": { en: "How your day works", es: "Cómo funciona tu día" },
  "mywork.more.sendRecording": { en: "Send a recording", es: "Enviar una grabación" },
  "mywork.more.saveOffline": { en: "Save jobs offline", es: "Guardar trabajos sin conexión" },
  "mywork.counts.line": {
    en: "{assigned} assigned · {ready} ready · {done} done",
    es: "{assigned} asignadas · {ready} listas · {done} hechas",
  },

  // ---- Installer drawer regroup (S6) --------------------------------------
  "nav.group.work": { en: "Work", es: "Trabajo" },
  "nav.group.me": { en: "Me", es: "Yo" },
  "nav.group.help": { en: "Help", es: "Ayuda" },
  // ---- S3b — Spanish on Warehouse, storage/*, Ask (2026-09-07) ------------
  // The rest of the floor test's allow-list: Warehouse.tsx, the storage/*
  // detail screens it fans out to, AskInfinity.tsx, JobModelViewer.tsx, and
  // the shared components/warehouse/* pieces those pages render. Vocabulary
  // matches CONTEXT.md and the existing scan.*/supplies.* keys (conex, bay,
  // package, checked out, finalized, on site).

  // storage/WarehouseHistory.tsx
  "storage.history.warehouse": { en: "Warehouse", es: "Almacén" },
  "storage.history.title": { en: "History", es: "Historial" },
  "storage.history.subtitle": {
    en: "Jobs whose unit movement was finalized. Off the warehouse page, kept here to read; a foreman can reopen one.",
    es: "Trabajos cuyo movimiento de unidades fue finalizado. No aparecen en la página del almacén, pero quedan aquí para leerlos; un capataz puede reabrir uno.",
  },
  "storage.history.loading": { en: "Loading…", es: "Cargando…" },
  "storage.history.emptyTitle": { en: "No finalized jobs yet", es: "Todavía no hay trabajos finalizados" },
  "storage.history.emptyMessage": {
    en: "When a job's material has all gone out, a foreman taps Unit Movement Finalized on its page and it lands here.",
    es: "Cuando todo el material de un trabajo ya salió, un capataz toca Movimiento de unidades finalizado en su página y aparece aquí.",
  },
  "storage.history.finalizedJobs": { en: "Finalized jobs", es: "Trabajos finalizados" },
  "storage.history.materials": { en: "Materials", es: "Materiales" },
  "storage.history.open": { en: "Open", es: "Abrir" },
  "storage.history.summary.oneOne": {
    en: "Finalized {date} · 1 unit · 1 piece on the job site",
    es: "Finalizado el {date} · 1 unidad · 1 pieza en el sitio del trabajo",
  },
  "storage.history.summary.oneMany": {
    en: "Finalized {date} · 1 unit · {onSite} pieces on the job site",
    es: "Finalizado el {date} · 1 unidad · {onSite} piezas en el sitio del trabajo",
  },
  "storage.history.summary.manyOne": {
    en: "Finalized {date} · {units} units · 1 piece on the job site",
    es: "Finalizado el {date} · {units} unidades · 1 pieza en el sitio del trabajo",
  },
  "storage.history.summary.manyMany": {
    en: "Finalized {date} · {units} units · {onSite} pieces on the job site",
    es: "Finalizado el {date} · {units} unidades · {onSite} piezas en el sitio del trabajo",
  },

  // lib/warehouse/stations.ts — the five-stage funnel (components/warehouse/StationChip.tsx).
  "warehouse.station.comingIn": { en: "Coming in", es: "Llegando" },
  "warehouse.station.comingIn.when": {
    en: "A truck is scheduled or just pulled up.",
    es: "Un camión está programado o acaba de llegar.",
  },
  "warehouse.station.offTruck": { en: "Off the truck", es: "Bajando del camión" },
  "warehouse.station.offTruck.when": {
    en: "You're unloading — scan and tag as it comes off.",
    es: "Estás descargando — escanea y etiqueta según va bajando.",
  },
  "warehouse.station.putAway": { en: "Put away", es: "Guardar" },
  "warehouse.station.putAway.when": {
    en: "It's inside — give it a home.",
    es: "Ya está adentro — dale un lugar.",
  },
  "warehouse.station.outDoor": { en: "Out the door", es: "Saliendo" },
  "warehouse.station.outDoor.when": {
    en: "Material is leaving for a job.",
    es: "El material está saliendo para un trabajo.",
  },
  "warehouse.station.fixMistake": { en: "Fix a mistake", es: "Corregir un error" },
  "warehouse.station.fixMistake.when": {
    en: "The paperwork doesn't match the truth.",
    es: "El papeleo no coincide con la realidad.",
  },

  // lib/warehouse/areas.ts — where inside the box (ContainerViewer.tsx, package sentences).
  "warehouse.area.front": { en: "Front (door end)", es: "Frente (lado de la puerta)" },
  "warehouse.area.short.front": { en: "front", es: "frente" },
  "warehouse.area.middle": { en: "Middle", es: "Medio" },
  "warehouse.area.back": { en: "Back", es: "Fondo" },
  "warehouse.area.frontLeft": { en: "Front Left", es: "Frente Izquierda" },
  "warehouse.area.frontRight": { en: "Front Right", es: "Frente Derecha" },
  "warehouse.area.middleLeft": { en: "Middle Left", es: "Medio Izquierda" },
  "warehouse.area.middleRight": { en: "Middle Right", es: "Medio Derecha" },
  "warehouse.area.backLeft": { en: "Back Left", es: "Fondo Izquierda" },
  "warehouse.area.backRight": { en: "Back Right", es: "Fondo Derecha" },
  "warehouse.area.north": { en: "North", es: "Norte" },
  "warehouse.area.northeast": { en: "NorthEast", es: "Noreste" },
  "warehouse.area.east": { en: "East", es: "Este" },
  "warehouse.area.southeast": { en: "SouthEast", es: "Sureste" },
  "warehouse.area.south": { en: "South", es: "Sur" },
  "warehouse.area.southwest": { en: "SouthWest", es: "Suroeste" },
  "warehouse.area.west": { en: "West", es: "Oeste" },
  "warehouse.area.northwest": { en: "NorthWest", es: "Noroeste" },

  // lib/warehouse/containment.ts — "where is it, really" (FindBar, CardList,
  // JobPackagesPanel).
  "warehouse.place.insideParent": { en: "{container} — inside {parent}", es: "{container} — dentro de {parent}" },
  "warehouse.place.stagedFor": { en: "staged for {job} — {address}", es: "apartado para {job} — {address}" },
  "warehouse.place.aJob": { en: "a job", es: "un trabajo" },
  "warehouse.place.onAddress": { en: "on {address}", es: "en {address}" },
  "warehouse.place.onShelf": { en: "on a shelf", es: "en un estante" },
  "warehouse.place.loose": { en: "loose — no container, no slot", es: "suelto — sin caja, sin espacio" },
  "warehouse.place.nPlaces": { en: "{n} places", es: "{n} lugares" },

  // lib/warehouse/unitParts.ts — the completeness verdict (FindBar,
  // JobModelViewer.tsx tap-info card, CardList).
  "warehouse.parts.nothingTagged": { en: "Nothing tagged for this window yet", es: "Todavía no hay nada etiquetado para esta ventana" },
  "warehouse.parts.disagree": {
    en: "The labels disagree on how many parts this window has — a foreman should settle it",
    es: "Las etiquetas no coinciden en cuántas piezas tiene esta ventana — un capataz debe resolverlo",
  },
  "warehouse.parts.makerSays": {
    en: "Ours say {ours}, the maker's label says {maker} — the maker wins: burn the wrong labels and mint {maker}",
    es: "Las nuestras dicen {ours}, la etiqueta del fabricante dice {maker} — gana el fabricante: quema las etiquetas incorrectas y emite {maker}",
  },
  "warehouse.parts.noNumbers.one": { en: "{n} package here · labels carry no part numbers", es: "{n} paquete aquí · las etiquetas no traen número de parte" },
  "warehouse.parts.noNumbers.many": { en: "{n} packages here · labels carry no part numbers", es: "{n} paquetes aquí · las etiquetas no traen número de parte" },
  "warehouse.parts.allHere": { en: "{total} of {total} · all here", es: "{total} de {total} · todo aquí" },
  "warehouse.parts.onTheWayOnly": {
    en: "{present} of {total} here · {onWay} on the way",
    es: "{present} de {total} aquí · {onWay} en camino",
  },
  "warehouse.parts.onTheWayCount": { en: "{n} on the way", es: "{n} en camino" },
  "warehouse.parts.missing.one": {
    en: "{present} of {total} here · no label yet for part {missing}",
    es: "{present} de {total} aquí · todavía sin etiqueta para la parte {missing}",
  },
  "warehouse.parts.missing.many": {
    en: "{present} of {total} here · no label yet for parts {missing}",
    es: "{present} de {total} aquí · todavía sin etiqueta para las partes {missing}",
  },

  // lib/warehouse/find.ts — "where is it" (FindBar.tsx).
  "warehouse.find.checkedOut": { en: "checked out to a job", es: "sacado para un trabajo" },
  "warehouse.find.onTheWay": { en: "on the way — not arrived yet", es: "en camino — todavía no llega" },
  "warehouse.find.aContainer": { en: "a container", es: "una caja" },
  "warehouse.find.noHomeSpot": { en: "no home spot yet", es: "todavía sin lugar asignado" },
  "warehouse.find.missSuggestion": {
    en: "No sticker, window, shelf, conex or job by that name. If the material is here, tag it at the truck — until a sticker goes on, nobody can be told where it is.",
    es: "No hay ninguna etiqueta, ventana, estante, conex o trabajo con ese nombre. Si el material ya está aquí, etiquétalo en el camión — hasta que lleve una etiqueta, nadie puede saber dónde está.",
  },
  "warehouse.find.headline.unit": { en: "Window {mark} · {job} — {headline}", es: "Ventana {mark} · {job} — {headline}" },
  "warehouse.find.headline.markChoices": { en: "Window {mark} — {n} jobs have one", es: "Ventana {mark} — {n} trabajos tienen una" },
  "warehouse.find.headline.container.one": { en: "{name} — {n} package inside", es: "{name} — {n} paquete adentro" },
  "warehouse.find.headline.container.many": { en: "{name} — {n} packages inside", es: "{name} — {n} paquetes adentro" },
  "warehouse.find.headline.job.one": { en: "{job} — {n} package tagged", es: "{job} — {n} paquete etiquetado" },
  "warehouse.find.headline.job.many": { en: "{job} — {n} packages tagged", es: "{job} — {n} paquetes etiquetados" },
  "warehouse.find.headline.pendingJob.one": {
    en: "“{name}” (job not built yet) — {n} package tagged",
    es: "“{name}” (trabajo aún no creado) — {n} paquete etiquetado",
  },
  "warehouse.find.headline.pendingJob.many": {
    en: "“{name}” (job not built yet) — {n} packages tagged",
    es: "“{name}” (trabajo aún no creado) — {n} paquetes etiquetados",
  },
  "warehouse.find.headline.slot.one": { en: "{address} — {n} package", es: "{address} — {n} paquete" },
  "warehouse.find.headline.slot.many": { en: "{address} — {n} packages", es: "{address} — {n} paquetes" },
  "warehouse.find.headline.miss": { en: "Nothing found for “{query}”", es: "No se encontró nada para “{query}”" },

  // lib/warehouse/splitUnits.ts — the split-across-places warning
  // (Warehouse.tsx chip, CheckoutPackages.tsx confirm lines).
  "warehouse.split.morePlaces": { en: "in more than one place", es: "en más de un lugar" },
  "warehouse.split.looseShort": { en: "loose", es: "suelto" },
  "warehouse.split.at": { en: "at {place}", es: "en {place}" },
  "warehouse.split.part.one": { en: "part", es: "parte" },
  "warehouse.split.part.many": { en: "parts", es: "partes" },
  "warehouse.split.stays.one": { en: "stays", es: "se queda" },
  "warehouse.split.stays.many": { en: "stay", es: "se quedan" },
  "warehouse.split.line.stay": {
    en: "Window {mark} — taking {taking} of its {total} {partWord} here; the other {staying} {stayWord} {spot}.",
    es: "Ventana {mark} — llevando {taking} de sus {total} {partWord} de aquí; las otras {staying} {stayWord} {spot}.",
  },
  "warehouse.split.partLabel": { en: "Part {index} of {total}", es: "Parte {index} de {total}" },
  "warehouse.split.windowLabel": { en: "Window {mark}", es: "Ventana {mark}" },
  "warehouse.split.line.otherIs": {
    en: "{label} — the other {n} part is {spot}.",
    es: "{label} — la otra {n} parte está {spot}.",
  },
  "warehouse.split.line.otherAre": {
    en: "{label} — the other {n} parts are {spot}.",
    es: "{label} — las otras {n} partes están {spot}.",
  },

  // lib/storage.ts — part type / category vocabulary (TagPackages,
  // ArrivePackages, PackageRowText).
  "warehouse.partType.frame": { en: "Frame", es: "Marco" },
  "warehouse.partType.glass": { en: "Glass", es: "Vidrio" },
  "warehouse.partType.panel": { en: "Panel / sash", es: "Panel / hoja" },
  "warehouse.partType.threshold": { en: "Threshold", es: "Umbral" },
  "warehouse.partType.hardware": { en: "Hardware", es: "Herrajes" },
  "warehouse.partType.screen": { en: "Screen", es: "Mosquitero" },
  "warehouse.partType.other": { en: "Other", es: "Otro" },
  "warehouse.category.windows": { en: "Windows", es: "Ventanas" },
  "warehouse.category.doors": { en: "Doors", es: "Puertas" },
  "warehouse.category.frames": { en: "Frames", es: "Marcos" },
  "warehouse.category.hardware": { en: "Hardware", es: "Herrajes" },
  "warehouse.category.other": { en: "Other", es: "Otro" },
  "warehouse.partOf": { en: "Part {index} of {total}", es: "Parte {index} de {total}" },

  // components/warehouse/FindBar.tsx
  "warehouse.find.placeholder": {
    en: "Find: 16, PKG-000123, S-01-A, Conex 3, BLACK22…",
    es: "Buscar: 16, PKG-000123, S-01-A, Conex 3, BLACK22…",
  },
  "warehouse.find.ariaFind": { en: "Find anything in the warehouse", es: "Buscar cualquier cosa en el almacén" },
  "warehouse.find.clear": { en: "Clear", es: "Borrar" },
  "warehouse.find.scan": { en: "Scan", es: "Escanear" },
  "warehouse.find.unitTitle": { en: "Window {mark} · {job}", es: "Ventana {mark} · {job}" },
  "warehouse.find.openUnit": { en: "Open unit", es: "Abrir unidad" },
  "warehouse.find.showOnBuilding": { en: "Show on the building", es: "Mostrar en el edificio" },
  "warehouse.find.markMulti.title": { en: "Window {mark} — more than one job has one", es: "Ventana {mark} — más de un trabajo tiene una" },
  "warehouse.find.markMulti.hint": {
    en: "Window numbers come off the plans, so they start over on every job. Pick the job you are on.",
    es: "Los números de ventana vienen de los planos, así que empiezan de nuevo en cada trabajo. Elige el trabajo en el que estás.",
  },
  "warehouse.find.jobNotBuilt": { en: "job not built yet", es: "trabajo aún no creado" },
  "warehouse.find.onHand": { en: "about {n} {unit} on hand", es: "unos {n} {unit} en existencia" },
  "warehouse.find.neverCounted": { en: "never counted", es: "nunca contado" },
  "warehouse.find.takeSome": { en: "Take some", es: "Tomar un poco" },
  "warehouse.find.slotEmpty": { en: "Nothing on this shelf right now", es: "Ahora mismo no hay nada en este estante" },
  "warehouse.find.slotCount.one": { en: "{n} package here", es: "{n} paquete aquí" },
  "warehouse.find.slotCount.many": { en: "{n} packages here", es: "{n} paquetes aquí" },
  "warehouse.find.noPartNumber": { en: "No part number on label", es: "Sin número de parte en la etiqueta" },
  "warehouse.find.openHistory": { en: "Open its history", es: "Ver su historial" },
  "warehouse.find.inside.one": { en: "{n} package inside", es: "{n} paquete adentro" },
  "warehouse.find.inside.many": { en: "{n} packages inside", es: "{n} paquetes adentro" },
  "warehouse.find.atAddress": { en: "at {address}", es: "en {address}" },
  "warehouse.find.pendingWaiting.one": { en: "{n} package waiting — job not built in the app yet", es: "{n} paquete esperando — trabajo aún no creado en la app" },
  "warehouse.find.pendingWaiting.many": { en: "{n} packages waiting — job not built in the app yet", es: "{n} paquetes esperando — trabajo aún no creado en la app" },
  "warehouse.find.taggedForJob.one": { en: "{n} package tagged for this job", es: "{n} paquete etiquetado para este trabajo" },
  "warehouse.find.taggedForJob.many": { en: "{n} packages tagged for this job", es: "{n} paquetes etiquetados para este trabajo" },
  "warehouse.find.open": { en: "Open {name}", es: "Abrir {name}" },

  // lib/storage.ts — jobLabel/packageTitle (PackageRowText.tsx and every
  // list row built on them).
  "warehouse.job.waitingOnJob": { en: "waiting on job", es: "esperando trabajo" },
  // i18n-same-on-purpose: "Boneyard" is the crew's own word (CONTEXT.md), kept as-is.
  "warehouse.job.boneyard": { en: "Boneyard", es: "Boneyard" },
  "warehouse.job.notListed": { en: "job not listed", es: "trabajo no registrado" },
  "warehouse.pieceCount": { en: "{n} pc {kind}", es: "{n} pza {kind}" },

  // lib/warehouse/warehouseCards.ts — the four hub cards (Warehouse.tsx
  // chips, CardList.tsx).
  "warehouse.card.onHand.label": { en: "on hand", es: "en existencia" },
  "warehouse.card.onHand.blurb": {
    en: "Every package we are still holding — tagged and not yet taken out to a job. This is the warehouse's whole load.",
    es: "Todo paquete que todavía tenemos — etiquetado y aún no sacado para un trabajo. Esta es toda la carga del almacén.",
  },
  "warehouse.card.notTagged.label": { en: "not tagged", es: "sin etiquetar" },
  "warehouse.card.notTagged.blurb": {
    en: "Windows on an active job's plans with no package tagged yet. Either the material hasn't arrived, or it's here and nobody stuck a sticker on it — and until somebody does, nobody can be told where it is. Tag things as you touch them and this number only goes down.",
    es: "Ventanas en los planos de un trabajo activo sin ningún paquete etiquetado todavía. O el material no ha llegado, o ya está aquí y nadie le puso una etiqueta — y hasta que alguien lo haga, nadie puede saber dónde está. Etiqueta las cosas conforme las tocas y este número solo baja.",
  },
  "warehouse.card.loose.label": { en: "loose", es: "suelto" },
  "warehouse.card.loose.blurb": {
    en: "Tagged, so we know it exists — but in no conex, no crate and no shelf spot, so the app can't tell anyone where. Scan these into a container and they stop being lost.",
    es: "Etiquetado, así que sabemos que existe — pero sin conex, sin crate y sin lugar en un estante, así que la app no le puede decir a nadie dónde está. Escanéalos hacia una caja y dejan de estar perdidos.",
  },
  "warehouse.card.damaged.label": { en: "damaged", es: "dañado" },
  "warehouse.card.damaged.blurb": {
    en: "Open damage reports — material that arrived broken or got broken here. Each one needs a replacement ordered before that window can be finished. Tap through to the issue to see the note, the photo when one was taken, and who reported it.",
    es: "Reportes de daño abiertos — material que llegó roto o se rompió aquí. Cada uno necesita un reemplazo pedido antes de que esa ventana se pueda terminar. Toca para ver el reporte con la nota, la foto cuando se tomó una, y quién lo reportó.",
  },

  // components/warehouse/CardList.tsx
  "warehouse.card.window": { en: "Window {mark}", es: "Ventana {mark}" },
  "warehouse.card.nothingTagged": { en: "nothing tagged yet", es: "nada etiquetado todavía" },
  "warehouse.card.noSpecPage": { en: "no spec page yet — spec review adds it", es: "todavía sin página de spec — la revisión de spec la agrega" },
  "warehouse.card.allTagged": {
    en: "Every window on every active job has at least one package tagged.",
    es: "Toda ventana de todo trabajo activo tiene al menos un paquete etiquetado.",
  },
  "warehouse.card.nothingHere": { en: "Nothing here — good.", es: "No hay nada aquí — bien." },
  "warehouse.card.clearFilter": { en: "Clear filter", es: "Quitar filtro" },

  // components/warehouse/Yard.tsx
  "warehouse.yard.ariaLabel": { en: "The yard", es: "El patio" },
  // i18n-same-on-purpose: "crate" is the crew's own word in both languages (CONTEXT.md), same as "conex".
  "warehouse.yard.kind.crate": { en: "crate", es: "crate" },
  "warehouse.yard.kind.truck": { en: "truck", es: "camión" },
  "warehouse.yard.kind.trailer": { en: "trailer", es: "remolque" },
  "warehouse.yard.kind.building": { en: "building", es: "edificio" },
  "warehouse.yard.kind.bay": { en: "bay", es: "bahía" },
  "warehouse.yard.packages.one": { en: "{n} package", es: "{n} paquete" },
  "warehouse.yard.packages.many": { en: "{n} packages", es: "{n} paquetes" },
  "warehouse.yard.holding.one": { en: "holding {n} crate", es: "con {n} crate" },
  "warehouse.yard.holding.many": { en: "holding {n} crates", es: "con {n} crates" },
  "warehouse.yard.oldest": { en: "oldest {n}d", es: "el más viejo {n}d" },
  "warehouse.yard.newContainer": { en: "+ New container", es: "+ Nueva caja" },
  "warehouse.yard.newContainerHint": { en: "a conex, crate or truck", es: "un conex, crate o camión" },

  // lib/warehouse/yard.ts — bay/box summaries (Warehouse.tsx, Bays.tsx).
  "warehouse.yard.bays.none": {
    en: "No bays — a job gets its own the first time something is set aside for it.",
    es: "Sin bahías — un trabajo recibe la suya la primera vez que se aparta algo para él.",
  },
  "warehouse.yard.bays.headOne": { en: "{n} bay", es: "{n} bahía" },
  "warehouse.yard.bays.headMany": { en: "{n} bays", es: "{n} bahías" },
  "warehouse.yard.bays.nothingSetAside": { en: "nothing set aside right now", es: "nada apartado ahora mismo" },
  "warehouse.yard.bays.setAsideOne": { en: "{n} package set aside in {holding}", es: "{n} paquete apartado en {holding}" },
  "warehouse.yard.bays.setAsideMany": { en: "{n} packages set aside in {holding}", es: "{n} paquetes apartados en {holding}" },
  "warehouse.yard.bayOffBlock.one": {
    en: "1 package is still set aside in {name}. Move it out first.",
    es: "Todavía hay 1 paquete apartado en {name}. Sácalo primero.",
  },
  "warehouse.yard.bayOffBlock.many": {
    en: "{n} packages are still set aside in {name}. Move them out first.",
    es: "Todavía hay {n} paquetes apartados en {name}. Sácalos primero.",
  },
  "warehouse.yard.bayOffBlock.holds": {
    en: "{name} still holds {children}. Move that out first.",
    es: "{name} todavía tiene {children}. Sácalo primero.",
  },
  "warehouse.yard.summary.none": {
    en: "No boxes yet — add the first conex to start the yard.",
    es: "Todavía no hay cajas — agrega el primer conex para empezar el patio.",
  },
  "warehouse.yard.summary.oneBox": { en: "{n} package in {boxes} {boxWord}", es: "{n} paquete en {boxes} {boxWord}" },
  "warehouse.yard.summary.manyBox": { en: "{n} packages in {boxes} {boxWord}", es: "{n} paquetes en {boxes} {boxWord}" },
  "warehouse.yard.summary.box.one": { en: "box", es: "caja" },
  "warehouse.yard.summary.box.many": { en: "boxes", es: "cajas" },
  "warehouse.yard.summary.job.one": { en: "{n} job", es: "{n} trabajo" },
  "warehouse.yard.summary.job.many": { en: "{n} jobs", es: "{n} trabajos" },

  // components/warehouse/Bays.tsx
  "warehouse.bays.empty": {
    en: "No bays yet. A job gets its own the first time something is set aside for it.",
    es: "Todavía no hay bahías. Un trabajo recibe la suya la primera vez que se aparta algo para él.",
  },
  "warehouse.bays.ariaLabel": { en: "The bays", es: "Las bahías" },
  "warehouse.bays.nothingSetAside": { en: "Nothing set aside", es: "Nada apartado" },
  "warehouse.bays.line.one": { en: "{n} package set aside{oldest}", es: "{n} paquete apartado{oldest}" },
  "warehouse.bays.line.many": { en: "{n} packages set aside{oldest}", es: "{n} paquetes apartados{oldest}" },
  "warehouse.bays.turnOffHint": { en: "Turn this bay off — its material has gone out", es: "Apaga esta bahía — su material ya salió" },
  "warehouse.bays.turningOff": { en: "Turning off…", es: "Apagando…" },
  "warehouse.bays.turnOff": { en: "Turn off", es: "Apagar" },

  // components/warehouse/DayRecapCard.tsx
  "warehouse.recap.title": { en: "Today", es: "Hoy" },
  "warehouse.recap.quiet": { en: "Quiet so far — nothing moved today.", es: "Tranquilo por ahora — nada se ha movido hoy." },
  "warehouse.recap.checkedIn": { en: "checked in", es: "recibidos" },
  "warehouse.recap.stored": { en: "stored", es: "guardados" },
  "warehouse.recap.checkedOut": { en: "checked out", es: "sacados" },
  "warehouse.recap.stillMissing": { en: "still missing from {label}", es: "todavía faltan de {label}" },

  // lib/warehouse/jobStrip.ts + components/warehouse/JobStrip.tsx
  "warehouse.jobStrip.toCome": { en: "{here}/{total} · {remaining} to come", es: "{here}/{total} · {remaining} por llegar" },
  "warehouse.jobStrip.ariaLabel": { en: "Jobs with material", es: "Trabajos con material" },
  "warehouse.jobStrip.title": { en: "Jobs with material", es: "Trabajos con material" },
  "warehouse.jobStrip.tapAgain": { en: "Tap again to stop highlighting", es: "Toca de nuevo para dejar de resaltar" },
  "warehouse.jobStrip.tapToLight": { en: "Tap to light up this job's boxes", es: "Toca para iluminar las cajas de este trabajo" },
  "warehouse.jobStrip.sendHint": { en: "Send this job's material to the job site", es: "Enviar el material de este trabajo al sitio" },
  "warehouse.jobStrip.sendToSite": { en: "Send to site →", es: "Enviar al sitio →" },
  "warehouse.jobStrip.hint": {
    en: "Units here of units expected. Tap a job to light up its boxes; tap the code for its materials.",
    es: "Unidades aquí de las unidades esperadas. Toca un trabajo para iluminar sus cajas; toca el código para ver sus materiales.",
  },

  // components/warehouse/ContainerForm.tsx
  "warehouse.containerForm.updated": { en: "Container updated.", es: "Caja actualizada." },
  "warehouse.containerForm.added": { en: "{name} added.", es: "{name} agregado." },
  "warehouse.containerForm.editTitle": { en: "Edit {name}", es: "Editar {name}" },
  "warehouse.containerForm.newTitle": { en: "New container", es: "Nueva caja" },
  "warehouse.containerForm.name": { en: "Name", es: "Nombre" },
  "warehouse.containerForm.namePlaceholder": { en: "Conex 7 / Glass crate 12", es: "Conex 7 / Crate de vidrio 12" },
  "warehouse.containerForm.kind": { en: "What kind of box", es: "Qué tipo de caja" },
  // i18n-same-on-purpose: "Conex" is the crew's own word in both languages (CONTEXT.md).
  "warehouse.containerForm.kind.conex": { en: "Conex", es: "Conex" },
  // i18n-same-on-purpose: "Crate" is the crew's own word in both languages (CONTEXT.md).
  "warehouse.containerForm.kind.crate": { en: "Crate", es: "Crate" },
  "warehouse.containerForm.kind.truck": { en: "Truck", es: "Camión" },
  "warehouse.containerForm.crateHint": {
    en: "Size and weight, so anyone can tell whether it fits in a conex and what the forklift is picking up. Centimeters and kilograms; leave blank until it's measured.",
    es: "Tamaño y peso, para que cualquiera sepa si cabe en un conex y qué está levantando el montacargas. Centímetros y kilogramos; déjalo en blanco hasta medirlo.",
  },
  "warehouse.containerForm.length": { en: "Length (cm)", es: "Largo (cm)" },
  "warehouse.containerForm.width": { en: "Width (cm)", es: "Ancho (cm)" },
  "warehouse.containerForm.height": { en: "Height (cm)", es: "Alto (cm)" },
  "warehouse.containerForm.weight": { en: "Weight (kg)", es: "Peso (kg)" },
  "warehouse.containerForm.address": { en: "Address", es: "Dirección" },
  "warehouse.containerForm.addressPlaceholder": { en: "Where it sits", es: "Dónde está" },
  "warehouse.containerForm.accessCode": { en: "Gate / lock code", es: "Código de portón / candado" },
  "warehouse.containerForm.notes": { en: "Notes", es: "Notas" },
  "warehouse.containerForm.saving": { en: "Saving…", es: "Guardando…" },
  "warehouse.containerForm.save": { en: "Save", es: "Guardar" },
  "warehouse.containerForm.cancel": { en: "Cancel", es: "Cancelar" },

  // components/warehouse/MintForm.tsx
  "warehouse.mintForm.ready": { en: "{n} blank stickers ready to print.", es: "{n} etiquetas en blanco listas para imprimir." },
  "warehouse.mintForm.title": { en: "Print blank stickers", es: "Imprimir etiquetas en blanco" },
  "warehouse.mintForm.hint": {
    en: "Each sticker gets a permanent serial the moment it prints — batches are 1–500 at a time.",
    es: "Cada etiqueta recibe un número de serie permanente en el momento en que se imprime — los lotes son de 1 a 500 a la vez.",
  },
  "warehouse.mintForm.howMany": { en: "How many", es: "Cuántas" },
  "warehouse.mintForm.invalid": { en: "Pick a number from 1 to 500.", es: "Elige un número del 1 al 500." },
  "warehouse.mintForm.printing": { en: "Printing…", es: "Imprimiendo…" },
  "warehouse.mintForm.print": { en: "Print {n} stickers", es: "Imprimir {n} etiquetas" },
  "warehouse.mintForm.cancel": { en: "Cancel", es: "Cancelar" },

  // pages/Warehouse.tsx
  "warehouse.page.title": { en: "Warehouse", es: "Almacén" },
  "warehouse.page.h1": { en: "Where is it", es: "Dónde está" },
  "warehouse.page.pending.one": {
    en: "{n} warehouse change is saved on this phone and not sent yet — they go up on their own when you have signal.",
    es: "{n} cambio del almacén está guardado en este teléfono y todavía no se ha enviado — se suben solos cuando tengas señal.",
  },
  "warehouse.page.pending.many": {
    en: "{n} warehouse changes are saved on this phone and not sent yet — they go up on their own when you have signal.",
    es: "{n} cambios del almacén están guardados en este teléfono y todavía no se han enviado — se suben solos cuando tengas señal.",
  },
  "warehouse.page.whatToShow": { en: "What to show", es: "Qué mostrar" },
  "warehouse.page.boxes": { en: "Boxes", es: "Cajas" },
  "warehouse.page.baysLabel": { en: "Bays", es: "Bahías" },
  "warehouse.page.postersBay": { en: "A poster for every bay", es: "Un póster para cada bahía" },
  "warehouse.page.postersBox": { en: "A poster for every box", es: "Un póster para cada caja" },
  "warehouse.page.allPosters": { en: "All posters", es: "Todos los pósters" },
  "warehouse.page.loadingYard": { en: "Loading the yard…", es: "Cargando el patio…" },
  "warehouse.page.nextTruck": { en: "Next truck", es: "Próximo camión" },
  "warehouse.page.truckLine": { en: "Truck {date} · {label}", es: "Camión {date} · {label}" },
  "warehouse.page.delivery": { en: "delivery", es: "entrega" },
  "warehouse.page.aDelivery": { en: "a delivery", es: "una entrega" },
  "warehouse.page.noTruck": { en: "No truck on the calendar", es: "Sin camión en el calendario" },
  "warehouse.page.checkAgainstList": { en: "Check it against its list when it lands.", es: "Revísalo contra su lista cuando llegue." },
  "warehouse.page.logWhenLands": { en: "Log one when it lands, or ahead of time.", es: "Regístralo cuando llegue, o antes de tiempo." },
  "warehouse.page.openItsList": { en: "Open its list", es: "Abrir su lista" },
  "warehouse.page.deliveriesCheckIn": { en: "Deliveries — check trucks in", es: "Entregas — registrar camiones" },
  "warehouse.page.logDelivery": { en: "Log a delivery (truck)", es: "Registrar una entrega (camión)" },
  "warehouse.page.needsAttention": { en: "Needs attention", es: "Necesita atención" },
  "warehouse.page.splitAcross": { en: "split across places", es: "dividido en varios lugares" },
  "warehouse.page.damageReport.one": { en: "damage report", es: "reporte de daño" },
  "warehouse.page.damageReport.many": { en: "damage reports", es: "reportes de daño" },
  "warehouse.page.untagged.one": { en: "window on the plans with nothing tagged", es: "ventana en los planos sin nada etiquetado" },
  "warehouse.page.untagged.many": { en: "windows on the plans with nothing tagged", es: "ventanas en los planos sin nada etiquetado" },
  "warehouse.page.seeWhich": { en: "see which", es: "ver cuáles" },
  "warehouse.page.actions": { en: "Warehouse actions", es: "Acciones del almacén" },
  "warehouse.page.tagPackages": { en: "Tag packages", es: "Etiquetar paquetes" },
  "warehouse.page.arrivalCheck": { en: "Arrival check", es: "Revisión de llegada" },
  "warehouse.page.setAsideCheckOut": { en: "Set aside / check out", es: "Apartar / sacar" },
  "warehouse.page.jobMaterials": { en: "Job materials", es: "Materiales del trabajo" },
  "warehouse.page.takeoffs": { en: "Takeoffs", es: "Conteos" },
  "warehouse.page.openCount": { en: "{n} open", es: "{n} pendientes" },
  "warehouse.page.takeSupplies": { en: "Take supplies", es: "Tomar suministros" },
  "warehouse.page.moreFold": { en: "More — today, out on jobs, supplies on the shelf", es: "Más — hoy, en trabajos, suministros en el estante" },
  "warehouse.page.noJob": { en: "No job", es: "Sin trabajo" },
  "warehouse.page.packagesOut.one": { en: "{n} package out", es: "{n} paquete afuera" },
  "warehouse.page.packagesOut.many": { en: "{n} packages out", es: "{n} paquetes afuera" },
  "warehouse.page.catalogEmpty": { en: "Nothing in the catalog yet — add supplies from Take supplies.", es: "Todavía no hay nada en el catálogo — agrega suministros desde Tomar suministros." },
  "warehouse.page.showingOf": { en: "Showing {shown} of {total} — type to narrow.", es: "Mostrando {shown} de {total} — escribe para filtrar." },
  "warehouse.page.testing": { en: "Testing", es: "Pruebas" },
  "warehouse.page.testingBlurb": {
    en: "Fake data for practice or QA. Flag a job as testing from its Job details panel — its material shows up here instead of in the counts above, and never counts as real inventory.",
    es: "Datos falsos para practicar o para QA. Marca un trabajo como de prueba desde su panel de detalles — su material aparece aquí en vez de en los conteos de arriba, y nunca cuenta como inventario real.",
  },
  "warehouse.page.testPackages.one": { en: "{n} package — practice material, never counted as inventory", es: "{n} paquete — material de práctica, nunca cuenta como inventario" },
  "warehouse.page.testPackages.many": { en: "{n} packages — practice material, never counted as inventory", es: "{n} paquetes — material de práctica, nunca cuenta como inventario" },
  "warehouse.page.noTestPackages": { en: "No testing packages right now.", es: "Ahora mismo no hay paquetes de prueba." },
  "warehouse.page.bayGone": { en: "That bay is not on the list any more. Reload and look again.", es: "Esa bahía ya no está en la lista. Recarga y vuelve a mirar." },
  "warehouse.page.bayStillHolds": { en: "Something is still set aside in {name}. Move it out first.", es: "Todavía hay algo apartado en {name}. Sácalo primero." },

  // pages/storage/ArrivePackages.tsx
  "storage.arrive.storage": { en: "Storage", es: "Almacén" },
  "storage.arrive.title": { en: "Arrival check", es: "Revisión de llegada" },
  "storage.arrive.explain": {
    en: "Only worth doing when something looks wrong. Tick anything that arrived broken and it raises an urgent issue naming that package, so a replacement gets ordered today instead of on the day somebody tries to install it. Add a photo if you can — it's optional, and the issue opens either way. Skipping this changes nothing — the material is already at the job either way.",
    es: "Solo vale la pena hacerlo cuando algo se ve mal. Marca cualquier cosa que llegó rota y se genera un reporte urgente con el nombre de ese paquete, para que se pida un reemplazo hoy en vez del día que alguien trate de instalarlo. Agrega una foto si puedes — es opcional, y el reporte se abre de todas formas. Saltarte esto no cambia nada — el material ya está en el trabajo de cualquier forma.",
  },
  "storage.arrive.whichJob": { en: "Which job", es: "Cuál trabajo" },
  "storage.arrive.pickJob": { en: "Pick the job…", es: "Elige el trabajo…" },
  "storage.arrive.whatTurnedUp": { en: "What turned up ({n} out)", es: "Qué llegó ({n} afuera)" },
  "storage.arrive.noPartNumber": { en: "no part number", es: "sin número de parte" },
  "storage.arrive.marks": { en: "marks {marks}", es: "marcas {marks}" },
  "storage.arrive.good": { en: "Good", es: "Bien" },
  "storage.arrive.damaged": { en: "Damaged", es: "Dañado" },
  "storage.arrive.photoPrompt": { en: "Photo of the damage (optional)", es: "Foto del daño (opcional)" },
  "storage.arrive.nothingCheckedOut": { en: "Nothing is checked out to {job} right now.", es: "Ahora mismo nada está sacado para {job}." },
  "storage.arrive.thisJob": { en: "this job", es: "este trabajo" },
  "storage.arrive.noteOptional": { en: "Note (optional)", es: "Nota (opcional)" },
  "storage.arrive.notePlaceholder": { en: "e.g. corner crushed on the truck", es: "ej. esquina aplastada en el camión" },
  "storage.arrive.logging": { en: "Logging…", es: "Registrando…" },
  "storage.arrive.logButton": { en: "Log {total} · {damaged} damaged", es: "Registrar {total} · {damaged} dañados" },
  "storage.arrive.logged.damagedOne": { en: "Arrival logged — {n} flagged damaged, an issue is open.", es: "Llegada registrada — {n} marcado dañado, hay un reporte abierto." },
  "storage.arrive.logged.damagedMany": { en: "Arrival logged — {n} flagged damaged, issues are open.", es: "Llegada registrada — {n} marcados dañados, hay reportes abiertos." },
  "storage.arrive.logged.goodOne": { en: "Arrival logged — {n} package good.", es: "Llegada registrada — {n} paquete en buen estado." },
  "storage.arrive.logged.goodMany": { en: "Arrival logged — {n} packages good.", es: "Llegada registrada — {n} paquetes en buen estado." },
  "storage.arrive.photoFail.one": {
    en: "{n} photo couldn't be saved, but the damage report went through — {reason}",
    es: "No se pudo guardar {n} foto, pero el reporte de daño sí se envió — {reason}",
  },
  "storage.arrive.photoFail.many": {
    en: "{n} photos couldn't be saved, but the damage report went through — {reason}",
    es: "No se pudieron guardar {n} fotos, pero el reporte de daño sí se envió — {reason}",
  },

  // lib/warehouse/offlineWrites.ts — the shared "not sent yet" toast suffix.
  "warehouse.offline.notSentYet": { en: "{done} — not sent yet, no signal in here.", es: "{done} — todavía no se envía, sin señal aquí adentro." },

  // pages/storage/TagPackages.tsx
  "storage.tag.waitingLine.one": {
    en: "1 sticker is assigned and saved on this phone, not sent yet. It goes up on its own when you have signal.",
    es: "1 etiqueta está asignada y guardada en este teléfono, todavía no se envía. Se sube sola cuando tengas señal.",
  },
  "storage.tag.waitingLine.many": {
    en: "{n} stickers are assigned and saved on this phone, not sent yet. They go up on their own when you have signal.",
    es: "{n} etiquetas están asignadas y guardadas en este teléfono, todavía no se envían. Se suben solas cuando tengas señal.",
  },
  "storage.tag.received.one": { en: "{n} package received.", es: "{n} paquete recibido." },
  "storage.tag.received.many": { en: "{n} packages received.", es: "{n} paquetes recibidos." },
  "storage.tag.addedToSchedule": { en: "Window {mark} added to the schedule.", es: "Ventana {mark} agregada al horario." },
  "storage.tag.pickJobFirst": { en: "Pick a job first", es: "Elige un trabajo primero" },
  "storage.tag.forMark": { en: " for #{mark}", es: " para #{mark}" },
  "storage.tag.tagged.queuedOne": {
    en: "{n} package tagged{forMark} — {queued} saved on this phone, not sent yet.",
    es: "{n} paquete etiquetado{forMark} — {queued} guardado en este teléfono, todavía no se envía.",
  },
  "storage.tag.tagged.queuedMany": {
    en: "{n} packages tagged{forMark} — {queued} saved on this phone, not sent yet.",
    es: "{n} paquetes etiquetados{forMark} — {queued} guardados en este teléfono, todavía no se envían.",
  },
  "storage.tag.tagged.sentOne": { en: "{n} package tagged{forMark}.", es: "{n} paquete etiquetado{forMark}." },
  "storage.tag.tagged.sentMany": { en: "{n} packages tagged{forMark}.", es: "{n} paquetes etiquetados{forMark}." },
  "storage.tag.notAPackageSticker": { en: "That's not a package sticker.", es: "Esa no es una etiqueta de paquete." },
  "storage.tag.alreadyAssignedQueued": { en: "{serial} is already assigned — saved on this phone and not sent yet.", es: "{serial} ya está asignado — guardado en este teléfono y todavía no se envía." },
  "storage.tag.alreadyAssigned": { en: "{serial} is already assigned.", es: "{serial} ya está asignado." },
  "storage.tag.assignedOrUnknown": { en: "{serial} is already assigned or unknown.", es: "{serial} ya está asignado o es desconocido." },
  "storage.tag.setHowManyFirst": { en: "Set how many pieces first.", es: "Primero indica cuántas piezas." },
  "storage.tag.alreadyOnAnotherLine": { en: "{serial} is already on another line.", es: "{serial} ya está en otra línea." },
  "storage.tag.storage": { en: "Storage", es: "Almacén" },
  "storage.tag.title": { en: "Tag packages", es: "Etiquetar paquetes" },
  "storage.tag.taggedThisSession": { en: "{n} tagged this session", es: "{n} etiquetados en esta sesión" },
  "storage.tag.ofTotal": { en: "{index} of {total}", es: "{index} de {total}" },
  "storage.tag.preLabeled": { en: "Pre-labeled — off the truck", es: "Preetiquetado — bajando del camión" },
  "storage.tag.preLabeledExplain": {
    en: "These labels were printed before the truck. Stick each one on its package, tap it here, and hit Arrived. If the maker's own label says a different count than the sticker (“2 of 3” against our “2 of 4”), the maker wins — tell a foreman so the wrong stickers get burned and the count fixed. Nothing here blocks the truck.",
    es: "Estas etiquetas se imprimieron antes del camión. Pega cada una en su paquete, tócala aquí, y presiona Llegó. Si la etiqueta del fabricante dice un número distinto al de la nuestra (“2 de 3” contra nuestra “2 de 4”), gana el fabricante — avísale a un capataz para quemar las etiquetas incorrectas y corregir el número. Nada aquí detiene al camión.",
  },
  "storage.tag.receiving": { en: "Receiving…", es: "Recibiendo…" },
  "storage.tag.arrivedReceive": { en: "Arrived — receive {n}", es: "Llegó — recibir {n}" },
  "storage.tag.step1": { en: "1 · The window", es: "1 · La ventana" },
  "storage.tag.job": { en: "Job", es: "Trabajo" },
  "storage.tag.pickJob": { en: "Pick the job…", es: "Elige el trabajo…" },
  "storage.tag.boneyardOption": { en: "Boneyard — company stock, no job yet", es: "Boneyard — inventario de la empresa, sin trabajo todavía" },
  "storage.tag.category": { en: "Category — holds for every piece below", es: "Categoría — aplica a cada pieza de abajo" },
  "storage.tag.windowNumber": { en: "Window # (mark)", es: "N.º de ventana (marca)" },
  "storage.tag.windowNumberPlaceholder": { en: "e.g. 16", es: "ej. 16" },
  "storage.tag.windowNumberAria": { en: "Window number", es: "Número de ventana" },
  "storage.tag.notOnSchedule": { en: "Window {mark} isn’t on this job’s schedule yet.", es: "La ventana {mark} todavía no está en el horario de este trabajo." },
  "storage.tag.addingMark": { en: "Adding…", es: "Agregando…" },
  "storage.tag.addMarkToSchedule": { en: "Add window {mark} to the schedule", es: "Agregar ventana {mark} al horario" },
  "storage.tag.howManyPieces": { en: "How many pieces?", es: "¿Cuántas piezas?" },
  "storage.tag.howManyPiecesAria": { en: "How many pieces", es: "Cuántas piezas" },
  "storage.tag.growth.one": {
    en: "Window {mark} already has {have} part{ofOld}. These {lines} continue at {start} — on submit, every label for this window becomes “of {newTotal}”.",
    es: "La ventana {mark} ya tiene {have} parte{ofOld}. Estas {lines} continúan en {start} — al enviar, cada etiqueta de esta ventana pasa a decir “de {newTotal}”.",
  },
  "storage.tag.growth.many": {
    en: "Window {mark} already has {have} parts{ofOld}. These {lines} continue at {start} — on submit, every label for this window becomes “of {newTotal}”.",
    es: "La ventana {mark} ya tiene {have} partes{ofOld}. Estas {lines} continúan en {start} — al enviar, cada etiqueta de esta ventana pasa a decir “de {newTotal}”.",
  },
  "storage.tag.growth.ofOld": { en: " (of {total})", es: " (de {total})" },
  "storage.tag.step2": { en: "2 · The pieces", es: "2 · Las piezas" },
  "storage.tag.worksheetExplain": {
    en: "One line per piece, matched to the maker's own numbers — the box printed “1/3” gets the line that says 1/3, and that line's sticker goes on it. Tap a line and it glows: the piece buttons below, and any sticker you scan, land on the glowing line.",
    es: "Una línea por pieza, según los números del fabricante — la caja que dice “1/3” recibe la línea que dice 1/3, y la etiqueta de esa línea va en ella. Toca una línea y se ilumina: los botones de pieza de abajo, y cualquier etiqueta que escanees, van a la línea iluminada.",
  },
  "storage.tag.whichPiece": { en: "which piece? — tap to set", es: "¿qué pieza? — toca para elegir" },
  "storage.tag.rollDry": { en: "no sticker — roll is dry", es: "sin etiqueta — se acabó el rollo" },
  "storage.tag.removeLine": { en: "Remove line {n}", es: "Quitar línea {n}" },
  "storage.tag.whichPieceIs": { en: "Which piece is {line}?", es: "¿Qué pieza es {line}?" },
  "storage.tag.theirNumber": { en: "Their # for this piece (only if it differs from ours)", es: "Su número para esta pieza (solo si es distinto al nuestro)" },
  "storage.tag.theirNumberPlaceholder": { en: "e.g. A-2216", es: "ej. A-2216" },
  "storage.tag.stopScanning": { en: "Stop scanning", es: "Dejar de escanear" },
  "storage.tag.scanOntoGlowing": { en: "Scan a sticker onto the glowing line", es: "Escanea una etiqueta hacia la línea iluminada" },
  "storage.tag.offRollForGood": { en: "Off the roll for good — a sticker only ever belongs to one package.", es: "Fuera del rollo para siempre — una etiqueta solo pertenece a un paquete." },
  "storage.tag.assignedNotSent": { en: "Assigned — saved on this phone and not sent yet.", es: "Asignada — guardada en este teléfono y todavía no se envía." },
  "storage.tag.andNMore": { en: "and {n} more", es: "y {n} más" },
  "storage.tag.noBlankStickers": { en: "No blank stickers left — print a batch from the Storage page.", es: "No quedan etiquetas en blanco — imprime un lote desde la página del almacén." },
  "storage.tag.step3": { en: "3 · Send it", es: "3 · Enviar" },
  "storage.tag.noteOptional": { en: "Note (optional, rides every piece)", es: "Nota (opcional, va en cada pieza)" },
  "storage.tag.notePlaceholder": { en: "e.g. glass crate, fragile", es: "ej. crate de vidrio, frágil" },
  "storage.tag.tagging": { en: "Tagging…", es: "Etiquetando…" },
  "storage.tag.typeWindowFirst": { en: "Type the window number first", es: "Escribe primero el número de ventana" },
  "storage.tag.lineNoSticker": { en: "A line has no sticker — the roll is dry", es: "Una línea no tiene etiqueta — se acabó el rollo" },
  "storage.tag.submit.one": { en: "Tag {n} package", es: "Etiquetar {n} paquete" },
  "storage.tag.submit.many": { en: "Tag {n} packages", es: "Etiquetar {n} paquetes" },

  // pages/storage/CheckoutPackages.tsx
  "storage.checkout.mismatch.stage": { en: "Double-check before it goes in this job's bay.", es: "Verifica bien antes de ponerlo en la bahía de este trabajo." },
  "storage.checkout.mismatch.out": { en: "Double-check before it leaves.", es: "Verifica bien antes de que salga." },
  "storage.checkout.storage": { en: "Storage", es: "Almacén" },
  "storage.checkout.setAsideTitle": { en: "Set aside for a job", es: "Apartar para un trabajo" },
  "storage.checkout.checkOutTitle": { en: "Check out", es: "Sacar" },
  "storage.checkout.setAsideStaging": { en: "Set aside (staging)", es: "Apartar (bahía)" },
  "storage.checkout.checkOutButton": { en: "Check out", es: "Sacar" },
  "storage.checkout.stageHint": {
    en: "Puts them on this job's own shelf so they go out together. Still ours, still on hand — check one back into a conex any time.",
    es: "Los pone en el estante propio de este trabajo para que salgan juntos. Siguen siendo nuestros, siguen en existencia — puedes devolver uno a un conex cuando quieras.",
  },
  "storage.checkout.outHint": {
    en: "Takes them out of storage to the job. This is the end of the trail; the history stays forever.",
    es: "Los saca del almacén hacia el trabajo. Aquí termina el rastro; el historial se queda para siempre.",
  },
  "storage.checkout.step1": { en: "1 · Packages ({n} picked)", es: "1 · Paquetes ({n} elegidos)" },
  "storage.checkout.allContainers": { en: "All containers", es: "Todas las cajas" },
  "storage.checkout.notStoredYet": { en: "not stored yet", es: "todavía sin guardar" },
  "storage.checkout.nothingInStorage": { en: "Nothing in storage.", es: "No hay nada en el almacén." },
  "storage.checkout.step2Why": { en: "2 · Why", es: "2 · Por qué" },
  "storage.checkout.sayWhy": { en: "Say why", es: "Explica por qué" },
  "storage.checkout.step3ToJob": { en: "3 · To what job", es: "3 · Para qué trabajo" },
  "storage.checkout.step2WhichJob": { en: "2 · Which job", es: "2 · Cuál trabajo" },
  "storage.checkout.pickJobSuggested": { en: "Pick the job… (most picked are {job})", es: "Elige el trabajo… (la mayoría de lo elegido es de {job})" },
  "storage.checkout.pickJob": { en: "Pick the job…", es: "Elige el trabajo…" },
  "storage.checkout.use": { en: "Use {job}", es: "Usar {job}" },
  "storage.checkout.mismatched.one": {
    en: "{n} of these was tagged for a different job ({list}).",
    es: "{n} de estos estaba etiquetado para otro trabajo ({list}).",
  },
  "storage.checkout.mismatched.many": {
    en: "{n} of these were tagged for a different job ({list}).",
    es: "{n} de estos estaban etiquetados para otro trabajo ({list}).",
  },
  "storage.checkout.splitHint": { en: "Sometimes that's the job — this is a heads-up, not a stop.", es: "A veces así es el trabajo — esto es un aviso, no un alto." },
  "storage.checkout.settingAside": { en: "Setting aside…", es: "Apartando…" },
  "storage.checkout.setAsideN": { en: "Set aside {n}", es: "Apartar {n}" },
  "storage.checkout.checkingOut": { en: "Checking out…", es: "Sacando…" },
  "storage.checkout.checkOutN": { en: "Check out {n}", es: "Sacar {n}" },
  "storage.checkout.setAside.one": { en: "{n} package set aside for the job", es: "{n} paquete apartado para el trabajo" },
  "storage.checkout.setAside.many": { en: "{n} packages set aside for the job", es: "{n} paquetes apartados para el trabajo" },
  "storage.checkout.noBayYet": { en: "This job has no bay yet — try again; the app makes one on first use.", es: "Este trabajo todavía no tiene bahía — inténtalo de nuevo; la app crea una la primera vez que se usa." },
  "storage.checkout.checkedOut.one": { en: "{n} package checked out.", es: "{n} paquete sacado." },
  "storage.checkout.checkedOut.many": { en: "{n} packages checked out.", es: "{n} paquetes sacados." },

  // lib/warehouse/sendToSite.ts (SendToSite.tsx). leftoverBlock stays
  // English-only on purpose — see the comment on it in the source.
  "warehouse.sendToSite.windowMark": { en: "Window {mark}", es: "Ventana {mark}" },
  "warehouse.sendToSite.loosePieces": { en: "Loose pieces (no window number)", es: "Piezas sueltas (sin número de ventana)" },
  "warehouse.sendToSite.aBox": { en: "a box", es: "una caja" },
  "warehouse.sendToSite.notInBoxYet": { en: "not in a box yet", es: "todavía sin caja" },
  "warehouse.sendToSite.nothingPicked": { en: "Nothing picked to go.", es: "No se eligió nada para enviar." },
  "warehouse.sendToSite.moveUnit.one": { en: "Move {n} unit ({pieces} {pieceWord}) to the job site", es: "Mover {n} unidad ({pieces} {pieceWord}) al sitio del trabajo" },
  "warehouse.sendToSite.moveUnit.many": { en: "Move {n} units ({pieces} {pieceWord}) to the job site", es: "Mover {n} unidades ({pieces} {pieceWord}) al sitio del trabajo" },
  "warehouse.sendToSite.pieceWord.one": { en: "piece", es: "pieza" },
  "warehouse.sendToSite.pieceWord.many": { en: "pieces", es: "piezas" },
  "warehouse.sendToSite.moveLoose.one": { en: "Move {pieces} loose piece to the job site", es: "Mover {pieces} pieza suelta al sitio del trabajo" },
  "warehouse.sendToSite.moveLoose.many": { en: "Move {pieces} loose pieces to the job site", es: "Mover {pieces} piezas sueltas al sitio del trabajo" },
  "warehouse.sendToSite.stay.one": { en: "{n} stays", es: "{n} se queda" },
  "warehouse.sendToSite.stay.many": { en: "{n} stay", es: "{n} se quedan" },

  // pages/storage/SendToSite.tsx
  "storage.sendToSite.h1": { en: "{job} → job site", es: "{job} → sitio del trabajo" },
  "storage.sendToSite.onSite.one": { en: "{n} package on the job site.", es: "{n} paquete en el sitio del trabajo." },
  "storage.sendToSite.onSite.many": { en: "{n} packages on the job site.", es: "{n} paquetes en el sitio del trabajo." },
  "storage.sendToSite.movedBoneyard.one": { en: "{n} package moved to the Boneyard.", es: "{n} paquete movido al Boneyard." },
  "storage.sendToSite.movedBoneyard.many": { en: "{n} packages moved to the Boneyard.", es: "{n} paquetes movidos al Boneyard." },
  "storage.sendToSite.finalized": { en: "{job} finalized. It now lives in warehouse history.", es: "{job} finalizado. Ahora vive en el historial del almacén." },
  "storage.sendToSite.jobFallback": { en: "Job", es: "Trabajo" },
  "storage.sendToSite.reopened": { en: "{job} is back on the warehouse page.", es: "{job} está de vuelta en la página del almacén." },
  "storage.sendToSite.notFound": { en: "Job not found.", es: "Trabajo no encontrado." },
  "storage.sendToSite.finalizedAria": { en: "Finalized", es: "Finalizado" },
  "storage.sendToSite.finalizedOn": { en: "Unit movement finalized on {date}.", es: "Movimiento de unidades finalizado el {date}." },
  "storage.sendToSite.hiddenListed.pre": { en: "Hidden from the warehouse page; listed in ", es: "Oculto de la página del almacén; aparece en el " },
  "storage.sendToSite.hiddenListed.link": { en: "warehouse history", es: "historial del almacén" },
  // i18n-same-on-purpose: punctuation around an interpolated value, no words of its own.
  "storage.sendToSite.hiddenListed.post": { en: ".", es: "." },
  "storage.sendToSite.onSiteCount.one": { en: "{n} piece on the job site.", es: "{n} pieza en el sitio del trabajo." },
  "storage.sendToSite.onSiteCount.many": { en: "{n} pieces on the job site.", es: "{n} piezas en el sitio del trabajo." },
  "storage.sendToSite.reopening": { en: "Reopening…", es: "Reabriendo…" },
  "storage.sendToSite.reopenButton": { en: "Reopen in the warehouse", es: "Reabrir en el almacén" },
  "storage.sendToSite.foremanReopens": { en: "A foreman can reopen it if something comes back.", es: "Un capataz puede reabrirlo si algo regresa." },
  "storage.sendToSite.unitsHereAria": { en: "Units here", es: "Unidades aquí" },
  "storage.sendToSite.readyToGo": { en: "Here, ready to go", es: "Aquí, listo para salir" },
  "storage.sendToSite.sendAll": { en: "Send all", es: "Enviar todo" },
  "storage.sendToSite.keepAll": { en: "Keep all", es: "Quedarse con todo" },
  "storage.sendToSite.loading": { en: "Loading…", es: "Cargando…" },
  "storage.sendToSite.nothingHere": { en: "Nothing of {job} is in the warehouse right now.", es: "Ahora mismo nada de {job} está en el almacén." },
  "storage.sendToSite.alreadyOnSite.one": { en: "{n} piece already on the job site.", es: "{n} pieza ya está en el sitio del trabajo." },
  "storage.sendToSite.alreadyOnSite.many": { en: "{n} pieces already on the job site.", es: "{n} piezas ya están en el sitio del trabajo." },
  "storage.sendToSite.goesToSite": { en: "{label} goes to the job site", es: "{label} va al sitio del trabajo" },
  "storage.sendToSite.piece.one": { en: "{n} piece", es: "{n} pieza" },
  "storage.sendToSite.piece.many": { en: "{n} pieces", es: "{n} piezas" },
  "storage.sendToSite.goes": { en: "goes", es: "va" },
  "storage.sendToSite.stays": { en: "stays", es: "se queda" },
  "storage.sendToSite.moving": { en: "Moving…", es: "Moviendo…" },
  "storage.sendToSite.moveToSite": { en: "Move to job site", es: "Mover al sitio del trabajo" },
  "storage.sendToSite.hint": {
    en: "Untick a unit to keep it here. Moving writes the same \"checked out\" line a check-out does, with the reason \"{reason}\"; each line can be undone from the unit card.",
    es: "Destilda una unidad para quedártela aquí. Mover escribe la misma línea de \"sacado\" que un check-out, con la razón \"{reason}\"; cada línea se puede deshacer desde la tarjeta de la unidad.",
  },
  "storage.sendToSite.finishUpAria": { en: "Finish up", es: "Terminar" },
  "storage.sendToSite.finishUp": { en: "Finish up", es: "Terminar" },
  "storage.sendToSite.nothingLeft": { en: "Nothing of {job} is left in the warehouse.", es: "No queda nada de {job} en el almacén." },
  "storage.sendToSite.moveToBoneyard": { en: "Move leftovers to the Boneyard", es: "Mover lo que sobra al Boneyard" },
  "storage.sendToSite.finalizeHintLead": { en: "Close this job's material story; it moves to warehouse history", es: "Cerrar la historia de material de este trabajo; se mueve al historial del almacén" },
  "storage.sendToSite.finalizeHintNotLead": { en: "A foreman or above finalizes", es: "Un capataz o superior finaliza" },
  "storage.sendToSite.finalizing": { en: "Finalizing…", es: "Finalizando…" },
  "storage.sendToSite.finalizeButton": { en: "Unit Movement Finalized", es: "Movimiento de unidades finalizado" },
  "storage.sendToSite.foremanFinalizes": { en: "A foreman or above finalizes a job.", es: "Un capataz o superior finaliza un trabajo." },
  "storage.sendToSite.openLedger": { en: "Open {job}'s materials ledger", es: "Abrir el registro de materiales de {job}" },

  // pages/storage/ContainerViewer.tsx
  "storage.container3d.warehouse": { en: "Warehouse", es: "Almacén" },
  "storage.container3d.title": { en: "{name} in 3D", es: "{name} en 3D" },
  "storage.container3d.containerFallback": { en: "Container", es: "Caja" },
  "storage.container3d.zoneGlows": { en: "{serial} — the {zone} zone glows", es: "{serial} — la zona {zone} se ilumina" },
  "storage.container3d.noArea": { en: "{serial} — no area recorded; a foreman can point at it from the package page", es: "{serial} — no hay zona registrada; un capataz puede marcarla desde la página del paquete" },
  "storage.container3d.noShell": { en: "This container has no 3D shell yet — a supervisor creates one from its page.", es: "Esta caja todavía no tiene modelo 3D — un supervisor crea uno desde su página." },
  "storage.container3d.compassZones": { en: "Compass zones: north is the back-left of the drawing.", es: "Zonas de brújula: el norte es la esquina de atrás a la izquierda del dibujo." },
  "storage.container3d.doorEndFront": { en: "The door end is the front.", es: "El lado de la puerta es el frente." },
  "storage.container3d.orbitHint": {
    en: "Drag to orbit · pinch or scroll to zoom. Nothing here can be moved — this is the map, not the pen.",
    es: "Arrastra para girar · pellizca o desplázate para acercar. Nada aquí se puede mover — esto es el mapa, no el lápiz.",
  },
  "storage.container3d.open": { en: "Open {name}", es: "Abrir {name}" },

  // lib/warehouse/deliveryWizard.ts (LogDelivery.tsx's hand-entry wizard).
  "storage.logDelivery.problem.needOneJob": { en: "Log at least one job's material.", es: "Registra el material de al menos un trabajo." },
  "storage.logDelivery.problem.tooManyJobs": { en: "A delivery covers at most {max} jobs.", es: "Una entrega cubre como máximo {max} trabajos." },
  "storage.logDelivery.problem.jobN": { en: "Job {n}", es: "Trabajo {n}" },
  "storage.logDelivery.problem.pickOrType": { en: "{label}: pick a job or type its name.", es: "{label}: elige un trabajo o escribe su nombre." },
  "storage.logDelivery.problem.addOneSet": { en: "{label}: add at least one set.", es: "{label}: agrega al menos un set." },
  "storage.logDelivery.problem.atMostSets": { en: "{label}: at most {max} sets in one delivery.", es: "{label}: como máximo {max} sets en una entrega." },
  "storage.logDelivery.problem.needsMark": { en: "{label}, set {n}: every set needs a mark (like 16 or 13A).", es: "{label}, set {n}: todo set necesita una marca (como 16 o 13A)." },
  "storage.logDelivery.problem.listedTwice": { en: "{label}: mark #{mark} is listed twice.", es: "{label}: la marca #{mark} está repetida." },
  "storage.logDelivery.problem.clonesRange": { en: "{label}, #{mark}: identical clones go 1 to {max} at a time.", es: "{label}, #{mark}: los clones idénticos van de 1 a {max} a la vez." },
  "storage.logDelivery.problem.packagesRange": { en: "{label}, #{mark}: a set arrives as 1 to {max} packages.", es: "{label}, #{mark}: un set llega en 1 a {max} paquetes." },
  "storage.logDelivery.problem.nameCrate": { en: "{label}, #{mark}: name the crate (like Crate 1).", es: "{label}, #{mark}: nombra el crate (como Crate 1)." },
  "storage.logDelivery.problem.cratePiecesRange": { en: "{label}, #{mark}: crate pieces are 1 to {max}.", es: "{label}, #{mark}: las piezas del crate van de 1 a {max}." },
  "storage.logDelivery.describe.clones": { en: " · ×{n} identical", es: " · ×{n} idénticos" },
  "storage.logDelivery.describe.each": { en: " each", es: " cada uno" },
  "storage.logDelivery.describe.door": { en: "Door", es: "Puerta" },
  "storage.logDelivery.describe.window": { en: "Window", es: "Ventana" },
  "storage.logDelivery.describe.base.one": { en: "#{mark} · {kind}{clones} · {n} package{each}", es: "#{mark} · {kind}{clones} · {n} paquete{each}" },
  "storage.logDelivery.describe.base.many": { en: "#{mark} · {kind}{clones} · {n} packages{each}", es: "#{mark} · {kind}{clones} · {n} paquetes{each}" },
  "storage.logDelivery.describe.crate.one": { en: "{base} + {n} piece of {partType}{each} in {crateName}", es: "{base} + {n} pieza de {partType}{each} en {crateName}" },
  "storage.logDelivery.describe.crate.many": { en: "{base} + {n} pieces of {partType}{each} in {crateName}", es: "{base} + {n} piezas de {partType}{each} en {crateName}" },
  "storage.logDelivery.describe.aCrate": { en: "a crate", es: "un crate" },

  // pages/storage/LogDelivery.tsx
  "storage.logDelivery.warehouse": { en: "Warehouse", es: "Almacén" },
  "storage.logDelivery.title": { en: "Log a delivery", es: "Registrar una entrega" },
  "storage.logDelivery.howTracked": { en: "How will this truck be tracked?", es: "¿Cómo se va a rastrear este camión?" },
  "storage.logDelivery.withStickers": { en: "With QR stickers — scan and tag at the tailgate", es: "Con etiquetas QR — escanea y etiqueta en la compuerta" },
  "storage.logDelivery.withoutStickers": { en: "Without stickers — prepare the list, check the truck against it", es: "Sin etiquetas — prepara la lista, revisa el camión contra ella" },
  "storage.logDelivery.withoutStickersHint": {
    en: "Entering by hand builds a standby list of expected packages, each with its own ID. At the truck you check material off against the list; labels print whenever the printer shows up.",
    es: "Escribirlo a mano crea una lista de espera de paquetes esperados, cada uno con su propio ID. En el camión marcas el material contra la lista; las etiquetas se imprimen cuando llegue la impresora.",
  },
  "storage.logDelivery.loggedTitle": { en: "Delivery logged", es: "Entrega registrada" },
  "storage.logDelivery.standbySaved.one": { en: "The standby list is saved — {n} expected package.", es: "La lista de espera está guardada — {n} paquete esperado." },
  "storage.logDelivery.standbySaved.many": { en: "The standby list is saved — {n} expected packages.", es: "La lista de espera está guardada — {n} paquetes esperados." },
  "storage.logDelivery.unfiled": {
    en: "{n} belong to jobs that aren't built yet — they still check in and store like everything else, and a supervisor has the job on the Issues list.",
    es: "{n} pertenecen a trabajos que todavía no están creados — igual se registran y se guardan como todo lo demás, y un supervisor tiene el trabajo en la lista de reportes.",
  },
  "storage.logDelivery.whenTruckShowsUp": {
    en: "When the truck shows up, open the delivery and check the material off against this list — what arrived, what's missing, and where each box went.",
    es: "Cuando llegue el camión, abre la entrega y marca el material contra esta lista — qué llegó, qué falta, y a dónde fue cada caja.",
  },
  "storage.logDelivery.openDelivery": { en: "Open the delivery — check the truck against it", es: "Abrir la entrega — revisar el camión contra ella" },
  "storage.logDelivery.backToWarehouse": { en: "Back to the warehouse", es: "Volver al almacén" },
  "storage.logDelivery.logAnother": { en: "Log another delivery", es: "Registrar otra entrega" },
  "storage.logDelivery.reviewGreeting": { en: "Log a delivery · review", es: "Registrar una entrega · revisión" },
  "storage.logDelivery.handLogged": { en: "Hand-logged delivery", es: "Entrega registrada a mano" },
  "storage.logDelivery.jobNotBuiltYet": { en: "{name} (job not built yet — a supervisor will get it)", es: "{name} (trabajo aún no creado — un supervisor lo recibirá)" },
  "storage.logDelivery.back": { en: "Back", es: "Atrás" },
  "storage.logDelivery.saving": { en: "Saving…", es: "Guardando…" },
  "storage.logDelivery.saveDelivery": { en: "Save the delivery", es: "Guardar la entrega" },
  "storage.logDelivery.step1Greeting": { en: "Log a delivery · step 1 of 3", es: "Registrar una entrega · paso 1 de 3" },
  "storage.logDelivery.whichJobs": { en: "Which jobs are on this truck?", es: "¿Qué trabajos vienen en este camión?" },
  "storage.logDelivery.restored.pre": { en: "Picked your unsaved delivery back up (from ", es: "Se recuperó tu entrega sin guardar (de las " },
  "storage.logDelivery.restored.mid": { en: ") — keep going, or ", es: ") — sigue, o " },
  // i18n-same-on-purpose: punctuation around an interpolated value, no words of its own.
  "storage.logDelivery.restored.post": { en: ".", es: "." },
  "storage.logDelivery.startFresh": { en: "start fresh", es: "empezar de nuevo" },
  "storage.logDelivery.deliveryName": { en: "Delivery name (optional)", es: "Nombre de la entrega (opcional)" },
  "storage.logDelivery.deliveryNamePlaceholder": { en: "e.g. Tech Ridge truck, Aug 22", es: "ej. camión de Tech Ridge, 22 de agosto" },
  "storage.logDelivery.jobNotInApp": { en: "— job not in the app yet —", es: "— trabajo aún no está en la app —" },
  "storage.logDelivery.typeJobName": { en: "Type the job's name", es: "Escribe el nombre del trabajo" },
  "storage.logDelivery.remove": { en: "Remove", es: "Quitar" },
  "storage.logDelivery.anotherJob": { en: "+ Another job ({n}/{max})", es: "+ Otro trabajo ({n}/{max})" },
  "storage.logDelivery.nextSets": { en: "Next: the sets", es: "Siguiente: los sets" },
  "storage.logDelivery.jobNotInAppHint": {
    en: "A job that isn't in the app yet doesn't stop the unload — type its name, keep going, and a supervisor gets an Issue to build it.",
    es: "Un trabajo que todavía no está en la app no detiene la descarga — escribe su nombre, sigue adelante, y un supervisor recibe un reporte para crearlo.",
  },
  "storage.logDelivery.step2Greeting": { en: "Log a delivery · step 2 of 3", es: "Registrar una entrega · paso 2 de 3" },
  "storage.logDelivery.setsOnTruck": { en: "Sets on the truck", es: "Sets en el camión" },
  "storage.logDelivery.setsExplain": {
    en: "A set is everything for one window or door — its frame, glass, hardware. Count its packages; if some pieces ride in a crate, say how many and name the crate. Six identical windows? Turn on Clones and say how many — every unit gets the same packages and crate pieces. Which box is which part gets labeled later, when you can read the boxes.",
    es: "Un set es todo lo de una ventana o puerta — su marco, vidrio, herrajes. Cuenta sus paquetes; si algunas piezas van en un crate, di cuántas y nombra el crate. ¿Seis ventanas idénticas? Activa Clones y di cuántas — cada unidad recibe los mismos paquetes y piezas de crate. Cuál caja es cuál pieza se etiqueta después, cuando puedas leer las cajas.",
  },
  "storage.logDelivery.markPlaceholder": { en: "Mark, e.g. 16", es: "Marca, ej. 16" },
  "storage.logDelivery.markAria": { en: "Mark", es: "Marca" },
  "storage.logDelivery.packages": { en: "Packages", es: "Paquetes" },
  "storage.logDelivery.howManyPackages": { en: "How many packages", es: "Cuántos paquetes" },
  "storage.logDelivery.identical": { en: "Identical", es: "Idénticos" },
  "storage.logDelivery.howManyIdentical": { en: "How many identical", es: "Cuántos idénticos" },
  "storage.logDelivery.clonesOff": { en: "Clones off", es: "Desactivar clones" },
  "storage.logDelivery.addClones": { en: "+ Clones (identical units)", es: "+ Clones (unidades idénticas)" },
  "storage.logDelivery.crateNamePlaceholder": { en: "Crate name, e.g. Crate 1", es: "Nombre del crate, ej. Crate 1" },
  "storage.logDelivery.crateNameAria": { en: "Crate name", es: "Nombre del crate" },
  "storage.logDelivery.piecesInIt": { en: "Pieces in it", es: "Piezas adentro" },
  "storage.logDelivery.piecesInCrateAria": { en: "Pieces in the crate", es: "Piezas en el crate" },
  "storage.logDelivery.noCrate": { en: "No crate", es: "Sin crate" },
  "storage.logDelivery.addPiecesInCrate": { en: "+ Pieces in a crate", es: "+ Piezas en un crate" },
  "storage.logDelivery.removeSet": { en: "Remove set", es: "Quitar set" },
  "storage.logDelivery.anotherSet": { en: "+ Another set ({n}/{max})", es: "+ Otro set ({n}/{max})" },
  "storage.logDelivery.nextReview": { en: "Next: review", es: "Siguiente: revisión" },

  // pages/AskInfinity.tsx — the UI chrome only. The knowledge base itself
  // (lib/knowledge.ts, lib/brain/*) and its written answers stay English:
  // translating a keyword-matched install-knowledge corpus is a separate,
  // much bigger effort than this UI sweep.
  "ask.greeting": {
    en: "Hey — ask me anything about a window type, a term, or how we install. Answers come from our own notes, on this phone, so they work with no signal.",
    es: "Hola — pregúntame lo que sea sobre un tipo de ventana, un término, o cómo instalamos. Las respuestas vienen de nuestras propias notas, en este teléfono, así que funcionan sin señal.",
  },
  "ask.suggestion.singleHung": { en: "Single hung tips", es: "Consejos de single hung" },
  "ask.suggestion.flashing": { en: "What is flashing?", es: "¿Qué es el flashing?" },
  "ask.suggestion.caulkBottom": { en: "Do I caulk the bottom?", es: "¿Sello la parte de abajo?" },
  "ask.suggestion.drainSide": { en: "Which side does the drain face?", es: "¿Hacia qué lado va el drenaje?" },
  "ask.suggestion.schedule": { en: "What's on our schedule?", es: "¿Qué hay en nuestro horario?" },
  "ask.suggestion.nextUnit": { en: "My next unit", es: "Mi próxima unidad" },
  "ask.somethingWentWrong": { en: "Something went wrong. Try again.", es: "Algo salió mal. Intenta de nuevo." },
  "ask.title": { en: "Company brain", es: "Cerebro de la empresa" },
  "ask.back": { en: "Back", es: "Atrás" },
  "ask.from": { en: "From: {source}", es: "De: {source}" },
  "ask.alsoWrittenDown": { en: "Also written down:", es: "También anotado:" },
  "ask.sources": { en: "Sources: {list}", es: "Fuentes: {list}" },
  "ask.inputPlaceholder": { en: "Ask about a window, a term, or how-to…", es: "Pregunta sobre una ventana, un término, o cómo hacer algo…" },
  "ask.send": { en: "Send", es: "Enviar" },

  // lib/install/jobModelCache.ts — describeAge (JobModelViewer.tsx).
  "jobModel.age.justNow": { en: "just now", es: "justo ahora" },
  "jobModel.age.minAgo": { en: "{n} min ago", es: "hace {n} min" },
  "jobModel.age.hrAgo": { en: "{n} hr ago", es: "hace {n} h" },
  "jobModel.age.dayAgo.one": { en: "{n} day ago", es: "hace {n} día" },
  "jobModel.age.dayAgo.many": { en: "{n} days ago", es: "hace {n} días" },

  // pages/install/JobModelViewer.tsx
  "jobModel.unitFallback": { en: "Unit", es: "Unidad" },
  "jobModel.jobFallback": { en: "Job", es: "Trabajo" },
  "jobModel.modelFallback": { en: "3D model", es: "modelo 3D" },
  "jobModel.title": { en: "{name} in 3D", es: "{name} en 3D" },
  "jobModel.glowsBelow": { en: "Window {code} glows below", es: "La ventana {code} se ilumina abajo" },
  "jobModel.loading": { en: "Loading the model…", es: "Cargando el modelo…" },
  "jobModel.noModelYet": { en: "No 3D model yet", es: "Todavía no hay modelo 3D" },
  "jobModel.noModelYetExplain": {
    en: "This job doesn't have a saved Studio model yet. A supervisor builds one from the job's Maps Interactive tab, and it opens here for the whole crew to walk through.",
    es: "Este trabajo todavía no tiene un modelo de Studio guardado. Un supervisor construye uno desde la pestaña de Mapas Interactivos del trabajo, y se abre aquí para que todo el equipo lo recorra.",
  },
  "jobModel.noSignal": { en: "No signal — showing this phone's saved copy", es: "Sin señal — mostrando la copia guardada de este teléfono" },
  "jobModel.noSignalFrom": { en: ", from {age}", es: ", de hace {age}" },
  "jobModel.assignOn": { en: "Assign: on", es: "Asignar: activado" },
  "jobModel.assign": { en: "Assign", es: "Asignar" },
  "jobModel.picked": { en: "{n} picked", es: "{n} elegidos" },
  "jobModel.installer": { en: "Installer", es: "Instalador" },
  "jobModel.chooseInstaller": { en: "Choose an installer…", es: "Elige un instalador…" },
  "jobModel.assigning": { en: "Assigning…", es: "Asignando…" },
  "jobModel.findInWarehouse": { en: "Find it in the warehouse", es: "Encontrarlo en el almacén" },
  "jobModel.installAlt": { en: "Install", es: "Instalación" },
  "jobModel.seeOnRecord": { en: "See all on the Unit Record", es: "Ver todo en el registro de la unidad" },
  "jobModel.assignHint": { en: "Tap units to pick them, in order · then choose an installer and Assign.", es: "Toca las unidades para elegirlas, en orden · luego elige un instalador y Asignar." },
  "jobModel.orbitHint": {
    en: "Drag to orbit · pinch or scroll to zoom · tap a window or door for its size. Nothing here can be moved — this is the map, not the pen.",
    es: "Arrastra para girar · pellizca o desplázate para acercar · toca una ventana o puerta para ver su tamaño. Nada aquí se puede mover — esto es el mapa, no el lápiz.",
  },
  "jobModel.assigned.one": { en: "{n} unit assigned.", es: "{n} unidad asignada." },
  "jobModel.assigned.many": { en: "{n} units assigned.", es: "{n} unidades asignadas." },

  // components/warehouse/JobPackagesPanel.tsx (job page's Warehouse tab).
  "jobPackages.title": { en: "This job's packages", es: "Los paquetes de este trabajo" },
  "jobPackages.onHand": { en: "{n} on hand", es: "{n} en existencia" },
  "jobPackages.onTheWay": { en: "{n} on the way", es: "{n} en camino" },
  "jobPackages.checkedOut": { en: "{n} checked out", es: "{n} sacados" },
  "jobPackages.nothingTagged": { en: "Nothing tagged for this job yet.", es: "Todavía no hay nada etiquetado para este trabajo." },
  "jobPackages.setAsideCheckOut": { en: "Set aside / check out", es: "Apartar / sacar" },
  "jobPackages.arrivalCheck": { en: "Arrival check", es: "Revisión de llegada" },

  // components/warehouse/PlanPackagesPanel.tsx (job page's Warehouse tab).
  "planPackages.burned.one": { en: "{n} label burned. Destroy the paper — anything still wearing one scans as nothing.", es: "{n} etiqueta quemada. Destruye el papel — cualquier cosa que todavía la lleve puesta escanea como nada." },
  "planPackages.burned.many": { en: "{n} labels burned. Destroy the paper — anything still wearing one scans as nothing.", es: "{n} etiquetas quemadas. Destruye el papel — cualquier cosa que todavía las lleve puestas escanea como nada." },
  "planPackages.alreadyHasAll": { en: "Window {mark} already has all {total} labels.", es: "La ventana {mark} ya tiene las {total} etiquetas." },
  "planPackages.minted.one": { en: "{n} label minted for window {mark}.", es: "{n} etiqueta emitida para la ventana {mark}." },
  "planPackages.minted.many": { en: "{n} labels minted for window {mark}.", es: "{n} etiquetas emitidas para la ventana {mark}." },
  "planPackages.title": { en: "Plan packages & labels", es: "Planear paquetes y etiquetas" },
  "planPackages.printAll": { en: "Print all on-the-way labels ({n})", es: "Imprimir todas las etiquetas en camino ({n})" },
  "planPackages.cancelBurn": { en: "Cancel burn", es: "Cancelar quema" },
  "planPackages.burnLabels": { en: "Burn labels…", es: "Quemar etiquetas…" },
  "planPackages.explain": {
    en: "Say how many packages a window arrives as, and the labels exist before the truck does — already carrying the job, the window and “2 of 4”. At the truck, receiving is sticking the label on and tapping Arrived. If the maker's own label says a different count, the maker wins — a foreman burns the wrong stickers, then anybody mints the right number.",
    es: "Di en cuántos paquetes llega una ventana, y las etiquetas existen antes que el camión — ya con el trabajo, la ventana y “2 de 4”. En el camión, recibir es pegar la etiqueta y tocar Llegó. Si la etiqueta del fabricante dice un número distinto, gana el fabricante — un capataz quema las etiquetas incorrectas, y luego cualquiera emite el número correcto.",
  },
  "planPackages.burnKills": { en: "Burning kills a label for good.", es: "Quemar mata una etiqueta para siempre." },
  "planPackages.burnExplain": {
    en: "Only labels whose material never arrived can burn. The serial dies, the part slot reopens for a fresh label, and the paper must be destroyed — anything still wearing a burned sticker will scan as nothing. A sticker on a real package gets a Reprint instead, from its package page.",
    es: "Solo se pueden quemar etiquetas cuyo material nunca llegó. El número de serie muere, el espacio de la pieza se abre de nuevo para una etiqueta nueva, y el papel debe destruirse — cualquier cosa que todavía lleve una etiqueta quemada escaneará como nada. Una etiqueta en un paquete real recibe una Reimpresión en su lugar, desde su página.",
  },
  "planPackages.burning": { en: "Burning…", es: "Quemando…" },
  "planPackages.burnN.one": { en: "Burn {n} label — no way back", es: "Quemar {n} etiqueta — sin vuelta atrás" },
  "planPackages.burnN.many": { en: "Burn {n} labels — no way back", es: "Quemar {n} etiquetas — sin vuelta atrás" },
  "planPackages.noWindows": {
    en: "No windows on this job's schedule yet — they come from the plans at spec review.",
    es: "Todavía no hay ventanas en el horario de este trabajo — vienen de los planos en la revisión de spec.",
  },
  "planPackages.disagree": { en: "labels disagree on the count — settle that first", es: "las etiquetas no coinciden en el número — resuelve eso primero" },
  "planPackages.noCountYet": { en: "no package count declared yet", es: "todavía sin número de paquetes declarado" },
  "planPackages.arrivesAs": { en: "arrives as {declared} · {here} here", es: "llega en {declared} · {here} aquí" },
  "planPackages.onTheWay": { en: "{n} on the way", es: "{n} en camino" },
  "planPackages.howMany": { en: "How many?", es: "¿Cuántos?" },
  "planPackages.howManyAria": { en: "How many packages for window {mark}", es: "Cuántos paquetes para la ventana {mark}" },
  "planPackages.suggestedFromModel": { en: "(suggested from the model)", es: "(sugerido por el modelo)" },
  "planPackages.mint": { en: "Mint", es: "Emitir" },
  // Job facts on the unit sheet (S5, ADR-0011): the read-only card every
  // crew role sees under the spec card. Field labels reuse buildFacts.field.*
  // and the pick-list labels above — these are only what the write-side card
  // never needed: the empty state, the fastener spacing phrase, and the
  // sentence for when a unit's own spec overrides the job's set depth.
  "unitFacts.empty": {
    en: "No job facts yet. Ask your foreman.",
    es: "Todavía no hay datos del trabajo. Pregúntale a tu capataz.",
  },
  "unitFacts.showMe": { en: "Show me", es: "Muéstrame" },
  "unitFacts.fastener.every": { en: "every {spacing}", es: "cada {spacing}" },
  "unitFacts.setDepth.specWins": {
    en: "This unit's spec says {value}; it wins.",
    es: "La ficha de esta unidad dice {value}; esa es la que vale.",
  },
} satisfies Record<string, CatalogEntry>;

/** Every key the catalog knows. Later slices widen this by adding entries. */
export type TKey = keyof typeof CATALOG;
