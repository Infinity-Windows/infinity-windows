/** Operational requests need fresh tools, never a keyword/cache answer. */
export function isOperationalAsk(question: string, hasReportContext = false): boolean {
  return hasReportContext || /\b(hours?|timecards?|payroll|export\w*|report\w*|schedule\w*|assign\w*|crew|job\w*|project\w*|progress|summary|summari[sz]\w*|horas?|n[oó]mina|informe\w*|export\w*|horario\w*|asign\w*|cuadrilla|obra\w*|proyecto\w*|resumen|avance)\b/i.test(question);
}
