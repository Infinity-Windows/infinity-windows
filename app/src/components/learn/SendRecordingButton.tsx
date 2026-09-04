// "Send a recording" — wave U, U2 (owner's design, Q15).
//
// One tap on Learn and on My Work. It opens the phone's own mail composer,
// already addressed to the leads on the job this person is clocked into, with
// "Recording — Sand Hollow — Sep 3, 2026" in the subject. The lead puts the
// clip on YouTube and a supervisor pastes the link into Learn — the app never
// holds the file. See lib/recordings.ts for why this is a mailto: and not the
// Web Share API.
//
// Everything it reads is already cached: My Work asks for the same profile and
// the same open shift under the same query keys, so on the screen that matters
// most this costs one extra request — the address book — and nothing else.

import { useQuery } from "@tanstack/react-query";
import { Video } from "lucide-react";
import { getMyProfile } from "../../lib/install/api";
import { useLanguage, useT } from "../../lib/i18n";
import {
  buildRecordingMail,
  listForemanContacts,
  recordingDateLabel,
} from "../../lib/recordings";
import { getOpenShift } from "../../lib/timeclock";

export function SendRecordingButton({ style }: { style?: React.CSSProperties }) {
  const t = useT();
  const { lang } = useLanguage();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const shift = useQuery({
    queryKey: ["openShift", me.data?.id],
    queryFn: () => getOpenShift(me.data!.id),
    enabled: Boolean(me.data?.id),
  });
  const contacts = useQuery({
    queryKey: ["foremanContacts"],
    queryFn: listForemanContacts,
    // The address book only changes when somebody is hired or moves jobs, and
    // an installer taps this button once a week. An hour is plenty.
    staleTime: 60 * 60 * 1000,
  });

  // The job's real name if the shift names one, its code otherwise, and
  // nothing at all when the person is off the clock or on a general cost code
  // — the subject then just says the day.
  const job =
    shift.data?.projects?.name?.trim() || shift.data?.projects?.job_code?.trim() || null;
  const date = recordingDateLabel(new Date(), lang);
  const subject = job
    ? t("recording.subject", { job, date })
    : t("recording.subjectNoJob", { date });

  const mail = buildRecordingMail({
    contacts: contacts.data ?? [],
    subject,
    body: t("recording.body"),
  });

  return (
    <div style={style}>
      <a className="button-like active-pill" href={mail.href} data-testid="send-recording">
        <Video size={14} aria-hidden style={{ verticalAlign: "-2px", marginRight: 6 }} />
        {t("recording.send")}
      </a>
      <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
        {mail.to.length > 0 ? t("recording.help") : t("recording.noLead")}
      </p>
    </div>
  );
}
