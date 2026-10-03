/**
 * /values/owner — the owner-only review matrix (20261106000000).
 *
 * Named, raw review data: every subject's weighted mirror, who reviewed
 * them, and their comments. values_owner_report() re-checks owner authority
 * on every call; this page is never mounted for a previewed role (it is
 * gated by realRole in App.tsx, not effectiveRole) and never shares its
 * query cache with the crew-facing /values page.
 */
import { useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BackChip } from "../../components/BackChip";
import { useT } from "../../lib/i18n";
import { useValuesT, VALUE_RUBRICS_ES } from "../../lib/i18n/valuesCatalog";
import { useLanguage } from "../../lib/i18n/context";
import { fetchValuesOwnerReport, setValuesSchedulerEnabled } from "../../lib/values/api";
import { VALUE_SLUGS, rubricBySlug } from "../../lib/values/rubric";
import { signedInUserId, signInGeneration, subscribeSignedIn } from "../../lib/signedIn";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { useConnection } from "../../lib/offline/useWeakSignal";

export function ValuesOwnerPage() {
  const t = useT();
  const vt = useValuesT();
  const { lang } = useLanguage();
  const qc = useQueryClient();
  const ownerId = useSyncExternalStore(subscribeSignedIn, signedInUserId, signedInUserId);
  const authGeneration = useSyncExternalStore(subscribeSignedIn, signInGeneration, signInGeneration);
  const { online } = useConnection();
  const { realRole, isPreviewing } = useEffectiveRole();
  const [busy, setBusy] = useState(false);
  const [toggleError, setToggleError] = useState(false);
  const [mountKey] = useState(() => crypto.randomUUID());
  const authorized = Boolean(ownerId && realRole === "owner" && !isPreviewing);
  const report = useQuery({ queryKey: ["valuesOwnerReport", ownerId, authGeneration, mountKey], queryFn: fetchValuesOwnerReport, enabled: authorized && online, refetchOnMount: "always", networkMode: "online", retry: false, gcTime: 0, staleTime: 0 });

  async function toggleScheduler(next: boolean) {
    setBusy(true);
    setToggleError(false);
    try {
      await setValuesSchedulerEnabled(next);
      await qc.invalidateQueries({ queryKey: ["valuesOwnerReport", ownerId, authGeneration, mountKey] });
    } catch {
      setToggleError(true);
    } finally {
      setBusy(false);
    }
  }

  if (!authorized || !online || report.fetchStatus === "paused" || !report.isSuccess || report.isFetching || !report.data) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>{vt("values.owner.heading")}</h1>
          <BackChip label={t("settings.back")} />
        </header>
        {!authorized ? <p role="alert">{vt("values.owner.ownerOnly")}</p> : !online || report.fetchStatus === "paused" || report.isError || (report.isSuccess && !report.data) ? <p role="alert">{vt("values.owner.unavailable")}</p> : <p className="muted">{vt("values.tasks.loading")}</p>}
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">{vt("values.owner.heading")}</p>
          <h1>{vt("values.owner.heading")}</h1>
        </div>
        <BackChip label={t("settings.back")} />
      </header>

      <p className="muted">{vt("values.owner.periodLabel", { month: report.data.periodStart })}</p>

      <section className="detail-card" style={{ marginBottom: 12 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>{vt("values.owner.schedulerHeading")}</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>{vt("values.owner.schedulerHelp")}</p>
        <p>{report.data.schedulerEnabled ? vt("values.owner.schedulerOn") : vt("values.owner.schedulerOff")}</p>
        <button
          type="button"
          className="action-btn"
          disabled={busy}
          onClick={() => toggleScheduler(!report.data!.schedulerEnabled)}
        >
          {report.data.schedulerEnabled ? vt("values.owner.turnOff") : vt("values.owner.turnOn")}
        </button>
        {toggleError && <p role="alert">{vt("values.owner.toggleError")}</p>}
      </section>

      {report.data.people.map((person) => (
        <section key={person.userId} className="detail-card" style={{ marginBottom: 12 }}>
          <h3 style={{ marginTop: 0 }}>{person.name}</h3>
          {person.owedCount > 0 && <p className="muted">{vt("values.owner.owed", { count: person.owedCount })}</p>}
          <div className="row-gap" style={{ fontSize: 13 }}>
            {!person.retired && <span>{person.suspended ? vt("values.owner.suspended") : vt("values.owner.accessActive")}</span>}
            <span>{person.retired ? vt("values.owner.retired") : vt("values.owner.notRetired")}</span>
          </div>
          {person.asRater && person.coverage ? <>
            <h4 style={{ marginBottom: 6 }}>{vt("values.owner.asRater")}</h4>
            <dl style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "4px 12px", margin: 0, fontSize: 13 }}>
              <div><dt>{vt("values.owner.assigned")}</dt><dd style={{ margin: 0, fontWeight: 600 }}>{person.asRater.assigned}</dd></div>
              <div><dt>{vt("values.owner.accepted")}</dt><dd style={{ margin: 0, fontWeight: 600 }}>{person.asRater.accepted}</dd></div>
              <div><dt>{vt("values.owner.late")}</dt><dd style={{ margin: 0, fontWeight: 600 }}>{person.asRater.late}</dd></div>
              <div><dt>{vt("values.owner.pending")}</dt><dd style={{ margin: 0, fontWeight: 600 }}>{person.asRater.pending}</dd></div>
              <div><dt>{vt("values.owner.canceled")}</dt><dd style={{ margin: 0, fontWeight: 600 }}>{person.asRater.canceled}</dd></div>
              <div><dt>{vt("values.owner.suspendedReviews")}</dt><dd style={{ margin: 0, fontWeight: 600 }}>{person.asRater.suspended}</dd></div>
            </dl>
            <p style={{ marginBottom: 6, fontSize: 13 }}>
              {vt("values.owner.coverage", { actual: person.coverage.actualReceived, expected: person.coverage.expectedReceived })}
              {" · "}{person.coverage.missingCoverage ? vt("values.owner.coverageMissing") : vt("values.owner.coverageMet")}
            </p>
          </> : <p role="alert">{vt("values.owner.lifecycleUnavailable")}</p>}
          <table style={{ width: "100%", fontSize: 13 }}>
            <tbody>
              {VALUE_SLUGS.map((slug) => {
                const row = person.mirror.byValue[slug];
                return (
                  <tr key={slug}>
                    <td>{lang === "es" ? VALUE_RUBRICS_ES[slug].title : rubricBySlug(slug)?.title ?? slug}</td>
                    <td>{row?.average != null ? row.average.toFixed(1) : "—"}</td>
                    <td className="muted">({row?.raters ?? 0})</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {person.received.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary>{vt("values.owner.received")} ({person.received.length})</summary>
              <ul>
                {person.received.map((r, i) => (
                  <li key={i}>
                    {r.raterName} ({r.raterClass}{r.solo ? ", solo" : ""}) — {r.periodStart}
                    {r.comment ? `: "${r.comment}"` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      ))}
    </div>
  );
}
