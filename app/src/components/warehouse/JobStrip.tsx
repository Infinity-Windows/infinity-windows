// Jobs on the yard: one chip per job with material, in the job's own colour
// (the same hue the yard stripes its boxes with), a fill bar for units here
// versus expected, and a tap that lights up the boxes holding that job's
// material. The job code is a link to the materials ledger, as the old
// tally rows were.
import { Link } from "react-router-dom";
import type { JobChip } from "../../lib/warehouse/jobStrip";
import { scopeHref } from "../../lib/warehouse/materialsScope";
import { useT } from "../../lib/i18n";

export function JobStrip({
  chips,
  selected,
  onSelect,
}: {
  chips: JobChip[];
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const t = useT();
  if (chips.length === 0) return null;
  return (
    <section aria-label={t("warehouse.jobStrip.ariaLabel")}>
      <h2 className="job-strip-title">{t("warehouse.jobStrip.title")}</h2>
      <div className="job-strip" role="group" aria-label={t("warehouse.jobStrip.ariaLabel")}>
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`job-chip${selected === c.key ? " job-chip--on" : ""}${c.ready ? "" : " job-chip--waiting"}`}
            style={{ borderLeftColor: `oklch(0.62 0.15 ${c.hue})` }}
            onClick={() => onSelect(selected === c.key ? null : c.key)}
            aria-pressed={selected === c.key}
            title={selected === c.key ? t("warehouse.jobStrip.tapAgain") : t("warehouse.jobStrip.tapToLight")}
          >
            <span className="job-chip-head">
              <Link
                to={scopeHref({ projectId: c.projectId, pendingName: c.pendingName })}
                onClick={(e) => e.stopPropagation()}
              >
                {c.projectId ? c.label : `“${c.label}”`}
              </Link>
              <span className={c.ready ? "ok" : ""}>{c.line}</span>
            </span>
            {c.projectId ? (
              <Link
                className="job-chip-send"
                to={`/warehouse/send/${c.projectId}`}
                onClick={(e) => e.stopPropagation()}
                title={t("warehouse.jobStrip.sendHint")}
              >
                {t("warehouse.jobStrip.sendToSite")}
              </Link>
            ) : null}
            <span className="job-chip-bar" aria-hidden="true">
              <i style={{ width: `${c.total > 0 ? Math.round((c.here / c.total) * 100) : 0}%` }} />
            </span>
          </button>
        ))}
      </div>
      <p className="muted job-strip-hint">{t("warehouse.jobStrip.hint")}</p>
    </section>
  );
}
