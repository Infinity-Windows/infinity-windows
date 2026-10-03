/**
 * /values — the monthly core-value review (20261106000000).
 *
 * A compact, lazy route reached from Settings → My values. Shows what the
 * signed-in person currently owes, lets them open one person's form at a
 * time, and shows their own rolling/all-time/quarterly numbers underneath.
 * Never mounted as part of any owner query — see ValuesOwnerPage for that.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BackChip } from "../../components/BackChip";
import { useT } from "../../lib/i18n";
import { useValuesT, VALUE_RUBRICS_ES } from "../../lib/i18n/valuesCatalog";
import { useLanguage } from "../../lib/i18n/context";
import { signedInUserId, signInGeneration, subscribeSignedIn } from "../../lib/signedIn";
import { useConnection } from "../../lib/offline/useWeakSignal";
import { fetchMyValuesSummary, fetchMyValuesTasks, type ValuesTask } from "../../lib/values/api";
import { VALUE_SLUGS, rubricBySlug, type CoreValueSlug } from "../../lib/values/rubric";
import { ValueScoreForm } from "../../components/values/ValueScoreForm";

function periodLabel(periodStart: string, lang: string): string {
  const [y, m] = periodStart.split("-").map(Number);
  return new Intl.DateTimeFormat(lang === "es" ? "es" : "en", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, (m ?? 1) - 1, 1)));
}

export function ValuesPage() {
  // A shared string (the back chip) goes through the main catalog directly —
  // useValuesT() below proxies non-"values." keys to the same t(), but this
  // call keeps the page itself unambiguously bilingual on its own.
  const t = useT();
  const vt = useValuesT();
  const { lang } = useLanguage();
  const ownerId = useSyncExternalStore(subscribeSignedIn, signedInUserId, signedInUserId);
  const authGeneration = useSyncExternalStore(subscribeSignedIn, signInGeneration, signInGeneration);
  const { online } = useConnection();
  const qc = useQueryClient();
  const [openReview, setOpenReview] = useState<{ ownerId: string; generation: number; task: ValuesTask } | null>(null);
  useEffect(() => { setOpenReview(null); }, [ownerId, authGeneration]);

  const tasks = useQuery({ queryKey: ["valuesMyTasks", ownerId, authGeneration], queryFn: fetchMyValuesTasks, enabled: Boolean(ownerId && online), refetchOnMount: "always", networkMode: "online", retry: false, gcTime: 0 });
  const summary = useQuery({ queryKey: ["valuesMySummary", ownerId, authGeneration], queryFn: fetchMyValuesSummary, enabled: Boolean(ownerId && online), refetchOnMount: "always", networkMode: "online", retry: false, gcTime: 0 });

  const pending = useMemo(() => (tasks.data ?? []).filter((x) => x.status === "pending"), [tasks.data]);
  const done = useMemo(() => (tasks.data ?? []).filter((x) => x.status === "submitted"), [tasks.data]);
  // Keep the user's already-open draft mounted through signal loss/refetch.
  // This snapshot belongs to exactly one sign-in; reports still require a
  // fresh online response below, and the server authorizes every submission.
  const openTask = openReview?.ownerId === ownerId && openReview?.generation === authGeneration ? openReview.task : undefined;

  if (openTask) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>{vt("values.form.subjectHeading", { name: openTask.subjectName })}</h1>
        </header>
        <p className="muted">{vt("values.form.period", { month: periodLabel(openTask.periodStart, lang) })}</p>
        <p className="muted">{vt("values.confidential")}</p>
        <ValueScoreForm
          key={`${ownerId}:${authGeneration}:${openTask.assignmentId}`}
          assignmentId={openTask.assignmentId}
          ownerId={ownerId!}
          rubricVersion={openTask.rubricVersion}
          onDone={() => {
            qc.invalidateQueries({ queryKey: ["valuesMySummary", ownerId, authGeneration] });
          }}
        />
        <button type="button" className="button-like" onClick={() => {
          setOpenReview(null);
          qc.invalidateQueries({ queryKey: ["valuesMyTasks", ownerId, authGeneration] });
        }}>
          {vt("values.form.back")}
        </button>
      </div>
    );
  }

  const mirror = summary.data?.mirror.byValue;
  const allTime = summary.data?.allTime.byValue;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">{vt("values.pageTitle")}</p>
          <h1>{vt("values.pageTitle")}</h1>
        </div>
        <BackChip label={t("settings.back")} />
      </header>

      <section className="detail-card" style={{ marginBottom: 12 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{vt("values.intro.heading")}</h2>
        <p className="muted" style={{ marginTop: 0 }}>{vt("values.intro.body")}</p>
        <p className="muted" style={{ marginTop: 0 }}>{vt("values.confidential")}</p>
      </section>

      <section className="detail-card" style={{ marginBottom: 12 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{vt("values.tasks.heading")}</h2>
        {!online || tasks.fetchStatus === "paused" || tasks.isError ? <p role="alert">{vt("values.tasks.unavailable")}</p> : !ownerId || tasks.isPending || tasks.isFetching ? <p className="muted">{vt("values.tasks.loading")}</p> : pending.length === 0 ? (
          <p className="muted">{vt("values.tasks.allDone")}</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {pending.map((task) => (
              <li key={task.assignmentId} style={{ marginBottom: 8 }}>
                <button
                  type="button"
                  className="button-like"
                  style={{ width: "100%", textAlign: "left" }}
                  onClick={() => { if (ownerId) setOpenReview({ ownerId, generation: authGeneration, task }); }}
                >
                  {task.subjectName} — {periodLabel(task.periodStart, lang)} · {vt("values.tasks.pending")}
                </button>
              </li>
            ))}
          </ul>
        )}
        {online && tasks.isSuccess && !tasks.isFetching && tasks.fetchStatus !== "paused" && done.length > 0 && (
          <p className="muted" style={{ marginTop: 8 }}>
            {done.length} {vt("values.tasks.done")}
          </p>
        )}
      </section>

      {(summary.isPending || summary.isFetching) && online && summary.fetchStatus !== "paused" && <p className="muted">{vt("values.summary.loading")}</p>}
      {(!online || summary.fetchStatus === "paused" || summary.isError || (summary.isSuccess && !summary.data)) && <p role="alert">{vt("values.summary.unavailable")}</p>}
      {online && summary.isSuccess && !summary.isFetching && summary.fetchStatus !== "paused" && summary.data && (
        <section className="detail-card" style={{ marginBottom: 12 }}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>{vt("values.summary.heading")}</h2>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            {vt("values.summary.windowLabel", { start: summary.data.windowStart, end: summary.data.windowEnd })}
          </p>
          <table style={{ width: "100%", fontSize: 14 }}>
            <tbody>
              {VALUE_SLUGS.map((slug: CoreValueSlug) => {
                const rubric = rubricBySlug(slug);
                const row = mirror?.[slug];
                const all = allTime?.[slug];
                return (
                  <tr key={slug}>
                    <td>{lang === "es" ? VALUE_RUBRICS_ES[slug].title : rubric?.title ?? slug}</td>
                    <td>{row?.average != null ? row.average.toFixed(1) : vt("values.summary.suppressed")}</td>
                    <td className="muted">{vt("values.summary.allTime")}: {all?.average != null ? all.average.toFixed(1) : "—"}</td>
                    <td className="muted">{vt("values.summary.self")}: {row?.self != null ? row.self.toFixed(1) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {online && summary.isSuccess && !summary.isFetching && summary.fetchStatus !== "paused" && summary.data && (
        <section className="detail-card" style={{ marginBottom: 12 }}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>{vt("values.summary.quarters.heading")}</h2>
          {summary.data.quarters.length === 0 ? (
            <p className="muted">{vt("values.summary.quarters.empty")}</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {summary.data.quarters.map((q) => (
                <li key={q.quarterStart}>
                  {q.quarterStart}: {q.overall != null ? q.overall.toFixed(1) : vt("values.summary.suppressed")}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
