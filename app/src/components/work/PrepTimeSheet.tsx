// Prep time in one tap from Work (crew redesign K1.5, 2026-09-23): the six
// reasons — Gathering · Hauling · Setup · Errand · Cleanup · Other — plus an
// optional spoken note, then Start. It records the same custom_work_sessions
// row Current Work's idle timer has always recorded: `stage: "Idle time"`
// with no unit, because that stored identifier does not change (only what
// the screen calls it does). The reason is the session's description, so
// reports and the AI read one English word whatever language the phone
// speaks.

import { useState } from "react";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import { PREP_REASONS, type PrepReason } from "../../lib/customWork/model";
import { Sheet } from "../ui/Sheet";
import { VoiceTextarea } from "../voice/VoiceTextarea";

export function PrepTimeSheet({
  open,
  onClose,
  onStart,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onStart: (reason: PrepReason, note: string) => void;
  busy: boolean;
}) {
  const t = useT();
  const [reason, setReason] = useState<PrepReason | null>(null);
  const [note, setNote] = useState("");
  return (
    <Sheet open={open} onClose={onClose} label={t("work.prep.title")} className="ws-sheet">
      <h2 className="ws-sheet-title">{t("work.prep.title")}</h2>
      <p className="ws-meta">{t("work.prep.help")}</p>
      <div className="ws-chip-row ws-chip-row--wrap" role="group" aria-label={t("work.prep.help")}>
        {PREP_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            className={`ws-chip${reason === r ? " ws-chip--on" : ""}`}
            aria-pressed={reason === r}
            onClick={() => setReason(r)}
          >
            {t(`work.prep.reason.${r}` as const)}
          </button>
        ))}
      </div>
      <label className="ws-label" htmlFor="ws-prep-note">{t("work.prep.note")}</label>
      <VoiceTextarea
        id="ws-prep-note"
        className="ws-textarea"
        rows={2}
        maxLength={4000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        type="button"
        className="ws-btn ws-btn--primary"
        disabled={busy || !reason}
        onClick={() => reason && onStart(reason, note.trim())}
        data-testid="ws-prep-start"
      >
        {t("work.prep.start")}
      </button>
      <button type="button" className="ws-btn ws-btn--ghost" onClick={onClose}>
        {t("work.prep.cancel")}
      </button>
    </Sheet>
  );
}
