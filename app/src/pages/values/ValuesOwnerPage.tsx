/**
 * /values/owner — the owner-only review matrix (20261106000000).
 *
 * Named, raw review data: every subject's weighted mirror, who reviewed
 * them, and their comments. values_owner_report() re-checks owner authority
 * on every call; this page is never mounted for a previewed role (it is
 * gated by realRole in App.tsx, not effectiveRole) and never shares its
 * query cache with the crew-facing /values page.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BackChip } from "../../components/BackChip";
import { useT } from "../../lib/i18n";
import { useValuesT } from "../../lib/i18n/valuesCatalog";
import { fetchValuesOwnerReport, setValuesSchedulerEnabled } from "../../lib/values/api";
import { VALUE_SLUGS, rubricBySlug } from "../../lib/values/rubric";

export function ValuesOwnerPage() {
  const t = useT();
  const vt = useValuesT();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const report = useQuery({ queryKey: ["valuesOwnerReport"], queryFn: fetchValuesOwnerReport });

  async function toggleScheduler(next: boolean) {
    setBusy(true);
    try {
      await setValuesSchedulerEnabled(next);
      await qc.invalidateQueries({ queryKey: ["valuesOwnerReport"] });
    } finally {
      setBusy(false);
    }
  }

  if (!report.data) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>{vt("values.owner.heading")}</h1>
          <BackChip label={t("settings.back")} />
        </header>
        {report.isError ? <p role="alert">{vt("values.owner.ownerOnly")}</p> : <p className="muted">…</p>}
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
      </section>

      {report.data.people.map((person) => (
        <section key={person.userId} className="detail-card" style={{ marginBottom: 12 }}>
          <h3 style={{ marginTop: 0 }}>{person.name}</h3>
          {person.owedCount > 0 && <p className="muted">{vt("values.owner.owed", { count: person.owedCount })}</p>}
          <table style={{ width: "100%", fontSize: 13 }}>
            <tbody>
              {VALUE_SLUGS.map((slug) => {
                const row = person.mirror.byValue[slug];
                return (
                  <tr key={slug}>
                    <td>{rubricBySlug(slug)?.title ?? slug}</td>
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
