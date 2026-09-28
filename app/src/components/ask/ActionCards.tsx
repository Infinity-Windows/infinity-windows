import { Link } from "react-router-dom";
import { useFieldT as useT, type TKey } from "./fieldCatalog";
import {
  AI_BOUNDARY, allActionsForRank, cardLabel, cardsForRank,
} from "../../../../supabase/functions/_shared/askCapabilities";
import type { Lang } from "../../lib/i18n/translate";

/**
 * Action cards (crew redesign K2.2). Four per role plus "All actions", read
 * straight from the capability registry — nothing here decides what exists.
 * A card whose action has not shipped is simply not there; "All actions"
 * lists it honestly with the screen to use instead.
 *
 * K-X4: every card is a real button ≥56 px tall with 16 px text, and nothing
 * is said by colour alone.
 */
export interface RunningUnit { unitLabel: string }

/** What a tap sends: the words, and whether they are an ACTION (a saved field
 * request, evidence first) or a quick question the free company brain may
 * answer offline. */
export interface CardPick { query: string; operational: boolean }

export function ActionCards({ rank, lang, running, onPick, onAll }: {
  rank: number; lang: Lang; running: RunningUnit | null;
  onPick: (pick: CardPick) => void; onAll: () => void;
}) {
  const t = useT();
  const cards = cardsForRank(rank, running);
  return (
    <div className="ask-cards" role="group" aria-label={t("field.cards.title")}>
      {cards.map((c) => (
        <button key={c.id} type="button" className={c.id === "finish_unit" ? "ask-card ask-card-primary" : "ask-card"}
          onClick={() => onPick({ query: c.prompt[lang], operational: true })}>
          {cardLabel(c, lang, running)}
        </button>
      ))}
      <button type="button" className="ask-card ask-card-all" onClick={onAll}>{t("field.cards.all")}</button>
    </div>
  );
}

/** Every action this role may use, live ones tappable, the rest with "Use
 * the <screen> for this"; then what the AI never does; then quick questions. */
export function AllActions({ rank, lang, running, onPick, onClose, questions }: {
  rank: number; lang: Lang; running: RunningUnit | null;
  onPick: (pick: CardPick) => void; onClose: () => void;
  /** Quick questions (the free, offline company brain). */
  questions: { label: string; query: string }[];
}) {
  const t = useT();
  const rows = allActionsForRank(rank);
  return (
    <section className="field-card ask-all-actions" aria-label={t("field.cards.all")}>
      <div className="ask-all-head">
        <h3>{t("field.cards.all")}</h3>
        <button type="button" className="chip" onClick={onClose}>{t("field.cards.close")}</button>
      </div>
      <ul className="ask-all-list">
        {rows.map(({ capability: c, live, useScreen, screenOnly }) => (
          <li key={c.id} className={live ? "ask-all-row" : "ask-all-row ask-all-row-off"}>
            {live ? (
              <button type="button" className="ask-card" onClick={() => onPick({ query: c.prompt[lang], operational: true })}>{cardLabel(c, lang, running)}</button>
            ) : (
              <p className="ask-all-name"><strong>{cardLabel(c, lang, running)}</strong> · {screenOnly ? t("field.cards.onScreen") : t("field.cards.notYet", { release: c.release ?? "" })}</p>
            )}
            <p className="muted">{c.changes[lang]}</p>
            <p className="muted">{t(`field.cards.receipt.${c.receipt}` as TKey)}</p>
            {c.questions.required.length > 0 && (
              <p className="muted">{t("field.cards.asks", { list: c.questions.required.map((q) => q[lang]).join(" · ") })}</p>
            )}
            {useScreen && (
              <Link className="button-like" to={useScreen.path}>{t("field.cards.useScreen", { screen: useScreen.label[lang] })}</Link>
            )}
          </li>
        ))}
      </ul>
      <h4>{t("field.cards.never")}</h4>
      <ul className="ask-all-never">
        {AI_BOUNDARY.map((b) => <li key={b.en}>{b[lang]}</li>)}
      </ul>
      {questions.length > 0 && (
        <>
          <h4>{t("field.cards.questions")}</h4>
          <div className="ask-suggestions">
            {questions.map((s) => (
              <button key={s.query} type="button" className="chip" onClick={() => onPick({ query: s.query, operational: false })}>{s.label}</button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
