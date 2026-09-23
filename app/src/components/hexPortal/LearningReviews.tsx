import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LearningUnavailable, listLearningReviews, type LearningReview } from "../../lib/hexLearning";
import { LearningReviewDetail } from "./LearningReviewDetail";
import { deliveryText } from "./learningText";
import { useLearningT, type LearningKey } from "./learningCatalog";

/** One list of write-ups: mine, sent to me by name, or (supervisors and owners) all sent. */
export function LearningReviewList({ scope, actorId, projectId }: { scope: "mine" | "assigned" | "oversight"; actorId: string; projectId?: string }) {
  const t = useLearningT();
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["hexLearningReviews", scope, actorId, projectId ?? null],
    queryFn: () => listLearningReviews(scope, projectId),
    refetchInterval: 60000,
  });
  const title = t(`learn.${scope}` as LearningKey);
  const rows = list.data ?? [];
  const waiting = rows.filter((r) => r.state === "submitted").length;
  return (
    <details className="learning-list">
      <summary>{title}{waiting ? ` · ${waiting}` : ""}</summary>
      <button type="button" className="btn" onClick={() => void list.refetch()}>{t("learn.refresh")}</button>
      {list.isLoading && <p role="status">…</p>}
      {list.error && <p role="alert">{list.error instanceof LearningUnavailable ? t("learn.unavailable") : t("learn.loadFailed")}</p>}
      {list.data && !rows.length && <p className="muted">{t("learn.empty")}</p>}
      {rows.map((r: LearningReview) => (
        <article key={r.id} className="hex-learning-card">
          <strong>{r.content.issue ?? r.question}</strong>
          <p className="muted">
            {r.job?.job_code ?? ""} · {r.unit_label || t("learn.wholeJob")} · {scope === "mine" ? "" : `${t("learn.author", { name: r.author.name })} · `}
            {r.state === "draft" ? t("learn.state.draft") : t(`learn.state.${r.state}` as LearningKey, { name: r.reviewer?.name ?? "" })}
          </p>
          {r.state === "approved" && <p className="muted">{deliveryText(t, r.delivery)}</p>}
          {open === r.id ? (
            <>
              <LearningReviewDetail reviewId={r.id} actorId={actorId} onChanged={() => void list.refetch()} />
              <button type="button" className="btn" onClick={() => setOpen(null)}>{t("learn.close")}</button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => setOpen(r.id)}>{t("learn.open")}</button>
          )}
        </article>
      ))}
    </details>
  );
}
