// "Incoming from Monday" (owner decisions, 2026-08-11): jobs synced from the
// Ops Gantt Chart's Ready-to-Schedule/Scheduled groups land here as
// proposals. The office reviews one, gives it a real job code (Monday has
// none), and builds the app project in one tap — or dismisses it. Opening
// the Jobs page nudges the self-throttled sync, so the list stays ~15-min
// fresh during working hours with no cron.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, RefreshCw } from "lucide-react";
import { formatApiError } from "../../lib/errors";
import {
  buildProjectFromMonday,
  dismissMondayJob,
  listIncomingMondayJobs,
  triggerMondaySync,
  type MondayJob,
} from "../../lib/mondaySync";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** PECAN14-style suggestion from the Monday job name — office can override. */
function suggestCode(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, "")
    .trim()
    .split(/\s+/)[0]
    ?.slice(0, 10) ?? "";
}

export function IncomingMondayJobs() {
  const qc = useQueryClient();
  const [building, setBuilding] = useState<MondayJob | null>(null);
  const [jobCode, setJobCode] = useState("");
  const [name, setName] = useState("");
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const incoming = useQuery({
    queryKey: ["mondayIncoming"],
    queryFn: listIncomingMondayJobs,
  });

  // Nudge the sync once per page visit; the function throttles itself.
  useEffect(() => {
    void triggerMondaySync().then((r) => {
      if (r.ok && (r.synced ?? 0) > 0) {
        void qc.invalidateQueries({ queryKey: ["mondayIncoming"] });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncNow = useMutation({
    mutationFn: () => triggerMondaySync(true),
    onSuccess: (r) => {
      setSyncNote(
        r.ok
          ? `Synced ${r.synced ?? 0} job${(r.synced ?? 0) === 1 ? "" : "s"} from Monday.`
          : r.error ?? "Sync failed.",
      );
      void qc.invalidateQueries({ queryKey: ["mondayIncoming"] });
    },
  });

  const build = useMutation({
    mutationFn: (job: MondayJob) =>
      buildProjectFromMonday(job, {
        jobCode,
        name: name.trim() || job.name,
        startDate: job.start_date,
        endDate: job.end_date,
        notes: [
          job.job_type ? `Type: ${job.job_type}` : null,
          job.flashing_note ? `Flashing/Caulk: ${job.flashing_note}` : null,
          `Imported from Monday.com (${job.group_title ?? "Ops Gantt Chart"})`,
        ]
          .filter(Boolean)
          .join("\n"),
      }),
    onSuccess: async () => {
      setBuilding(null);
      await qc.invalidateQueries({ queryKey: ["mondayIncoming"] });
      await qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const dismiss = useMutation({
    mutationFn: dismissMondayJob,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["mondayIncoming"] }),
  });

  const rows = useMemo(() => incoming.data ?? [], [incoming.data]);
  if (rows.length === 0 && !syncNow.isPending && !syncNote) return null;

  return (
    <section style={{ marginTop: 12 }}>
      <div className="row-gap" style={{ alignItems: "baseline" }}>
        <h2 style={{ margin: 0 }}>Incoming from Monday ({rows.length})</h2>
        <button
          className="button-like"
          style={{ marginLeft: "auto", fontSize: 12 }}
          disabled={syncNow.isPending}
          onClick={() => syncNow.mutate()}
        >
          <RefreshCw size={13} aria-hidden /> {syncNow.isPending ? "Syncing…" : "Sync now"}
        </button>
      </div>
      {syncNote && (
        <p className="muted" style={{ margin: "2px 0 0", fontSize: 11.5 }}>{syncNote}</p>
      )}
      <ul className="unit-list" style={{ marginTop: 8 }}>
        {rows.map((j) => (
          <li key={j.id} className="find-row" style={{ flexWrap: "wrap" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <strong>{j.name}</strong>
              <div className="muted" style={{ fontSize: 11.5, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {j.group_title && <span>{j.group_title}</span>}
                {j.job_type && <span>· {j.job_type}</span>}
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                  · <CalendarDays size={11} aria-hidden /> {fmtDate(j.start_date)}
                  {j.end_date && ` – ${fmtDate(j.end_date)}`}
                </span>
              </div>
            </div>
            <div className="row-gap">
              <button
                className="button-like active-pill"
                onClick={() => {
                  setBuilding(j);
                  setJobCode(suggestCode(j.name));
                  setName(j.name);
                }}
              >
                Build project
              </button>
              <button
                className="button-like"
                disabled={dismiss.isPending}
                onClick={() => dismiss.mutate(j.id)}
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>

      {building && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => setBuilding(null)}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: 0, fontWeight: 700 }}>Build “{building.name}”</p>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
              {building.group_title} · {fmtDate(building.start_date)}
              {building.end_date && ` – ${fmtDate(building.end_date)}`}
              {building.budget != null && ` · $${building.budget.toLocaleString()}`}
            </p>
            <label className="field-label">Job code</label>
            <input
              value={jobCode}
              onChange={(e) => setJobCode(e.target.value)}
              placeholder="PECAN14"
              autoCapitalize="characters"
            />
            <label className="field-label">Project name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
            {build.isError && (
              <p className="error">{formatApiError(build.error)}</p>
            )}
            <div className="row-gap" style={{ marginTop: 10 }}>
              <button
                className="button-like active-pill"
                disabled={build.isPending || jobCode.trim() === ""}
                onClick={() => build.mutate(building)}
              >
                {build.isPending ? "Building…" : "Build project"}
              </button>
              <button className="button-like" onClick={() => setBuilding(null)}>
                Cancel
              </button>
            </div>
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 11.5 }}>
              Dates and the Monday link carry over. Until install work starts,
              schedule changes in Monday keep updating this project.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
