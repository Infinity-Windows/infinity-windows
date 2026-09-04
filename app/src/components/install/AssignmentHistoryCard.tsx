// A job's hand-over log: who has had which unit, and who moved it (wave Y, Y5).
//
// `project_openings.assigned_to` is one column that gets overwritten, so before
// this the previous assignee was simply gone, and every "why has this been
// sitting for two days" conversation ran into that wall.
//
// It lives here rather than inside one screen because it belongs on two: the
// Dispatch tab, where a foreman is handing work out right now, and Job history,
// where somebody is reading a finished job back. Both ask the same question of
// the same rows, so they get the same card rather than two that drift.
//
// It fetches its own names and mark codes, under the SAME query keys the
// dispatch board uses — so on Dispatch it costs nothing (the cache is already
// warm) and on Job history it is one lazy read of the job you actually opened.
// Folded shut by default: this is what you go and look at when something is
// wrong, not something to read every morning, and a hundred hand-overs would
// push the screen it sits on out of the way.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  assignmentText,
  listProjectAssignmentEvents,
} from "../../lib/install/assignmentHistory";
import { listOpenings, listProfilesIncludingRemoved } from "../../lib/install/api";
import { useT } from "../../lib/i18n";

export function AssignmentHistoryCard({ projectId }: { projectId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const events = useQuery({
    queryKey: ["projectAssignments", projectId],
    queryFn: () => listProjectAssignmentEvents(projectId),
    enabled: open,
  });
  // Same keys the dispatch board already uses, so opening this there is a cache
  // hit and not a second trip for rows the screen is holding anyway.
  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
    enabled: open,
  });
  const crew = useQuery({
    queryKey: ["profilesIncludingRemoved"],
    queryFn: listProfilesIncludingRemoved,
    enabled: open,
  });

  const rows = events.data ?? [];
  const codeOf = (id: string) =>
    (openings.data ?? []).find((o) => o.id === id)?.opening_code;
  const nameOf = (id: string) =>
    (crew.data ?? []).find((c) => c.id === id)?.display_name;

  return (
    <div className="detail-card wh-card">
      {!open ? (
        <button className="button-like" onClick={() => setOpen(true)}>
          {t("assign.historyOpen")}
        </button>
      ) : (
        <>
          <span className="field-label">{t("assign.history")}</span>
          {events.isLoading && <p className="muted">{t("assign.historyLoading")}</p>}
          {!events.isLoading && rows.length === 0 && (
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
              {t("assign.historyEmpty")}
            </p>
          )}
          <ul className="unit-list" style={{ marginTop: 4 }}>
            {rows.map((e) => (
              <li key={e.id} className="muted" style={{ fontSize: 12.5 }}>
                <strong>{codeOf(e.opening_id) ?? t("assign.unit")}</strong>{" "}
                {assignmentText(e, nameOf, t)}
                {" · "}
                {new Date(e.changed_at).toLocaleString(undefined, {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </li>
            ))}
          </ul>
          <button
            className="button-like"
            style={{ marginTop: 10 }}
            onClick={() => setOpen(false)}
          >
            {t("assign.historyClose")}
          </button>
        </>
      )}
    </div>
  );
}
