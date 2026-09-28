// Report a problem from Work (crew redesign K1.2's fourth quick button,
// 2026-09-23). It files the same `issues` row the unit sheet files — the
// existing create_issue RPC, the existing kinds — so a lead sees it on
// Issues right away. Nothing new is invented here; the quick button is a
// shorter walk to a door that already existed.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import { createIssue, type IssueKind } from "../../lib/issues";
import { toastSuccess } from "../../lib/toast";
import { Sheet } from "../ui/Sheet";
import { VoiceTextarea } from "../voice/VoiceTextarea";

const KINDS: { kind: IssueKind; key: "work.problem.kind.blocker" | "work.problem.kind.damage" | "work.problem.kind.missing" | "work.problem.kind.complication" }[] = [
  { kind: "blocker", key: "work.problem.kind.blocker" },
  { kind: "damage", key: "work.problem.kind.damage" },
  { kind: "missing", key: "work.problem.kind.missing" },
  { kind: "complication", key: "work.problem.kind.complication" },
];

export function ReportProblemSheet({
  open,
  onClose,
  projectId,
  openingId,
  unitLabel,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  openingId?: string | null;
  unitLabel?: string | null;
}) {
  const t = useT();
  const [kind, setKind] = useState<IssueKind | null>(null);
  const [urgent, setUrgent] = useState(false);
  const [note, setNote] = useState("");
  const send = useMutation({
    mutationFn: () =>
      createIssue({
        projectId,
        openingId: openingId ?? null,
        kind: kind!,
        urgency: urgent ? "urgent" : "normal",
        note: note.trim() || null,
      }),
    onSuccess: () => {
      toastSuccess(t("work.problem.sent"));
      setKind(null);
      setUrgent(false);
      setNote("");
      onClose();
    },
  });
  return (
    <Sheet open={open} onClose={onClose} label={t("work.problem.title")} className="ws-sheet">
      <h2 className="ws-sheet-title">{t("work.problem.title")}</h2>
      <p className="ws-meta">
        {t("work.problem.help")}
        {unitLabel ? ` ${t("work.problem.onUnit", { label: unitLabel })}` : ""}
      </p>
      <div className="ws-chip-row ws-chip-row--wrap" role="group" aria-label={t("work.problem.title")}>
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            className={`ws-chip${kind === k.kind ? " ws-chip--on" : ""}`}
            aria-pressed={kind === k.kind}
            onClick={() => setKind(k.kind)}
          >
            {t(k.key)}
          </button>
        ))}
      </div>
      <label className="ws-check">
        <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
        {t("work.problem.urgent")}
      </label>
      <label className="ws-label" htmlFor="ws-problem-note">{t("work.problem.note")}</label>
      <VoiceTextarea
        id="ws-problem-note"
        className="ws-textarea"
        rows={3}
        maxLength={2000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {send.isError && <p className="ws-error" role="alert">{formatApiError(send.error)}</p>}
      <button
        type="button"
        className="ws-btn ws-btn--primary"
        disabled={!kind || send.isPending}
        onClick={() => send.mutate()}
      >
        {send.isPending ? t("work.problem.sending") : t("work.problem.send")}
      </button>
      <button type="button" className="ws-btn ws-btn--ghost" onClick={onClose}>
        {t("work.problem.cancel")}
      </button>
    </Sheet>
  );
}
