// The Pipeline card on a job's Overview (Wave J, J1): is this job ready, when
// does it start, when do the windows land, are they here, and when did anybody
// last talk to the GC.
//
// Everyone can read it. An installer who opens a job wants to know there is no
// glass on site just as much as the office does, and hiding that behind a rank
// is how a crew drives to a job that was never going to happen. Only the
// EDITING is foreman+, and the server holds the same line inside each RPC.
//
// Degrades rather than crashes on a database that is ahead of the migration:
// the columns are simply absent from the row, `ready_state === undefined`, and
// each row of this card is drawn only when its own fact exists. The card never
// disappears entirely — Expected start comes from start_date, which has been
// there since 20260718080000.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Phone } from "lucide-react";
import {
  setProjectMaterials,
  setProjectReadiness,
  updateProject,
} from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import { useLanguage, useT } from "../../lib/i18n";
import { needsCall, shortDay } from "../../lib/pipeline";
import type { Project } from "../../lib/types";
import { ReadinessBadge } from "./ReadinessBadge";

/** Today as a YYYY-MM-DD day string in the device's own timezone. */
function todayLocal(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function PipelinePanel({
  project,
  isLead,
}: {
  project: Project;
  isLead: boolean;
}) {
  const t = useT();
  const { lang } = useLanguage();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<"start" | "eta" | null>(null);
  const [startDraft, setStartDraft] = useState("");
  const [etaDraft, setEtaDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["projects"] });
    await queryClient.invalidateQueries({ queryKey: ["projectsAll"] });
  };

  const readiness = useMutation({
    mutationFn: (next: "ready" | "not_ready") => setProjectReadiness(project.id, next),
    onSuccess: async () => {
      setMessage(null);
      await refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const materials = useMutation({
    mutationFn: (input: { eta?: string | null; clearEta?: boolean; arrived?: boolean }) =>
      setProjectMaterials(project.id, input),
    onSuccess: async () => {
      setMessage(null);
      setEditing(null);
      await refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  // Expected start IS the existing start_date, edited through the existing
  // path: it rides wave D's column grant, so unlike the other three it needs
  // no RPC of its own and must not grow one.
  const start = useMutation({
    mutationFn: (day: string) => updateProject(project.id, { startDate: day || null }),
    onSuccess: async () => {
      setMessage(null);
      setEditing(null);
      await refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const busy = readiness.isPending || materials.isPending || start.isPending;
  // WAVE H SEAM: the GC check-in table (project_gc_checkins) does not exist
  // yet, so nothing can be known about it. `null` here means UNKNOWN, and
  // needsCall never counts an unknown against a job — see the fourth argument's
  // note in lib/pipeline.ts. When H lands, this becomes the job's latest
  // check-in and the last argument becomes true; nothing else on this card
  // changes.
  const lastCheckinAt: string | null = null;
  const gcCheckinsKnown = false;
  const call = needsCall(project, todayLocal(), lastCheckinAt, gcCheckinsKnown);

  const arrived = project.materials_arrived_at ?? null;
  const hasPipelineColumns = project.ready_state !== undefined;

  return (
    <section className="detail-card" style={{ marginBottom: 16 }}>
      <div className="row-between">
        <h2 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
          {t("pipeline.heading")}
          <ReadinessBadge readyState={project.ready_state} />
        </h2>
        {call.call && (
          <span className="job-needs-call">
            <Phone size={11} aria-hidden /> {t("pipeline.needsCall")}
          </span>
        )}
      </div>

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(160px, 100%), 1fr))",
          gap: "10px 16px",
          margin: "10px 0 0",
        }}
      >
        {hasPipelineColumns && (
          <div>
            <dt className="field-label">{t("pipeline.heading")}</dt>
            <dd style={{ margin: 0 }}>
              {project.ready_state === "not_ready" ? t("pipeline.notReady") : t("pipeline.ready")}
            </dd>
            {isLead && (
              <button
                type="button"
                className="link"
                disabled={busy}
                onClick={() =>
                  readiness.mutate(project.ready_state === "not_ready" ? "ready" : "not_ready")
                }
              >
                {project.ready_state === "not_ready"
                  ? t("pipeline.markReady")
                  : t("pipeline.markNotReady")}
              </button>
            )}
          </div>
        )}

        <div>
          <dt className="field-label">{t("pipeline.expectedStart")}</dt>
          <dd style={{ margin: 0 }}>
            {shortDay(project.start_date, lang) || t("pipeline.notSet")}
          </dd>
          {isLead && editing !== "start" && (
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => {
                setStartDraft(project.start_date?.slice(0, 10) ?? "");
                setEditing("start");
              }}
            >
              {t("pipeline.change")}
            </button>
          )}
          {isLead && editing === "start" && (
            <div className="row-gap" style={{ marginTop: 4, flexWrap: "wrap" }}>
              <input
                type="date"
                aria-label={t("pipeline.expectedStart")}
                value={startDraft}
                onChange={(e) => setStartDraft(e.target.value)}
              />
              <button
                type="button"
                className="button-like active-pill"
                disabled={busy}
                onClick={() => start.mutate(startDraft)}
              >
                {start.isPending ? t("pipeline.saving") : t("pipeline.save")}
              </button>
              <button type="button" className="link" onClick={() => setEditing(null)}>
                {t("pipeline.cancel")}
              </button>
            </div>
          )}
        </div>

        {hasPipelineColumns && (
          <div>
            <dt className="field-label">{t("pipeline.materialsEta")}</dt>
            <dd style={{ margin: 0 }}>
              {shortDay(project.materials_eta, lang) || t("pipeline.notSet")}
            </dd>
            {isLead && editing !== "eta" && (
              <button
                type="button"
                className="link"
                disabled={busy}
                onClick={() => {
                  setEtaDraft(project.materials_eta?.slice(0, 10) ?? "");
                  setEditing("eta");
                }}
              >
                {t("pipeline.change")}
              </button>
            )}
            {isLead && editing === "eta" && (
              <div className="row-gap" style={{ marginTop: 4, flexWrap: "wrap" }}>
                <input
                  type="date"
                  aria-label={t("pipeline.materialsEta")}
                  value={etaDraft}
                  onChange={(e) => setEtaDraft(e.target.value)}
                />
                <button
                  type="button"
                  className="button-like active-pill"
                  disabled={busy}
                  onClick={() =>
                    materials.mutate(
                      etaDraft ? { eta: etaDraft } : { clearEta: true },
                    )
                  }
                >
                  {materials.isPending ? t("pipeline.saving") : t("pipeline.save")}
                </button>
                <button type="button" className="link" onClick={() => setEditing(null)}>
                  {t("pipeline.cancel")}
                </button>
              </div>
            )}
          </div>
        )}

        {hasPipelineColumns && (
          <div>
            <dt className="field-label">{t("pipeline.materialsArrived")}</dt>
            <dd style={{ margin: 0 }}>
              {arrived
                ? t("pipeline.arrivedOn", { date: shortDay(arrived, lang) })
                : t("pipeline.notArrivedYet")}
            </dd>
            {isLead && (
              <button
                type="button"
                // One tap, and a 48px target because it is pressed in gloves in
                // a driveway with a truck still running.
                className={arrived ? "link" : "action-btn"}
                style={arrived ? undefined : { minHeight: 48, marginTop: 6 }}
                disabled={busy}
                onClick={() => materials.mutate({ arrived: !arrived })}
              >
                {arrived
                  ? t("pipeline.undoArrived")
                  : materials.isPending
                    ? t("pipeline.saving")
                    : t("pipeline.materialsArrived")}
              </button>
            )}
          </div>
        )}

        {/* WAVE H (H1) SEAM. The GC check-in has no table yet, so this reads
            "None yet" for every job — which is true, and is the only honest
            thing it can say. H replaces the value with the latest check-in and
            adds "Log a GC check-in" beside it; the line is here now so the
            card's shape does not change under a crew that has learned it. */}
        <div>
          <dt className="field-label">{t("pipeline.lastCheckin")}</dt>
          <dd style={{ margin: 0 }} className="muted">
            {t("pipeline.noCheckinYet")}
          </dd>
        </div>
      </dl>

      {call.call && (
        <p className="wh-row-sub" style={{ marginTop: 8 }}>
          {call.reasons
            .map((r) =>
              r === "not_ready"
                ? t("pipeline.reason.notReady")
                : r === "materials_missing"
                  ? t("pipeline.reason.materialsMissing")
                  : r === "materials_late"
                    ? t("pipeline.reason.materialsLate")
                    : t("pipeline.reason.noCheckin"),
            )
            .join(" · ")}
        </p>
      )}

      {message && <p className="error">{message}</p>}
    </section>
  );
}
