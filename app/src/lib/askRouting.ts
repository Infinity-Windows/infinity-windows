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

/** Setting up or working a unit: these go to Forge AI's field tools, whether
 * typed or spoken. Install tips and "my next unit" stay with the free local answers. */
export function isFieldAsk(question: string): boolean {
  return (UNIT.test(question) && UNIT_ACTION.test(question)) || STANDALONE.test(question);
}

/** Offline help only: report requests need a complete live snapshot. This does
 * not change their operational tools, durable request or role checks. */
export function asksForReport(question: string): boolean {
  return /\b(hours?|timecards?|payroll|export\w*|reports?|summary|summari[sz]\w*|horas?|n[oó]mina|export\w*|informe\w*|resumen)\b/i.test(question);
}
