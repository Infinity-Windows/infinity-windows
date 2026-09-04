// The job Overview's door to "Add a missed unit" (wave E).
//
// Self-contained on purpose: it fetches the one thing the sheet needs that the
// Overview does not already hold (who is signed in), so adding this entry point
// costs the Overview one line and no new props. The map's own entry point does
// NOT go through this — it has a tapped point to hand over, which is the whole
// difference between the two doors.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useT } from "../../lib/i18n";
import { getMyProfile } from "../../lib/install/api";
import { pushToast } from "../../lib/toast";
import { AddMissedUnitSheet } from "./AddMissedUnitSheet";

export function MissedUnitButton({
  projectId,
  jobName,
}: {
  projectId: string;
  jobName: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="action-btn" onClick={() => setOpen(true)}>
        {t("missed.add")}
      </button>
    );
  }
  return (
    <AddMissedUnitSheet
      projectId={projectId}
      jobName={jobName}
      callerId={me.data?.id ?? null}
      callerName={me.data?.display_name ?? null}
      // From here there is no drawing to tap, so the unit lands unplaced and
      // the sheet says so rather than pretending a spot was chosen.
      pin={null}
      hasMap={false}
      onClose={() => setOpen(false)}
      onAdded={(code) => {
        setOpen(false);
        pushToast(t("missed.added", { code }));
        void queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
      }}
    />
  );
}
