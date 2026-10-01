import type { LiveEndReason, LiveStatus } from "./liveAskSession";

/**
 * Live Ask is a gated pilot. Production builds expose the entry point to
 * the real owner; VITE_LIVE_ASK_PILOT=false is the emergency build switch.
 * A session only works once the server's own switch is on
 * (live-ask-session: LIVE_ASK_ENABLED and its OpenAI credential).
 * The Ask page also limits the button to the real owner account, and the
 * server repeats that check. No crew announcement goes out until the pilot
 * is verified end to end.
 */
export function liveAskPilotEnabled(env: Record<string, unknown> = import.meta.env): boolean {
  if (env.VITE_LIVE_ASK_PILOT === "false") return false;
  return env.VITE_LIVE_ASK_PILOT === "true" || env.PROD === true;
}

// The strings live beside the feature, not in the shared field catalog, while
// this is a pilot; they move into fieldCatalog when it ships to the crew.
const EN = {
  start: "Start live conversation",
  end: "End live conversation",
  pilot: "Live (pilot)",
  starting: "Connecting… allow the microphone if asked.",
  live: "Live — speak any time, even while Forge is talking.",
  unstable: "Connection unstable — trying to recover. Keep this screen open.",
  ended: "Live conversation ended.",
  endedCap: "Live conversation reached the time limit. Tap Continue to keep talking.",
  endedAccount: "Live conversation ended because the signed-in account changed.",
  endedBackground: "Live conversation ended when this phone went to the background. Tap Start to talk again.",
  failed: "Live conversation stopped. If you were speaking, check below for an unsent recording. Tap Start to try again.",
  interruptedMemo: "Unfinished live recording — review before sending",
  listenMemo: "Listen to recording",
  notConfigured: "Live conversation isn't turned on for Forge yet. Use the microphone button instead.",
  limit: "Live conversation isn't available — the AI limit for today or this month is reached.",
  offline: "Live conversation needs a connection.",
  permission: "Forge needs the microphone for a live conversation.",
  unsupported: "This phone's browser can't hold a live conversation. Use the microphone button instead.",
  saving: "Saving what you said…",
  endingSoon: "About 30 seconds left. Finish your thought, then tap Continue to keep talking.",
  endingSoonShort: "About 30 seconds left",
  continue: "Continue live conversation",
  tryAgain: "Try live conversation again",
};
type Key = keyof typeof EN;
const ES: Record<Key, string> = {
  start: "Iniciar conversación en vivo",
  end: "Terminar conversación en vivo",
  pilot: "En vivo (prueba)",
  starting: "Conectando… permite el micrófono si lo pide.",
  live: "En vivo — habla cuando quieras, incluso mientras Forge habla.",
  unstable: "Conexión inestable — intentando recuperarla. Mantén esta pantalla abierta.",
  ended: "Conversación en vivo terminada.",
  endedCap: "La conversación en vivo llegó al límite de tiempo. Toca Continuar para seguir hablando.",
  endedAccount: "La conversación en vivo terminó porque cambió la cuenta.",
  endedBackground: "La conversación en vivo terminó al salir de esta pantalla. Toca Iniciar para hablar otra vez.",
  failed: "La conversación en vivo se detuvo. Si estabas hablando, revisa abajo si hay una grabación sin enviar. Toca Iniciar para intentarlo otra vez.",
  interruptedMemo: "Grabación en vivo incompleta — revísala antes de enviarla",
  listenMemo: "Escuchar grabación",
  notConfigured: "La conversación en vivo todavía no está activada en Forge. Usa el botón del micrófono.",
  limit: "La conversación en vivo no está disponible — se alcanzó el límite de IA de hoy o del mes.",
  offline: "La conversación en vivo necesita conexión.",
  permission: "Forge necesita el micrófono para la conversación en vivo.",
  unsupported: "El navegador de este teléfono no puede mantener una conversación en vivo. Usa el botón del micrófono.",
  saving: "Guardando lo que dijiste…",
  endingSoon: "Quedan unos 30 segundos. Termina tu idea y toca Continuar para seguir hablando.",
  endingSoonShort: "Quedan unos 30 segundos",
  continue: "Continuar conversación en vivo",
  tryAgain: "Intentar conversación en vivo otra vez",
};

export function liveText(es: boolean, key: Key): string {
  return (es ? ES : EN)[key];
}

/** A new paid session is always a deliberate tap, and never follows a sign-out. */
export function canContinueLive(status: LiveStatus, detail?: LiveEndReason | string): boolean {
  return (status === "ended" && (detail === "cap" || detail === "background")) ||
    (status === "failed" && detail === "connection");
}

/** The one status line the person reads, from the session's status and why it ended. */
export function liveStatusLine(es: boolean, status: LiveStatus, detail?: LiveEndReason | string): string {
  switch (status) {
    case "idle": return "";
    case "starting": return liveText(es, "starting");
    case "live": return liveText(es, "live");
    case "unstable": return liveText(es, "unstable");
    case "ended":
      return liveText(es, detail === "cap" ? "endedCap" : detail === "account" ? "endedAccount" : detail === "background" ? "endedBackground" : "ended");
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
