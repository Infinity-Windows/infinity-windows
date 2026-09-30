import type { LiveEndReason, LiveStatus } from "./liveAskSession";

/**
 * Live Ask is a gated pilot. It shows only in a build made with
 * VITE_LIVE_ASK_PILOT=true AND only works once the server's own switch is on
 * (live-ask-session: LIVE_ASK_ENABLED and its OpenAI credential).
 * Nobody on the crew sees a Live button until both are true, and no crew
 * announcement goes out for it until the pilot is verified end to end.
 */
export function liveAskPilotEnabled(env: Record<string, unknown> = import.meta.env): boolean {
  return env.VITE_LIVE_ASK_PILOT === "true";
}

// The strings live beside the feature, not in the shared field catalog, while
// this is a pilot; they move into fieldCatalog when it ships to the crew.
const EN = {
  start: "Start live conversation",
  end: "End live conversation",
  pilot: "Live (pilot)",
  starting: "Connecting… allow the microphone if asked.",
  live: "Live — speak any time, even while Forge is talking.",
  unstable: "Connection unstable — trying to recover. What you already said is being saved.",
  ended: "Live conversation ended.",
  endedCap: "Live conversation ended at the time limit. Tap Start to talk again.",
  endedAccount: "Live conversation ended because the signed-in account changed.",
  failed: "Live conversation stopped. Anything already said is saved or kept on this phone. Tap Start to try again.",
  notConfigured: "Live conversation isn't turned on for Forge yet. Use the microphone button instead.",
  limit: "Live conversation isn't available — the AI limit for today or this month is reached.",
  offline: "Live conversation needs a connection.",
  permission: "Forge needs the microphone for a live conversation.",
  unsupported: "This phone's browser can't hold a live conversation. Use the microphone button instead.",
  saving: "Saving what you said…",
};
type Key = keyof typeof EN;
const ES: Record<Key, string> = {
  start: "Iniciar conversación en vivo",
  end: "Terminar conversación en vivo",
  pilot: "En vivo (prueba)",
  starting: "Conectando… permite el micrófono si lo pide.",
  live: "En vivo — habla cuando quieras, incluso mientras Forge habla.",
  unstable: "Conexión inestable — intentando recuperarla. Lo que ya dijiste se está guardando.",
  ended: "Conversación en vivo terminada.",
  endedCap: "La conversación en vivo llegó al límite de tiempo. Toca Iniciar para hablar otra vez.",
  endedAccount: "La conversación en vivo terminó porque cambió la cuenta.",
  failed: "La conversación en vivo se detuvo. Lo ya dicho está guardado o en este teléfono. Toca Iniciar para intentarlo otra vez.",
  notConfigured: "La conversación en vivo todavía no está activada en Forge. Usa el botón del micrófono.",
  limit: "La conversación en vivo no está disponible — se alcanzó el límite de IA de hoy o del mes.",
  offline: "La conversación en vivo necesita conexión.",
  permission: "Forge necesita el micrófono para la conversación en vivo.",
  unsupported: "El navegador de este teléfono no puede mantener una conversación en vivo. Usa el botón del micrófono.",
  saving: "Guardando lo que dijiste…",
};

export function liveText(es: boolean, key: Key): string {
  return (es ? ES : EN)[key];
}

/** The one status line the person reads, from the session's status and why it ended. */
export function liveStatusLine(es: boolean, status: LiveStatus, detail?: LiveEndReason | string): string {
  switch (status) {
    case "idle": return "";
    case "starting": return liveText(es, "starting");
    case "live": return liveText(es, "live");
    case "unstable": return liveText(es, "unstable");
    case "ended":
      return liveText(es, detail === "cap" ? "endedCap" : detail === "account" ? "endedAccount" : "ended");
    case "failed":
      switch (detail) {
        case "live_not_configured": return liveText(es, "notConfigured");
        case "live_limit": return liveText(es, "limit");
        case "offline": return liveText(es, "offline");
        case "microphone_permission": return liveText(es, "permission");
        case "live_unsupported": return liveText(es, "unsupported");
        default: return liveText(es, "failed");
      }
  }
}
