// The one line a job card carries about its pipeline (Wave J, J1):
//
//     Not ready · start ~Sep 22 · windows ETA Sep 15
//
// Short on purpose. This sits on a card a foreman scrolls past twenty of on a
// phone, so each fact is a few words and the ones that do not apply are simply
// absent — a job that is ready and whose windows are in shows nothing at all
// rather than three reassuring phrases nobody reads.
//
// The "~" on the start date is doing real work: start_date is the bid/target
// date, and the dates crew actually work are the published crew dates on the
// schedule. It is an intention, and it should look like one.

import { shortDay, type PipelineJob } from "../../lib/pipeline";
import { useLanguage, useT } from "../../lib/i18n";

export function PipelineLine({ job }: { job: PipelineJob }) {
  const t = useT();
  const { lang } = useLanguage();

  const parts: string[] = [];
  if (job.ready_state === "not_ready") parts.push(t("pipeline.notReady"));

  const start = shortDay(job.start_date, lang);
  if (start) parts.push(t("pipeline.card.start", { date: start }));

  // The ETA is only news while the windows are still out. Once they are here,
  // when they were DUE is history, and the card says nothing about it.
  if (!job.materials_arrived_at) {
    const eta = shortDay(job.materials_eta, lang);
    if (eta) parts.push(t("pipeline.card.eta", { date: eta }));
  }

  if (parts.length === 0) return null;
  return (
    <div className="muted job-pipeline-line" style={{ fontSize: 12 }}>
      {parts.join(" · ")}
    </div>
  );
}
