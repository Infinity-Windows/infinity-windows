import { useCallback } from "react";
import { useLanguage } from "./context";
import type { TKey as AppKey } from "./catalog";
import { translate, type CatalogEntry, type TVars } from "./translate";

export const FEEDBACK_CATALOG = {
  "feedback.reportAi": { en: "Report an AI issue", es: "Reportar un problema de IA" },
  "feedback.previewHelp": { en: "Review or edit this exchange before forwarding it to App Issues → AI. Only this text is sent.", es: "Revisa o edita este intercambio antes de enviarlo a Problemas de la app → IA. Solo se envía este texto." },
  "feedback.reportText": { en: "AI issue report", es: "Reporte de problema de IA" },
  "feedback.sendAi": { en: "Send to App Issues", es: "Enviar a Problemas de la app" },
  "feedback.aiSent": { en: "Sent to App Issues → AI.", es: "Enviado a Problemas de la app → IA." },
  "feedback.viewReports": { en: "View your reports", es: "Ver tus reportes" },
  "feedback.cancel": { en: "Cancel", es: "Cancelar" },
  "feedback.textContext": { en: "AI issue — Ask", es: "Problema de IA — Preguntar" },
  "feedback.liveContext": { en: "AI issue — Live Chat", es: "Problema de IA — Chat en vivo" },
  "feedback.whatFailed": { en: "What could the AI not complete?", es: "¿Qué no pudo completar la IA?" },
  "feedback.question": { en: "My request:", es: "Mi solicitud:" },
  "feedback.answer": { en: "AI response:", es: "Respuesta de IA:" },
  "feedback.category": { en: "Section", es: "Sección" },
  "feedback.all": { en: "All", es: "Todo" },
  "feedback.app": { en: "App", es: "App" },
  "feedback.ai": { en: "AI", es: "IA" },
  "feedback.resolution": { en: "Fix verification", es: "Verificación de la solución" },
  "feedback.resolveHelp": { en: "Describe the verified fix before resolving this report.", es: "Describe la solución verificada antes de resolver este reporte." },
} as const satisfies Record<string, CatalogEntry>;
type FeedbackKey = keyof typeof FEEDBACK_CATALOG;
export type FeedbackT = (key: AppKey | FeedbackKey, vars?: TVars) => string;
export function useFeedbackT(): FeedbackT {
  const { lang, t } = useLanguage();
  return useCallback((key: AppKey | FeedbackKey, vars?: TVars) => key.startsWith("feedback.")
    ? translate(FEEDBACK_CATALOG, lang, key, vars) : t(key as AppKey, vars), [lang, t]);
}
