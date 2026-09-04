// "Data off" on the opening sheet — one tap, a reason, and a note if there is
// one worth writing.
//
// Wave E (transcripts program, Q12). THE RULE THIS CARD EXISTS TO KEEP: it
// never blocks Finish. "Done, data off" is the ordinary case — the window is
// in, the paperwork was wrong, and both facts have to be recordable without
// the second one holding up the first. So this is its own card outside the
// install flow's gates, visible before, during and after the install, rather
// than a question in the way of the finish button.
//
// Clearing is foreman+ (clear_opening_flag says so in SQL as well): taking the
// flag down is a claim that somebody went and checked.

import { useState } from "react";
import { useT } from "../../lib/i18n";
import {
  DATA_OFF_CHOICES,
  DATA_OFF_LABEL_KEYS,
  dataOffKind,
  type DataOffKind,
  type FlaggableOpening,
} from "../../lib/install/dataOff";

export interface DataOffCardProps {
  opening: FlaggableOpening;
  /** Who raised it, already resolved to a display name. */
  flaggedByName?: string | null;
  /** Foreman and up: the only people who may take a flag down. */
  canClear: boolean;
  busy: boolean;
  onFlag: (kind: DataOffKind, note: string) => void;
  onClear: () => void;
}

export function DataOffCard({
  opening,
  flaggedByName,
  canClear,
  busy,
  onFlag,
  onClear,
}: DataOffCardProps) {
  const t = useT();
  const kind = dataOffKind(opening);
  const [picked, setPicked] = useState<DataOffKind | null>(null);
  const [note, setNote] = useState("");

  if (kind) {
    return (
      <div className="detail-card data-off-card data-off-card--on">
        <p className="field-label" style={{ margin: 0 }}>
          {t("dataoff.flagged")} <strong>{t(DATA_OFF_LABEL_KEYS[kind])}</strong>
        </p>
        {opening.flag_note?.trim() && <p style={{ margin: "4px 0" }}>{opening.flag_note}</p>}
        {flaggedByName && (
          <p className="muted" style={{ margin: "4px 0", fontSize: 13 }}>
            {t("dataoff.by", { who: flaggedByName })}
          </p>
        )}
        {canClear ? (
          <button className="action-btn" disabled={busy} onClick={onClear}>
            {t("dataoff.clear")}
          </button>
        ) : (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {t("dataoff.askForeman")}
          </p>
        )}
      </div>
    );
  }

  return (
    <details className="more-actions data-off-card">
      <summary className="muted">{t("dataoff.title")}</summary>
      <p className="muted">{t("dataoff.help")}</p>
      <span className="field-label">{t("dataoff.pickReason")}</span>
      <div className="row-gap">
        {DATA_OFF_CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            className={picked === choice ? "chip active" : "chip"}
            aria-pressed={picked === choice}
            onClick={() => setPicked(choice)}
          >
            {t(DATA_OFF_LABEL_KEYS[choice])}
          </button>
        ))}
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t("dataoff.notePlaceholder")}
      />
      <button
        className="action-btn"
        disabled={!picked || busy}
        onClick={() => {
          if (!picked) return;
          onFlag(picked, note.trim());
          setPicked(null);
          setNote("");
        }}
      >
        {busy ? t("dataoff.saving") : t("dataoff.save")}
      </button>
    </details>
  );
}
