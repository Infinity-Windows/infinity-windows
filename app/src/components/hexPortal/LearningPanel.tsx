import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLanguage } from "../../lib/i18n";
import { listProjectsAnyStatus } from "../../lib/api";
import { listLearningCases } from "../../lib/hexPortal";
import { listLearningReviews } from "../../lib/hexLearning";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { roleRank } from "../../lib/install/types";
import { LearningCard } from "./LearningCard";
import { LearningReviewForm } from "./LearningReviewForm";
import { LearningReviewDetail } from "./LearningReviewDetail";
import { LearningReviewList } from "./LearningReviews";
import { useLearningT, type LearningKey } from "./learningCatalog";
export function LearningPanel({
  projectId,
  unitLabel,
  actorId,
  onProject,
  onUnit,
}: {
  projectId: string;
  unitLabel: string;
  actorId?: string;
  onProject: (id: string) => void;
  onUnit: (label: string) => void;
}) {
  const fieldId = useId();
  const es = useLanguage().lang === "es";
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: listProjectsAnyStatus,
  });
  const cases = useQuery({
    queryKey: ["hexPortalCases", projectId, actorId],
    queryFn: () => listLearningCases(projectId, actorId!),
    enabled: !!projectId && !!actorId,
    refetchInterval: 30000,
  });
  const lt = useLearningT();
  const rank = roleRank(useEffectiveRole().effectiveRole);
  const [writing, setWriting] = useState<string | null>(null);
  // Write-ups for this job's cases; the older case list and outcomes are unchanged.
  const reviews = useQuery({
    queryKey: ["hexLearningReviews", "mine", actorId, projectId],
    queryFn: () => listLearningReviews("mine", projectId),
    enabled: !!projectId && !!actorId,
  });
  const reviewFor = (caseId: string) => reviews.data?.find((r) => r.case_id === caseId);
  const reviewsChanged = () => { void reviews.refetch(); };
  return (
    <section className="hex-learning-panel">
      <details>
        <summary>
          Hex-Portal · {es ? "Aprende de este trabajo" : "Learn from this job"}
        </summary>
        <p className="muted">
          {es
            ? "Selecciona el trabajo para buscar lecciones revisadas. Guarda preguntas y resultados para que el supervisor los revise."
            : "Choose a job to find reviewed lessons. Save job questions and outcomes for supervisor review."}
        </p>
        <div className="hex-learning-fields">
          <div>
            <label htmlFor={`${fieldId}-job`}>{es ? "Trabajo" : "Job"}</label>
            <select
              id={`${fieldId}-job`}
              value={projectId}
              onChange={(e) => onProject(e.target.value)}
            >
              <option value="">
                {es ? "Selecciona un trabajo" : "Choose a job"}
              </option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.job_code} · {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${fieldId}-unit`}>
              {es ? "Unidad (opcional)" : "Unit (optional)"}
            </label>
            <input
              id={`${fieldId}-unit`}
              maxLength={160}
              value={unitLabel}
              onChange={(e) => onUnit(e.target.value)}
              placeholder="16"
            />
          </div>
        </div>
        {projectId && (
          <details>
            <summary>
              {es
                ? "Mis 50 casos más recientes"
                : "My latest 50 learning cases"}
            </summary>
            <button className="btn" onClick={() => void cases.refetch()}>
              {es ? "Actualizar" : "Refresh cases"}
            </button>
            {cases.isLoading && (
              <p role="status">
                {es ? "Cargando tus casos…" : "Loading your cases…"}
              </p>
            )}
            {cases.error && (
              <p role="alert">
                {es
                  ? "No se pudo cargar. Tus casos pendientes siguen en la cola de sincronización."
                  : "Could not load cases. Pending cases remain in the sync queue."}
              </p>
            )}
            {cases.data?.length === 0 && (
              <p className="muted">
                {es
                  ? "Todavía no hay casos sincronizados para este trabajo."
                  : "No synced cases for this job yet."}
              </p>
            )}
            {cases.data?.map((c) => (
              <article className="hex-learning-card" key={c.id}>
                <strong>{c.question}</strong>
                <p className="muted">
                  {new Date(c.created_at).toLocaleDateString()} ·{" "}
                  {c.unit_label || (es ? "Todo el trabajo" : "Whole job")}
                </p>
                <p className="muted">
                  {es ? "Respuesta original" : "Original answer"}
                </p>
                <p style={{ whiteSpace: "pre-wrap" }}>{c.answer}</p>
                {c.hex_portal_outcomes.map((o) => (
                  <p key={o.id}>
                    {o.outcome === "resolved"
                      ? es
                        ? "Resuelto"
                        : "Resolved"
                      : es
                        ? "Necesita ayuda"
                        : "Needs help"}{" "}
                    · {o.explanation}
                  </p>
                ))}
                <LearningCard
                  caseId={{ id: c.id, actorId: c.asker_id }}
                  onSaved={() => void cases.refetch()}
                />
                {reviewFor(c.id) ? (
                  writing === c.id ? (
                    <LearningReviewDetail reviewId={reviewFor(c.id)!.id} actorId={c.asker_id} onChanged={reviewsChanged} />
                  ) : (
                    <p className="muted">
                      {lt("learn.title")}: {reviewFor(c.id)!.state === "draft" ? lt("learn.state.draft")
                        : lt(`learn.state.${reviewFor(c.id)!.state}` as LearningKey, { name: reviewFor(c.id)!.reviewer?.name ?? "" })}{" "}
                      <button type="button" className="btn" onClick={() => setWriting(c.id)}>{lt("learn.open")}</button>
                    </p>
                  )
                ) : writing === c.id ? (
                  <LearningReviewForm actorId={c.asker_id} projectId={c.project_id} source={{ caseId: c.id }} via="form" onChanged={reviewsChanged} />
                ) : (
                  <button type="button" className="btn" disabled={reviews.isLoading} onClick={() => setWriting(c.id)}>{lt("learn.writeUp")}</button>
                )}
              </article>
            ))}
          </details>
        )}
        {actorId && (
          <div className="learning-queues">
            <LearningReviewList scope="mine" actorId={actorId} />
            {rank >= 1 && <LearningReviewList scope="assigned" actorId={actorId} />}
            {rank >= 2 && <LearningReviewList scope="oversight" actorId={actorId} />}
          </div>
        )}
      </details>
    </section>
  );
}
