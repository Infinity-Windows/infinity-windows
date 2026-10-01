import { useLanguage, useT } from "../../lib/i18n";
import "../../lib/i18n/scheduleConflictCatalog";
import { formatConflictClock } from "../../lib/schedule/conflictDisplay";
import type { ConflictBannerEntry } from "../../lib/schedule/conflicts";
import { clashRangeLabel } from "../../lib/schedule/dates";

export function ConflictPairDetails({ entry, jobLabelOf }: {
  entry: ConflictBannerEntry;
  jobLabelOf: (assignmentId: string) => string;
}) {
  const t = useT();
  const { lang } = useLanguage();
  const clock = (value: string | null) => formatConflictClock(value, lang)
    ?? t(value ? "schedConflict.checkTime" : "schedConflict.timeNotSet");
  const hours = (time: ConflictBannerEntry["aTime"]) => !time.start && !time.end
    ? t("schedConflict.noHoursSet")
    : `${clock(time.start)}–${clock(time.end)}`;
  return (
    <div className="sched-pair-details">
      <div>{jobLabelOf(entry.aId)} · {hours(entry.aTime)}</div>
      <div>{jobLabelOf(entry.bId)} · {hours(entry.bTime)}</div>
      <div className="sched-pair-overlap">
        {entry.kind === "confirmed" && entry.timeOverlap
          ? t("schedConflict.dailyOverlap", { hours: hours(entry.timeOverlap) })
          : t("schedConflict.checkHoursAction")}
      </div>
      <div className="muted">{clashRangeLabel(entry.overlap.start, entry.overlap.end)}</div>
    </div>
  );
}
