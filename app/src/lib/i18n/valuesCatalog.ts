// Monthly core-value reviews phrasebook (2026-10-03 build). Same contract as
// workCatalog.ts/designCatalog.ts: a lazy-loaded phrasebook that registers
// itself into the live catalog the moment its chunk loads, so `t("values.…")`
// is type-checked like every other key without costing the entry chunk
// anything. Every component under pages/values/ and components/values/
// imports this file (directly or via the page) for that side effect.
//
// RUBRIC TEXT IS NOT DUPLICATED HERE. The eight values' definitions,
// briefings, criteria and anchors come from ../values/rubric.ts (English,
// pinned-source, see that file's provenance note) with their Spanish
// translation in VALUE_RUBRICS_ES below — kept beside the UI copy because a
// translation is itself UI text, not schema. The reviewed Spanish wording is
// a translation of the pinned English draft, not an independently authored
// rubric; the same "drafts for red-pen" caveat applies in both languages.
import { useCallback } from "react";
import type { TKey as AppKey } from "./catalog";
import { registerCatalog } from "./catalog";
import { translate, type CatalogEntry, type TVars } from "./translate";
import { useLanguage } from "./context";
import type { CoreValueSlug } from "../values/rubric";

export const VALUES_CATALOG = {
  "values.pageTitle": { en: "Monthly values review", es: "Revisión mensual de valores" },
  "values.intro.heading": { en: "This month's review", es: "La revisión de este mes" },
  "values.intro.body": {
    en: "Once a month you score a few people you worked beside — eight values, one score each, 1 to 10. It takes a minute per person. Nobody you score sees who gave which score or what you wrote; only the owner does.",
    es: "Una vez al mes calificas a algunas personas con las que trabajaste: ocho valores, una puntuación cada uno, de 1 a 10. Toma un minuto por persona. Nadie a quien califiques ve quién dio qué puntuación ni lo que escribiste; solo el dueño lo ve.",
  },
  "values.confidential": {
    en: "Confidential, not anonymous: the owner can see your name on this review. The person you're scoring never does.",
    es: "Confidencial, no anónimo: el dueño puede ver tu nombre en esta revisión. La persona que calificas nunca lo verá.",
  },
  "values.tasks.heading": { en: "People to review", es: "Personas por calificar" },
  "values.tasks.empty": { en: "Nothing owed right now.", es: "No debes nada por ahora." },
  "values.tasks.pending": { en: "Pending", es: "Pendiente" },
  "values.tasks.done": { en: "Submitted", es: "Enviado" },
  // One/many split, caller picks the key by count — interpolate() has no
  // plural rule of its own (same shape as mywork.newUnits.one/.many).
  "values.tasks.owedCount.one": { en: "{n} review owed", es: "{n} revisión pendiente" },
  "values.tasks.owedCount.many": { en: "{n} reviews owed", es: "{n} revisiones pendientes" },
  "values.tasks.allDone": { en: "All caught up", es: "Todo al día" },
  "values.tasks.loading": { en: "Checking reviews…", es: "Consultando revisiones…" },
  "values.tasks.unavailable": { en: "Reviews are unavailable right now. Try again when connected.", es: "Las revisiones no están disponibles ahora. Inténtalo de nuevo cuando tengas conexión." },
  "values.form.back": { en: "Back to list", es: "Volver a la lista" },
  "values.form.subjectHeading": { en: "Reviewing {name}", es: "Calificando a {name}" },
  "values.form.period": { en: "For {month}", es: "Para {month}" },
  "values.form.scoreLabel": { en: "Score 1–10", es: "Puntuación 1–10" },
  "values.form.unscored": { en: "Not yet scored", es: "Aún sin calificar" },
  "values.form.anchor.low": { en: "1–3", es: "1–3" },
  "values.form.anchor.mid": { en: "4–6", es: "4–6" },
  "values.form.anchor.high": { en: "7–10", es: "7–10" },
  "values.form.comment.label": { en: "Overall comment (optional)", es: "Comentario general (opcional)" },
  "values.form.comment.help": {
    en: "About this person's month, not any one value. Up to 2000 characters.",
    es: "Sobre el mes de esta persona, no sobre un valor en particular. Hasta 2000 caracteres.",
  },
  "values.form.submit": { en: "Submit review", es: "Enviar revisión" },
  "values.form.submitting": { en: "Sending…", es: "Enviando…" },
  "values.form.incomplete": {
    en: "Score all eight values before submitting.",
    es: "Califica los ocho valores antes de enviar.",
  },
  "values.form.queued": {
    en: "Saved on this phone — sends when you're back in signal.",
    es: "Guardado en este teléfono: se envía cuando vuelva la señal.",
  },
  "values.form.loading": { en: "Opening saved review…", es: "Abriendo revisión guardada…" },
  "values.form.saved": { en: "Draft saved on this phone.", es: "Borrador guardado en este teléfono." },
  "values.form.saving": { en: "Saving draft…", es: "Guardando borrador…" },
  "values.form.retrySave": { en: "Retry save", es: "Reintentar guardado" },
  "values.form.saveError": { en: "This phone could not save the review. Check storage and try again.", es: "Este teléfono no pudo guardar la revisión. Revisa el almacenamiento e inténtalo de nuevo." },
  "values.form.accepted": { en: "Review submitted.", es: "Revisión enviada." },
  "values.form.conflict": {
    en: "This review was already submitted and can't be changed.",
    es: "Esta revisión ya fue enviada y no se puede cambiar.",
  },
  "values.form.blocked": { en: "Forge could not accept this review. Open Stuck writes for details or ask the owner for help.", es: "Forge no pudo aceptar esta revisión. Abre Envíos pendientes para ver el estado o pide ayuda al dueño." },
  "values.form.notYours": {
    en: "This review is not assigned to your account.",
    es: "Esta revisión no está asignada a tu cuenta.",
  },
  "values.settings.heading": { en: "My values", es: "Mis valores" },
  "values.settings.help": {
    en: "Your monthly peer review — who you owe, and your own results over time.",
    es: "Tu revisión mensual entre compañeros: a quién le debes y tus propios resultados a través del tiempo.",
  },
  "values.settings.open": { en: "Open reviews", es: "Abrir revisiones" },
  "values.settings.owedBadge.one": { en: "{n} owed", es: "{n} pendiente" },
  "values.settings.owedBadge.many": { en: "{n} owed", es: "{n} pendientes" },
  "values.summary.heading": { en: "Your values over time", es: "Tus valores a través del tiempo" },
  "values.summary.loading": { en: "Loading your results…", es: "Cargando tus resultados…" },
  "values.summary.unavailable": { en: "Your results are unavailable right now.", es: "Tus resultados no están disponibles ahora." },
  "values.summary.windowLabel": {
    en: "{start} through {end}",
    es: "{start} hasta {end}",
  },
  "values.summary.allTime": { en: "All-time", es: "Histórico" },
  "values.summary.self": { en: "Your own score", es: "Tu propia puntuación" },
  "values.summary.suppressed": {
    en: "Not enough reviewers yet",
    es: "Aún no hay suficientes evaluadores",
  },
  "values.summary.quarters.heading": { en: "Frozen quarterly ratings", es: "Calificaciones trimestrales congeladas" },
  "values.summary.quarters.empty": { en: "No quarter has closed yet.", es: "Aún no ha cerrado ningún trimestre." },
  "values.owner.heading": { en: "Owner review matrix", es: "Matriz de revisión del dueño" },
  "values.owner.periodLabel": { en: "Scoring {month}", es: "Calificando {month}" },
  "values.owner.owed": { en: "{count} owed", es: "{count} pendientes" },
  "values.owner.suspended": { en: "Access suspended", es: "Acceso suspendido" },
  "values.owner.accessActive": { en: "Access active", es: "Acceso activo" },
  "values.owner.retired": { en: "Retired", es: "Retirado" },
  "values.owner.notRetired": { en: "Not retired", es: "No retirado" },
  "values.owner.asRater": { en: "As a reviewer this period", es: "Como evaluador este período" },
  "values.owner.assigned": { en: "Assigned", es: "Asignadas" },
  "values.owner.accepted": { en: "Accepted", es: "Aceptadas" },
  "values.owner.late": { en: "Late (of accepted)", es: "Tardías (de las aceptadas)" },
  "values.owner.pending": { en: "Pending", es: "Pendientes" },
  "values.owner.canceled": { en: "Canceled", es: "Canceladas" },
  "values.owner.suspendedReviews": { en: "Suspended reviews", es: "Revisiones suspendidas" },
  "values.owner.coverage": { en: "Received {actual} of {expected} expected reviews", es: "Recibió {actual} de {expected} revisiones esperadas" },
  "values.owner.coverageMissing": { en: "Coverage missing", es: "Falta cobertura" },
  "values.owner.coverageMet": { en: "Coverage met", es: "Cobertura cumplida" },
  "values.owner.lifecycleUnavailable": { en: "Review lifecycle is unavailable right now.", es: "El estado de estas revisiones no está disponible ahora." },
  "values.owner.received": { en: "Received reviews", es: "Revisiones recibidas" },
  "values.owner.schedulerHeading": { en: "Automatic monthly scheduling", es: "Programación mensual automática" },
  "values.owner.schedulerHelp": {
    en: "When on, Forge deals new assignments and freezes closed quarters on its own schedule. Off by default — turn on only after the release checklist is signed off.",
    es: "Cuando está activado, Forge reparte nuevas asignaciones y congela los trimestres cerrados según su propio calendario. Desactivado por defecto: actívalo solo después de aprobar la lista de verificación de lanzamiento.",
  },
  "values.owner.schedulerOn": { en: "Scheduling is ON", es: "La programación está ACTIVADA" },
  "values.owner.schedulerOff": { en: "Scheduling is OFF", es: "La programación está DESACTIVADA" },
  "values.owner.turnOn": { en: "Turn on", es: "Activar" },
  "values.owner.turnOff": { en: "Turn off", es: "Desactivar" },
  "values.owner.ownerOnly": { en: "Owner access only.", es: "Acceso solo para el dueño." },
  "values.owner.unavailable": { en: "Owner review data is unavailable right now.", es: "Los datos de revisión del dueño no están disponibles ahora." },
  "values.owner.toggleError": { en: "Scheduling could not be changed. Try again.", es: "No se pudo cambiar la programación. Inténtalo de nuevo." },
} as const satisfies Record<string, CatalogEntry>;

export type ValuesKey = keyof typeof VALUES_CATALOG;

registerCatalog(VALUES_CATALOG);

export type ValuesT = (key: AppKey | ValuesKey, vars?: TVars) => string;

export function useValuesT(): ValuesT {
  const { lang, t } = useLanguage();
  return useCallback(
    (key: AppKey | ValuesKey, vars?: TVars) =>
      (key as string).startsWith("values.") ? translate(VALUES_CATALOG, lang, key, vars) : t(key as AppKey, vars),
    [lang, t],
  );
}

/**
 * Reviewed Spanish translation of the pinned English rubric
 * (../values/rubric.ts). A translation of Horizon's draft text, not a
 * separately authored Spanish rubric — if the English draft is revised, this
 * needs the same revision.
 */
export const VALUE_RUBRICS_ES: Record<
  CoreValueSlug,
  { title: string; definition: string; briefing: string; criteria: [string, string, string]; anchors: { low: string; mid: string; high: string } }
> = {
  fullsend: {
    title: "Full Send",
    definition: "Vamos con todo, sin reservas.",
    briefing:
      "Full send es ir con todo, sin reservas. Nadie tiene que convencerte de participar en el trabajo: llegas al proyecto con entusiasmo, garra y esfuerzo, y te mantienes comprometido con lo que aceptaste en lugar de retirarte en silencio cuando se pone difícil. Las condiciones adversas son donde se nota el full send: sigues adelante y rindes de todos modos.",
    criteria: [
      "¿Hay que convencerlos para que participen, o atacan el proyecto con entusiasmo, garra y esfuerzo?",
      "¿Están totalmente comprometidos, mirando hacia adelante, sin retractarse de compromisos pasados?",
      "¿Siguen adelante y rinden incluso en situaciones o condiciones adversas?",
    ],
    anchors: {
      low: "Necesita que lo convenzan con frecuencia, evita los retos, abandona compromisos cuando se pone difícil.",
      mid: "Se esfuerza, pero puede dudar o retroceder ante retos reales.",
      high: "Se involucra de forma proactiva con energía y persistencia; impulsa el trabajo incluso en condiciones difíciles sin dudar.",
    },
  },
  ownership: {
    title: "Propiedad",
    definition: "Nos hacemos responsables unos a otros y a nosotros mismos.",
    briefing:
      "Propiedad es hacerte responsable — a ti mismo y a los demás. Cuando algo con tu nombre sale mal, lo asumes, aprendes de ello y lo arreglas en lugar de culpar a otros o evadir. Sientes verdadero orgullo por tu trabajo. Y va más allá de tu lista de tareas: cargas con la responsabilidad personal de la visión, la imagen y el esfuerzo de la empresa, porque la empresa se ve como quien se presentó hoy.",
    criteria: [
      "¿Asumen responsabilidad por sus acciones, incluidos errores y contratiempos, y aprenden en lugar de culpar?",
      "¿Sienten orgullo por su trabajo?",
      "¿Asumen responsabilidad personal por la visión, la imagen y los esfuerzos de la empresa?",
    ],
    anchors: {
      low: "Evita la responsabilidad, suele culpar a otros; poco orgullo por el trabajo; ninguna propiedad sobre la imagen de la empresa.",
      mid: "Reconoce errores pero a veces evade; se enorgullece del trabajo pero no siempre asume el panorama completo.",
      high: "Asume por completo sus acciones y aprende de los errores; gran orgullo por el trabajo; lleva siempre la visión e imagen de la empresa como propias.",
    },
  },
  integrity: {
    title: "Integridad",
    definition: "Hacemos lo correcto, siempre.",
    briefing:
      "Integridad es hacer lo correcto siempre — bajo presión, en un aprieto, sin que nadie mire. Es ser la persona en quien la cuadrilla puede confiar sin dudar: la marca de torque que significa torque, la respuesta que coincide con lo que realmente pasó. Y se multiplica: un carácter fuerte hace mejores a quienes te rodean, porque ven cómo se ve lo correcto y lo imitan.",
    criteria: [
      "¿Hacen lo correcto incluso bajo presión o en circunstancias difíciles?",
      "¿Se puede confiar siempre en ellos, incluso cuando nadie los observa?",
      "¿Su carácter inspira a otros a mejorar?",
    ],
    anchors: {
      low: "Compromete sus valores bajo presión; no siempre se puede confiar en ellos; no eleva a quienes lo rodean.",
      mid: "Intenta hacer lo correcto pero falla en momentos difíciles; generalmente confiable con fallas ocasionales.",
      high: "Siempre hace lo correcto, se confía en ellos sin dudar, y su ejemplo claramente eleva a quienes los rodean.",
    },
  },
  sincerity: {
    title: "Sinceridad",
    definition: "Tenemos comunicación genuina y honesta.",
    briefing:
      "Sinceridad es comunicación genuina y honesta — sin pretensiones, sin actuar por encima de nadie, sin decir una cosa y hacer otra. Dices lo que piensas y cumples lo que dices. Y cuando la conversación difícil, confrontativa y necesaria debe suceder, la tienes — directo, con la persona, de una forma que tú mismo aceptarías.",
    criteria: [
      "¿Son genuinos, o pretenciosos, snob, hipócritas o superficiales?",
      "¿Dicen lo que piensan y cumplen los compromisos que hacen?",
      "¿Están dispuestos a tener las conversaciones difíciles, confrontativas y necesarias?",
    ],
    anchors: {
      low: "Pretencioso o hipócrita; dice una cosa y hace otra; evita conversaciones difíciles y abandona compromisos.",
      mid: "Ocasionalmente inconsistente entre palabras y acciones; puede evitar la confrontación pero generalmente cumple.",
      high: "Genuino en palabra y acción; siempre cumple; entra en la conversación difícil y necesaria cuando hace falta.",
    },
  },
  tribe: {
    title: "Tribu",
    definition: "Fomentamos la seguridad y un sentido de pertenencia.",
    briefing:
      "Tribu es pertenencia — trabajar duro y celebrar duro con la cuadrilla, sin líneas de clase entre nadie. El más nuevo y el líder con más antigüedad están en el mismo nivel. Eres lo suficientemente acogedor para que la gente realmente lo sienta, y cuando importa, cubres a todos. Avanzamos juntos, terminamos juntos.",
    criteria: [
      "¿Trabajan duro Y celebran duro con la cuadrilla?",
      "¿Son lo suficientemente acogedores y abiertos para que no haya distinciones de clase entre ellos y los demás?",
      "¿Cubren a todos?",
    ],
    anchors: {
      low: "Rara vez está presente con el equipo; crea distancia; no cubre a la cuadrilla cuando es difícil.",
      mid: "Trabaja duro y se une a los triunfos, pero a veces mantiene distancia; generalmente cubre al equipo.",
      high: "Trabaja duro, celebra los triunfos de la cuadrilla, accesible sin jerarquía, siempre cubre a todos.",
    },
  },
  growth: {
    title: "Crecimiento",
    definition: "Expandimos nuestra capacidad y desarrollamos talento.",
    briefing:
      "Crecimiento es expandir lo que eres capaz de hacer y desarrollar a las personas a tu alrededor. Buscas desarrollo — capacitación, mentoría, la tarea más difícil — y trabajas honestamente por mejorar en lugar de quedarte cómodo. La prueba de doble vía: ¿puedes enseñar y eres enseñable? Buenas preguntas hechas, buenas preguntas respondidas.",
    criteria: [
      "¿Buscan desarrollo: educación, capacitación, mentoría?",
      "¿Se esfuerzan honestamente por mejorar y apoyan a otros a mejorar?",
      "¿Pueden enseñar y son enseñables? ¿Hacen y responden preguntas de calidad?",
    ],
    anchors: {
      low: "Evita el desarrollo, poco esfuerzo por mejorar, no apoya el crecimiento de otros, le cuesta enseñar o ser enseñado.",
      mid: "Busca desarrollo a veces y se esfuerza por mejorar, pero el apoyo a otros es inconsistente.",
      high: "Persigue activamente el crecimiento propio y del equipo; sobresale enseñando; hace y responde preguntas perspicaces.",
    },
  },
  strategic: {
    title: "Estratégico",
    definition: "Implementamos mejora continua.",
    briefing:
      "Estratégico es mejora continua, hecha de forma deliberada. Ejecutas las jugadas que ya construimos — correctamente, consistentemente — en lugar de improvisar. Llevas el control de tus números y realmente piensas en ellos. Y piensas por delante del trabajo: detectas el proceso defectuoso antes de que le cueste un día a la cuadrilla, y impulsas la mejor forma en lugar de vivir con la rota.",
    criteria: [
      "¿Siguen las estrategias que hemos implementado, correcta y consistentemente?",
      "¿Registran sus datos con precisión y consistencia, y piensan en ellos?",
      "¿Piensan de forma crítica y por adelantado, siempre buscando el proceso defectuoso y la mejor forma?",
    ],
    anchors: {
      low: "Le cuesta seguir el manual; el seguimiento es inconsistente; rara vez piensa por adelantado o cuestiona un proceso roto.",
      mid: "Generalmente sigue la estrategia y registra los datos, pero se le escapan detalles y mejora de forma reactiva, no anticipada.",
      high: "Ejecuta el manual consistentemente, registra con precisión, y encuentra y corrige procesos defectuosos de forma proactiva antes de que nos cuesten.",
    },
  },
  safety: {
    title: "Seguridad",
    definition: "Nos aseguramos intencionalmente del bienestar propio y de los demás.",
    briefing:
      "Seguridad es intencional — el bienestar propio y de todos a tu alrededor, a propósito, todos los días. Protocolos seguidos en serio, riesgos detectados y resueltos antes de convertirse en incidentes. Y es más amplio que los arneses: nunca poner a ti mismo o a otros en una situación cuestionable, ya sea por lo que haces o por lo que dices. Que cada persona llegue segura a casa, todos los días.",
    criteria: [
      "¿Son serios al seguir los protocolos y lineamientos de seguridad, de forma consistente?",
      "¿Qué tan conscientes están de los riesgos potenciales, y actúan para mitigarlos?",
      "¿Alguna vez ponen a sí mismos u otros en situaciones cuestionables, ya sea por acciones o lenguaje?",
    ],
    anchors: {
      low: "Rara vez sigue los protocolos, pasa por alto los riesgos, pone en peligro a otros con acciones o lenguaje.",
      mid: "Generalmente sigue los protocolos y conoce los riesgos, pero no siempre actúa para evitarlos.",
      high: "Sigue los protocolos consistentemente, encuentra y mitiga riesgos de forma proactiva, nunca pone a nadie en peligro, ni en acción ni en lenguaje.",
    },
  },
};
