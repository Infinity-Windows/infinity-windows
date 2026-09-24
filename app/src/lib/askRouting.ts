/** Operational requests need fresh tools, never a keyword/cache answer.
 * `hasContext` keeps a follow-up ("aluminum, second floor") in the same
 * report or field-setup conversation rather than sending it to the offline brain. */
export function isOperationalAsk(question: string, hasContext = false): boolean {
  return hasContext
    || /\b(hours?|timecards?|payroll|export\w*|report\w*|schedule\w*|assign\w*|crew|job\w*|project\w*|progress|summary|summari[sz]\w*|horas?|n[oó]mina|informe\w*|export\w*|horario\w*|asign\w*|cuadrilla|obra\w*|proyecto\w*|resumen|avance)\b/i.test(question)
    || isFieldAsk(question);
}

// "unit"/"unidad" alone is not enough ("my next unit" stays local); it needs
// an action or a who-is-on-it question with it. Spanish forms include the
// common conjugations crews actually say (empieza, terminé, construye, ¿quién…?).
const UNIT = /\b(units?|unidad(es)?)\b/i;
const UNIT_ACTION = /\b(start\w*|stop\w*|clock(ed)?\s+(in|into|on)|finish\w*|done\s+with|build\w*|create\w*|claim\w*|release\w*|help\w*|join\w*|work(ing)?\s+on|who('s|\s+is)|empiez\w*|empez\w*|comienz\w*|comenz\w*|inici\w*|termin\w*|acab\w*|constru\w*|cre[ao]\w*|reclam\w*|liber\w*|ayud\w*|qui[eé]n)/i;
const STANDALONE = /\b(timer|idle\s+time|(what|which)\s+units|new\s+(job|project)|(create|build)\s+(a\s+|the\s+)?(job|project)|temporizador|tiempo\s+muerto|nuev[ao]\s+(obra|proyecto)|(crea|construye)\s+(una\s+|la\s+)?(obra|proyecto))\b/i;

// Writing up what happened so others learn from it (a lesson for review).
const LESSON = /\b(lessons?\s+learn\w*|what\s+happened\s+(on|at|with)|write\s+(up|down)\s+(a\s+|the\s+)?(lesson|issue|problem)|preventive\s+action|lecci[oó]n(es)?\s+aprendida\w*|lo\s+que\s+pas[oó]\s+(en|con)|acci[oó]n\s+preventiva)\b/i;

// A typed first message that only DESCRIBES a unit — "Unit 4 on Smith is a
// bifold door, aluminum, second floor", "La unidad 4 es una puerta plegable" —
// has no action verb, so the rule above never fired: only the Build a unit
// card, a voice memo or an open conversation reached the field tools, and the
// evaluation set (scripts/ask-eval.mjs) reported the gap on PR #641. A NAMED
// unit plus a unit-type or size word is a setup and goes as the same field
// request the card makes. Questions, reports and schedule talk stay out: a
// miss costs one card tap, a false route saves a request nobody meant.
//
// `\b` is ASCII-only in JS, so the Spanish rules use letter lookarounds with
// the `u` flag (the same trick scripts/ask-eval.mjs uses) — "qué" and "fijo"
// would otherwise never end on a boundary.
const WORD = (alts: string) => new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${alts})(?![\p{L}\p{N}])`, "iu");
const NUMBER_WORD = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|diecis[eé]is|diecisiete|dieciocho|diecinueve|veinte";
// The word plus the unit's number or map code: "unit 4", "unidad 12A",
// "unit W-12", "unit #7", "unit cuatro". "unit" on its own names nothing.
const NAMED_UNIT = WORD(String.raw`(?:units?|unidad(?:es)?)\s*(?:#|no\.?\s*|number\s+|n[uú]mero\s+)?(?:[a-z]{0,2}-?\d+[a-z]?|${NUMBER_WORD})`);
// The vocabulary is docs/window-vendor-conventions.md ("Door kinds", slider
// panel notation), Studio's mechanisms and the Spanish the catalog already
// uses for door kinds (corrediza, plegable, abatible). "fixed" and "fijo" only
// count as a type next to a noun or an article — "I fixed unit 4" is a repair.
const UNIT_TYPE = WORD([
  "doors?", "windows?", "bi-?\\s?folds?", "bifolding", "sliders?", "sliding", "casements?", "picture\\s+windows?",
  "(?:single|double)[\\s-]hung", "hung\\s+windows?", "(?:an?|the)\\s+fixed", "fixed\\s+(?:windows?|picture|glass|panels?|lights?|panes?|units?)",
  "awnings?", "multi-?\\s?slides?", "storefronts?", "swing(?:ing)?\\s+doors?", "panels?", "[xo]{2,}",
  "puertas?", "ventanas?", "ventanal(?:es)?", "plegables?", "corredi[sz][ao]s?", "correderas?", "deslizantes?", "abatibles?",
  "guillotina", "francesas?", "toldos?", "proyectantes?", "batientes?", "(?:ventanas?|puertas?|panel(?:es)?|hojas?|una?|el|la|es)\\s+fij[ao]s?",
  "paneles", "hojas?",
].join("|"));
// "the door on unit 4 is leaking" is a problem for the install tips, not a
// unit to set up.
const PROBLEM = WORD("leak\\w*|broken?|crack\\w*|damaged?|scratch\\w*|shatter\\w*|missing|gotea\\w*|rot[ao]s?|quebrad\\w*|rajad\\w*|dañad\\w*");
// A measurement: a number with a length unit, or a number by a number
// ("8 by six", "72x48", "dos metros por uno ochenta", "8' by 6'").
const NUM = String.raw`(?:\d+(?:[.,]\d+)?|${NUMBER_WORD})`;
const LENGTH_MARK = String.raw`(?:ft|feet|foot|in|inch(?:es)?|cm|mm|m|metros?|pies?|pulgadas?|'|"|″|′)`;
const SIZE = new RegExp(String.raw`(?<![\p{L}\p{N}])${NUM}\s*(?:(?:ft|feet|foot|inch(?:es)?|cm|mm|metros?|pies|pulgadas?)(?![\p{L}])|['"″′]|${LENGTH_MARK}?\s*(?:by|x|×|por)\s*${NUM}(?![\p{L}\p{N}]))`, "iu");
// "what's the size of unit 4?", "Is unit 4 a slider", "¿Cómo instalo la
// puerta de la unidad 4?" — a question about a unit is not a setup.
const QUESTION = /[?¿]|^\s*(?:what(?:'s|s)?|which|how|where|when|who(?:se|'s)?|why|is|are|was|were|do|does|did|can|could|should|would|will|any|qu[eé]|cu[aá]l(?:es)?|c[oó]mo|d[oó]nde|cu[aá]ndo|qui[eé]n(?:es)?|por\s+qu[eé]|es|son|hay|pued[eo]s?|tienes?|sabes)(?![\p{L}])/iu;
// Hours, reports and schedule talk about a unit go to the office tools that
// `isOperationalAsk` already routes them to, never to a unit setup.
const OFFICE_TALK = /\b(?:hours?|timecards?|payroll|export\w*|reports?|summar\w*|schedul\w*|assign\w*|horas?|n[oó]mina|informe\w*|resumen|horario\w*|asign\w*)\b/i;

/** A typed description of a named unit — its type or its size — with no
 * question, report, schedule or problem words around it. */
export function describesUnit(question: string): boolean {
  const unit = NAMED_UNIT.exec(question);
  if (!unit || QUESTION.test(question) || OFFICE_TALK.test(question) || PROBLEM.test(question)) return false;
  // The unit's own number never counts as a size ("unit 4 by 5pm").
  const rest = `${question.slice(0, unit.index)} ${question.slice(unit.index + unit[0].length)}`;
  return UNIT_TYPE.test(rest) || SIZE.test(rest);
}

/** Setting up or working a unit, or writing up a lesson: these go to Forge AI's
 * field tools, whether typed or spoken. Install tips and "my next unit" stay
 * with the free local answers. */
export function isFieldAsk(question: string): boolean {
  return (UNIT.test(question) && UNIT_ACTION.test(question)) || STANDALONE.test(question) || LESSON.test(question) || describesUnit(question);
}

/** Offline help only: report requests need a complete live snapshot. This does
 * not change their operational tools, durable request or role checks. */
export function asksForReport(question: string): boolean {
  return /\b(hours?|timecards?|payroll|export\w*|reports?|summary|summari[sz]\w*|horas?|n[oó]mina|export\w*|informe\w*|resumen)\b/i.test(question);
}
