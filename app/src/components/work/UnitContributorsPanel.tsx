import type { Lang } from "../../lib/i18n/translate";
import { workContributorsText, type WorkContributorsKey } from "../../lib/i18n/workContributorsCatalog";
import { durationMicros } from "../../lib/workActivityTotals/format";
import { formatUnitContributions } from "../../lib/workUnitContributions/format";
import type { ContributionReason, ContributorActivity, ContributorPerson, NamedContributor, NamedSourceKind, UnitContributorsView } from "../../lib/workUnitContributions/protocol";
import "./UnitContributorsPanel.css";

export interface UnitContributorsPanelRead {
  state: "held" | "loading" | "ready" | "unavailable";
  data: UnitContributorsView | null;
}
export interface UnitContributorsPanelProps {
  locale: Lang;
  read: UnitContributorsPanelRead;
  onCheck: () => void;
  disabled?: boolean;
  busy?: boolean;
}

const reasonKeys: Record<Exclude<ContributionReason, "zero">, WorkContributorsKey> = {
  open_shift: "openShift", named_unlinked: "namedUnlinked", legacy_unmapped: "legacyUnmapped",
  source_unproven: "sourceUnproven", identity_unproven: "identityUnproven", negative_interval: "negativeInterval",
};
const sourceKeys: Record<NamedSourceKind, WorkContributorsKey> = {
  crew_work_record_people: "crewRecord", install_events: "installEvent", opening_phases: "openingPhase",
  qc_checks: "qcCheck", work_unit_review_events: "reviewEvent",
};
const machineKeys: Record<string, WorkContributorsKey> = {
  forklift: "forklift", scissor_lift: "scissorLift", tele_handler: "telehandler",
  boom_lift: "boomLift", spider_suction: "spider",
};

/** Preserve subsecond recorded amounts while retaining the familiar H:MM:SS form. */
function exactDuration(micros: string): string {
  const whole = durationMicros(micros), fraction = BigInt(micros) % 1_000_000n;
  return fraction === 0n ? whole : `${whole}.${String(fraction).padStart(6, "0").replace(/0+$/, "")}`;
}
function personName(person: ContributorPerson | NamedContributor, locale: Lang): string {
  return person.nameState === "current" && person.displayName?.trim()
    ? person.displayName : workContributorsText(locale, "unknownPerson");
}
function distinctiveSuffix(id: string, peers: readonly string[]): string {
  for (let size = 4; size <= id.length; size++) {
    const suffix = id.slice(-size);
    if (peers.every(other => other === id || !other.endsWith(suffix))) return suffix;
  }
  return id;
}
function machineName(kind: string, locale: Lang): string {
  const known = Object.hasOwn(machineKeys, kind) ? machineKeys[kind] : undefined;
  return known ? workContributorsText(locale, known)
    : kind.replace(/[_-]+/g, " ").trim() || workContributorsText(locale, "machine");
}
function activityName(row: ContributorActivity, locale: Lang): string {
  return (locale === "es" ? row.labelEs || row.labelEn : row.labelEn || row.labelEs).trim()
    || workContributorsText(locale, "unknownTask");
}
function activityRows(person: ContributorPerson, locale: Lang) {
  const t = (key: WorkContributorsKey, vars?: Record<string, string | number>) => workContributorsText(locale, key, vars);
  if (!person.activities.length) return <p className="unit-contrib-muted">{t("noTasks")}</p>;
  return <ul className="unit-contrib-task-list">{person.activities.map(activity => <li key={activity.definitionVersionId}>
    <div className="unit-contrib-task-line">
      <span className="unit-contrib-task-name">{activityName(activity, locale)} <small>· {t("version", { number: activity.definitionVersion })}{activity.retired && ` · ${t("retiredTask")}`}</small></span>
      <strong>{exactDuration(activity.knownMicros)}</strong>
    </div>
    {activity.machineSubsets.length > 0 && <div className="unit-contrib-machines">
      {activity.machineSubsets.map(machine => <p key={machine.machineKind}>{machineName(machine.machineKind, locale)} · {exactDuration(machine.knownMicros)}</p>)}
      <small>{t("machineIncluded")}</small>
    </div>}
  </li>)}</ul>;
}

/** Deliberately presentational: only a checked, parsed snapshot may reach this panel. */
export function UnitContributorsPanel({ locale, read, onCheck, disabled = false, busy = false }: UnitContributorsPanelProps) {
  const t = (key: WorkContributorsKey, vars?: Record<string, string | number>) => workContributorsText(locale, key, vars);
  // Explicitly select the small formatter domain. Never spread the whole private wire reply.
  const candidate = read.state === "ready" ? read.data : null;
  const formatted = candidate ? formatUnitContributions({
    unitKnownMicros: candidate.unitKnownMicros, unitComplete: candidate.unitComplete,
    people: candidate.people.map(person => ({ profileId: person.profileId, knownMicros: person.knownMicros, complete: person.complete })),
  }) : null;
  const view = formatted?.state === "available" ? candidate : null;
  const status = read.state === "loading" ? t("loading") : read.state === "held" ? t("held") : t("unavailable");
  const measuredIds = new Set(view?.people.map(person => person.profileId) ?? []);
  const visibleNames = new Map<string, string[]>();
  for (const person of [...(view?.people ?? []), ...(view?.untimedParticipants ?? []), ...(view?.zeroOnly ?? [])]) {
    const name = personName(person, locale);
    visibleNames.set(name, [...new Set([...(visibleNames.get(name) ?? []), person.profileId])]);
  }
  const identityCue = (person: ContributorPerson | NamedContributor, full = false) => {
    const peers = visibleNames.get(personName(person, locale)) ?? [];
    return peers.length > 1 ? <small>{t("personReference")}: {full
      ? <code>{person.profileId}</code> : `…${distinctiveSuffix(person.profileId, peers)}`}</small> : null;
  };
  const percentageById = new Map(formatted?.state === "available"
    ? formatted.people.map(person => [person.profileId, person.percentage] as const) : []);
  const partialReasons = view?.unresolvedAttribution.reasons.filter(reason => reason !== "zero") ?? [];
  const when = view ? new Date(view.asOf).toLocaleString(locale === "es" ? "es-US" : "en-US", { dateStyle: "medium", timeStyle: "short" }) : "";

  return <section className="unit-contrib-panel" aria-label={t("title")}>
    <header className="unit-contrib-header">
      <div><p className="unit-contrib-eyebrow">{t("total")}</p><h2>{t("title")}</h2></div>
      <button type="button" className="unit-contrib-check" onClick={() => void onCheck()}
        disabled={disabled || busy || read.state === "loading"}>{busy || read.state === "loading" ? t("checking") : t("check")}</button>
    </header>
    {!view || !formatted || formatted.state !== "available" ? <p className="unit-contrib-state" role="status">{status}</p> : <>
      <p className="unit-contrib-snapshot"><time dateTime={view.asOf}>{t("snapshot", { time: when })}</time></p>
      <div className={`unit-contrib-total${view.unitComplete ? "" : " unit-contrib-total--partial"}`}>
        <span>{view.unitComplete ? t("total") : t("partial")}</span>
        <strong>{exactDuration(view.unitKnownMicros)}</strong>
        <small>{t("totalHelp")}</small>
      </div>
      <dl className="unit-contrib-counts">
        <div><dt>{t("peopleEvidence")}</dt><dd>{view.participantCounts.total}</dd></div>
        <div><dt>{t("timed")}</dt><dd>{view.participantCounts.timed}</dd></div>
        <div><dt>{t("uncertain")}</dt><dd>{view.participantCounts.timingUncertain}</dd></div>
        <div><dt>{t("namedOnly")}</dt><dd>{view.participantCounts.untimedOnly}</dd></div>
        {view.participantCounts.zeroOnly > 0 && <div><dt>{t("zeroCount")}</dt><dd>{view.participantCounts.zeroOnly}</dd></div>}
      </dl>
      {!view.unitComplete && <div className="unit-contrib-notice" role="status">
        <strong>{t("partial")}</strong><p>{t("partialHelp")}</p>
        {view.unresolvedAttribution.present && partialReasons.length > 0 && <><p className="unit-contrib-reasons-title">{t("reasonsTitle")}</p><ul>
          {partialReasons.map(reason => <li key={reason}>{t(reasonKeys[reason as Exclude<ContributionReason, "zero">])}</li>)}
        </ul></>}
      </div>}
      {formatted.percentages === "zero_total" && <p className="unit-contrib-notice">{t("zeroTotal")}</p>}
      {view.includesLive && <p className="unit-contrib-muted">{t("liveSnapshot")}</p>}

      <div className="unit-contrib-section-head"><h3>{t("peopleTitle")}</h3><span>{view.participantCounts.timed + view.participantCounts.timingUncertain}</span></div>
      {view.people.length === 0 ? <p className="unit-contrib-muted">{t("noPeople")}</p> : <div className="unit-contrib-person-list">
        {view.people.map(person => {
          const share = percentageById.get(person.profileId);
          const peers = visibleNames.get(personName(person, locale)) ?? [];
          return <details key={person.profileId} className="unit-contrib-person">
            <summary><span className="unit-contrib-person-title"><strong>{personName(person, locale)}</strong>
              {peers.length > 1 && <small>{t("personReference")}: …{distinctiveSuffix(person.profileId, peers)}</small>}
              {person.retired === true && <small>{t("retiredPerson")}</small>}</span>
              <span className="unit-contrib-person-metrics">
                <strong>{person.measurementState === "unproven" ? t("timeUnproven") : exactDuration(person.knownMicros)}</strong>
                <small>{share === null || share === undefined ? t("shareUnavailable") : `${share} ${t("share")}`}</small>
              </span>
            </summary>
            <div className="unit-contrib-person-body">
              {peers.length > 1 && <p className="unit-contrib-muted">{t("personReference")}: <code>{person.profileId}</code></p>}
              <p className="unit-contrib-muted">{person.measurementState === "unproven" ? t("timeUnproven") : person.complete ? t("recorded") : t("known")}</p>
              <h4>{t("tasks")}</h4>{activityRows(person, locale)}
            </div>
          </details>;
        })}
      </div>}
      {formatted.percentages === "available" && <p className="unit-contrib-muted">{t("rounded")}</p>}

      {view.untimedParticipants.length > 0 && <section className="unit-contrib-secondary" aria-label={t("namedTitle")}>
        <div className="unit-contrib-section-head"><h3>{t("namedTitle")}</h3><span>{view.untimedParticipants.length}</span></div>
        <p className="unit-contrib-muted">{t("namedHelp")}</p>
        {view.untimedParticipants.map(person => <details key={person.profileId} className="unit-contrib-person unit-contrib-person--evidence">
          <summary><span className="unit-contrib-person-title"><strong>{personName(person, locale)}</strong>{identityCue(person)}
            {person.retired === true && <small>{t("retiredPerson")}</small>}</span>
            <span className="unit-contrib-person-metrics"><small>{measuredIds.has(person.profileId) ? t("alsoAbove") : t("timeUnproven")}</small></span>
          </summary>
          <div className="unit-contrib-person-body">{identityCue(person, true)}<h4>{t("evidence")}</h4><ul className="unit-contrib-evidence-list">
            {person.evidence.map(entry => <li key={`${entry.sourceKind}:${entry.sourceId}`}>
              <strong>{entry.activityLabel.trim() || t("evidence")}</strong>
              <span>{t("workDate")}: {entry.workDate ?? t("noDate")}</span>
              {entry.recordedAt && <span>{t("recordedAt")}: <time dateTime={entry.recordedAt}>{new Date(entry.recordedAt).toLocaleString(locale === "es" ? "es-US" : "en-US", { dateStyle: "medium", timeStyle: "short" })}</time></span>}
              <span>{t("source")}: {t(sourceKeys[entry.sourceKind])}</span>
              <span>{t("reference")}: <code>{entry.sourceId}</code></span>
            </li>)}
          </ul></div>
        </details>)}
      </section>}

      {view.zeroOnly.length > 0 && <section className="unit-contrib-secondary" aria-label={t("zeroTitle")}>
        <div className="unit-contrib-section-head"><h3>{t("zeroTitle")}</h3><span>{view.zeroOnly.length}</span></div>
        <p className="unit-contrib-muted">{t("zeroHelp")}</p>
        {view.zeroOnly.map(person => <details key={person.profileId} className="unit-contrib-person unit-contrib-person--zero">
          <summary><span className="unit-contrib-person-title"><strong>{personName(person, locale)}</strong>{identityCue(person)}
            {person.retired === true && <small>{t("retiredPerson")}</small>}</span>
            <span className="unit-contrib-person-metrics"><small>{t("zeroTime")}</small></span>
          </summary><div className="unit-contrib-person-body">{identityCue(person, true)}<h4>{t("tasks")}</h4>{activityRows(person, locale)}</div>
        </details>)}
      </section>}
    </>}
  </section>;
}
