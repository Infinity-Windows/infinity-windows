import { useId, useRef, useState } from "react";
import { useLanguage } from "../../lib/i18n";
import { formatApiError } from "../../lib/errors";
import {
  saveLearningCase,
  saveLearningOutcome,
  type LearningDraft,
} from "../../lib/hexPortal";
import { VoiceTextarea } from "../voice/VoiceTextarea";
export function LearningCard({
  draft,
  caseId,
  onSaved,
}: {
  draft?: LearningDraft;
  caseId?: { id: string; actorId: string };
  onSaved?: () => void;
}) {
  const noteId = useId();
  const { lang } = useLanguage();
  const es = lang === "es";
  const id = useRef(caseId?.id || crypto.randomUUID()),
    outcomeId = useRef(crypto.randomUUID());
  const [saved, setSaved] = useState(!!caseId),
    [dependency, setDependency] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [status, setStatus] = useState("");
  const actorId = draft?.actorId || caseId?.actorId;
  async function save() {
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    try {
      const entry = await saveLearningCase(draft, id.current);
      setDependency(entry);
      setSaved(true);
      setStatus(
        es
          ? "Guardado en este dispositivo. Consulta el estado de sincronización arriba."
          : "Saved on this device. Check the sync status above.",
      );
      onSaved?.();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }
  async function outcome(value: "resolved" | "needs-help") {
    if (!actorId || busy) return;
    if (value === "needs-help" && !note.trim()) {
      setError(
        es
          ? "Describe lo que todavía necesitas."
          : "Describe what still needs help.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      await saveLearningOutcome(
        actorId,
        id.current,
        value,
        note,
        outcomeId.current,
        dependency,
      );
      outcomeId.current = crypto.randomUUID();
      setNote("");
      setStatus(
        es
          ? "Resultado guardado para sincronizar."
          : "Outcome saved for syncing.",
      );
      onSaved?.();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="hex-learning-card">
      {!saved ? (
        <>
          <p>
            {es
              ? "Comparte esta pregunta y respuesta sobre el trabajo para revisión."
              : "Share this job question and answer for review."}
          </p>
          <p className="muted">
            {es
              ? "No incluyas nómina, datos privados ni información de clientes."
              : "Keep payroll, private questions and customer personal details out of shared learning."}
          </p>
          <button className="btn" disabled={busy} onClick={save}>
            {es ? "Guardar caso en Hex-Portal" : "Save Hex-Portal case"}
          </button>
        </>
      ) : (
        <>
          <label htmlFor={noteId}>
            {es ? "¿Qué pasó después?" : "What happened next?"}
          </label>
          <VoiceTextarea
            id={noteId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={4000}
            placeholder={
              es
                ? "Qué funcionó o qué falta resolver…"
                : "What worked, or what still needs fixing…"
            }
          />
          <div className="hex-learning-actions">
            <button
              className="btn"
              disabled={busy}
              onClick={() => outcome("resolved")}
            >
              {es ? "Resuelto" : "Resolved"}
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => outcome("needs-help")}
            >
              {es ? "Necesito ayuda" : "Needs help"}
            </button>
          </div>
        </>
      )}
      {status && (
        <p className="muted" role="status">
          {status}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
