// Forge Workshop only: the pre-clock front door the owner agreed on
// (2026-10-06) — before the shift starts, Work shows exactly two things:
// Clock in, and today's toolbox talk. Nothing else (no Today, Next up, new
// unit, prep, supplies, logs or team links); the owner rejected the dense
// classic starting screen.
//
// Pure presentation. It reads nothing and writes nothing: the parent passes
// the talk, its signed state and whether the clock is known, and supplies
// `onClockIn` only once the qualified clock-in contract is wired (main root
// owns that). Until then the button stays disabled and says so — this screen
// never invents a paid start time.

import "./workshopStart.css";
import { ChevronDown, Clock as ClockIcon, ShieldCheck } from "lucide-react";
import type { SafetyTalk } from "../../lib/ops";
import { useLanguage } from "../../lib/i18n";
import { TalkContent } from "../safety/TalkContent";

export interface WorkshopStartScreenProps {
  /** Today's toolbox talk, or null when there is none (or it has not loaded). */
  talk: SafetyTalk | null;
  talkLoading: boolean;
  talkError: boolean;
  /** Whether this person has signed today's talk; null when not known yet. */
  signed: boolean | null;
  /** False while the shift state is still being read — never offer Clock in then. */
  clockKnown: boolean;
  /** The qualified clock-in. Absent until the new clock-in is connected. */
  onClockIn?: () => void;
  /** True while a clock-in the parent started is in flight. */
  starting?: boolean;
}

const COPY = {
  en: {
    heading: "Work",
    clockIn: "Clock in",
    starting: "Starting…",
    checking: "Checking your clock…",
    pending: "The new clock-in is being connected. Nothing is recorded from this button yet.",
    hint: "Clocking in starts your day: pick the project and cost code, then sign today's talk.",
    talkTitle: "Today's toolbox talk",
    talkLoading: "Loading today's talk…",
    talkError: "Today's talk could not be loaded. Reconnect to try again.",
    noTalk: "No toolbox talk is posted for today.",
    signed: "Signed",
    unsigned: "Not signed yet",
    readMore: "Read the full talk",
    readLess: "Hide the full talk",
  },
  es: {
    heading: "Trabajo",
    clockIn: "Marcar entrada",
    starting: "Iniciando…",
    checking: "Revisando tu reloj…",
    pending: "La nueva entrada se está conectando. Este botón todavía no registra nada.",
    hint: "Marcar entrada inicia tu día: elige el proyecto y el código de costo, y firma la charla de hoy.",
    talkTitle: "Charla de seguridad de hoy",
    talkLoading: "Cargando la charla de hoy…",
    talkError: "No se pudo cargar la charla de hoy. Reconecta para intentar de nuevo.",
    noTalk: "No hay charla de seguridad publicada para hoy.",
    signed: "Firmada",
    unsigned: "Sin firmar",
    readMore: "Leer la charla completa",
    readLess: "Ocultar la charla completa",
  },
} as const;

export function WorkshopStartScreen({
  talk,
  talkLoading,
  talkError,
  signed,
  clockKnown,
  onClockIn,
  starting = false,
}: WorkshopStartScreenProps) {
  const lang = useLanguage().lang === "es" ? "es" : "en";
  const c = COPY[lang];
  const canClockIn = clockKnown && Boolean(onClockIn) && !starting;
  // First paragraph only, as the card's preview; the rest is behind Read more.
  const preview = talk?.body.split("\n\n")[0]?.trim() ?? "";

  return (
    <section className="page wk-start" aria-labelledby="wk-start-heading">
      <h1 id="wk-start-heading" className="wk-start-heading">{c.heading}</h1>

      <div className="wk-start-clock">
        <button
          type="button"
          className="wk-start-clockin"
          disabled={!canClockIn}
          aria-busy={starting || undefined}
          onClick={canClockIn ? onClockIn : undefined}
        >
          <ClockIcon size={22} aria-hidden />
          <span>{starting ? c.starting : c.clockIn}</span>
        </button>
        <p className="wk-start-line" role="status">
          {!clockKnown ? c.checking : !onClockIn ? c.pending : c.hint}
        </p>
      </div>

      <article className="wk-start-talk" aria-labelledby="wk-start-talk-title">
        <header className="wk-start-talk-head">
          <ShieldCheck size={18} aria-hidden />
          <h2 id="wk-start-talk-title">{c.talkTitle}</h2>
          {talk && signed !== null && (
            <span className={`wk-start-signed${signed ? " is-signed" : ""}`}>
              {signed ? c.signed : c.unsigned}
            </span>
          )}
        </header>
        <div className="wk-start-talk-body">
          {talkLoading ? (
            <p className="wk-start-muted">{c.talkLoading}</p>
          ) : talkError ? (
            <p className="wk-start-muted" role="alert">{c.talkError}</p>
          ) : !talk ? (
            <p className="wk-start-muted">{c.noTalk}</p>
          ) : (
            <>
              <h3 className="wk-start-talk-name">{talk.title}</h3>
              {preview && <p className="wk-start-preview">{preview}</p>}
              <details className="wk-start-more">
                <summary>
                  <span className="wk-start-more-open">{c.readMore}</span>
                  <span className="wk-start-more-close">{c.readLess}</span>
                  <ChevronDown size={16} aria-hidden />
                </summary>
                {/* The shared talk renderer: React text nodes only, and it
                    already filters unapproved visual aids (lib/toolbox.ts). */}
                <div className="wk-start-full">
                  <TalkContent talk={talk} />
                </div>
              </details>
            </>
          )}
        </div>
      </article>
    </section>
  );
}
