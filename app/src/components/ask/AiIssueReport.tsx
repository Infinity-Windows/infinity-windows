import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { submitAppFeedback } from "../../lib/appFeedback";
import { formatApiError } from "../../lib/errors";
import { useFeedbackT } from "../../lib/i18n/feedbackCatalog";
import { buildAiIssueBody, type AiIssueContext } from "../../lib/aiIssueReport";
import "./aiIssueReport.css";

/** Only the person's deliberate Send files a report. The editable preview
 * includes this exchange, never the whole conversation or a recording. */
export function AiIssueReport({ actorId, ...context }: AiIssueContext & { actorId: string }) {
  const t = useFeedbackT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (pending || sent || !body.trim()) return;
    setPending(true); setError(null);
    try {
      await submitAppFeedback("bug", body.trim(), { category: "ai", actorId });
      setSent(true); setOpen(false);
      void qc.invalidateQueries({ queryKey: ["appFeedback"] });
    } catch (e) { setError(formatApiError(e)); }
    finally { setPending(false); }
  };
  return <div className="ai-issue-report">
    {sent ? <p role="status">{t("feedback.aiSent")} <Link to="/suggestions">{t("feedback.viewReports")}</Link></p>
      : <button type="button" className="link" aria-expanded={open} onClick={() => {
        if (!open) setBody(buildAiIssueBody(context, t));
        setError(null); setOpen(!open);
      }}>{t("feedback.reportAi")}</button>}
    {open && !sent && <div className="ai-issue-preview">
      <p>{t("feedback.previewHelp")}</p>
      <label>{t("feedback.reportText")}<textarea value={body} maxLength={2000} rows={5}
        disabled={pending} onChange={(e) => setBody(e.target.value)} /></label>
      <div className="row-gap">
        <button type="button" className="button-like" disabled={pending || !body.trim()} onClick={() => void send()}>
          {pending ? t("suggestions.sending") : t("feedback.sendAi")}</button>
        <button type="button" className="link" disabled={pending} onClick={() => setOpen(false)}>{t("feedback.cancel")}</button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </div>}
  </div>;
}
