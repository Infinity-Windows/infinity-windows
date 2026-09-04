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
import { useT } from "../../lib/i18n";
import {
  buildProjectFromMonday,
  dismissMondayJob,
  fileSizeLabel,
  filesOnMonday,
  guessMondayFileKind,
  isExtractableFile,
  listIncomingMondayJobs,
  pullCounts,
  pullMondayFiles,
  pullRequestFiles,
  triggerMondaySync,
  type MondayFileChoice,
  type MondayFileKind,
  type MondayJob,
  type MondayPullResult,
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
  // Wave J (J3) added two crew-facing lines to this card, and every new
  // crew-facing string in this program goes through t() with English and
  // Spanish. The lines this component already had are English-only and stay
  // that way until somebody translates it whole — a half-translated card is
  // worse than an untranslated one.
  const t = useT();
  const qc = useQueryClient();
  const [building, setBuilding] = useState<MondayJob | null>(null);
  const [jobCode, setJobCode] = useState("");
  const [name, setName] = useState("");
  const [syncNote, setSyncNote] = useState<string | null>(null);
  // What the office decided about each of the row's files, keyed by asset id.
  // Seeded from the guesser when the form opens; everything ticked, because
  // taking the paperwork is the ordinary case and leaving it is the exception.
  const [fileChoices, setFileChoices] = useState<Record<string, MondayFileChoice>>({});
  // How the pull went, kept after the form closes: a job whose files half
  // arrived is exactly the moment somebody needs to be told what to do next.
  const [pullNote, setPullNote] = useState<string | null>(null);
  const [pullResults, setPullResults] = useState<MondayPullResult[]>([]);

  const buildingFiles = building ? filesOnMonday(building) : [];

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
    mutationFn: async (job: MondayJob) => {
      const { projectId } = await buildProjectFromMonday(job, {
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
      });

      // THE JOB IS BUILT AT THIS POINT AND STAYS BUILT. A file that will not
      // come across — Monday down, a 90 MB survey, a token that expired — is a
      // thing to say out loud and try again later from the Plans page, never a
      // reason to undo a job the office has already made.
      const wanted = pullRequestFiles(filesOnMonday(job), fileChoices);
      if (wanted.length === 0) return { results: [] as MondayPullResult[] };
      try {
        const pulled = await pullMondayFiles({
          mondayJobId: job.id,
          projectId,
          files: wanted,
        });
        if (!pulled.ok && pulled.results.length === 0) {
          return {
            results: wanted.map((w) => ({
              asset_id: w.asset_id,
              name:
                filesOnMonday(job).find((f) => f.asset_id === w.asset_id)?.name ?? "",
              ok: false,
              where: null,
              error: pulled.error ?? null,
            })) as MondayPullResult[],
          };
        }
        return { results: pulled.results };
      } catch (err) {
        return {
          results: wanted.map((w) => ({
            asset_id: w.asset_id,
            name: filesOnMonday(job).find((f) => f.asset_id === w.asset_id)?.name ?? "",
            ok: false,
            where: null,
            error: formatApiError(err),
          })) as MondayPullResult[],
        };
      }
    },
    onSuccess: async (result) => {
      setBuilding(null);
      setPullResults(result.results);
      const { pulled, total } = pullCounts(result.results);
      setPullNote(
        total === 0
          ? t("mondayFiles.result.noFiles")
          : pulled === total
            ? total === 1
              ? t("mondayFiles.result.onePulled")
              : t("mondayFiles.result.allPulled", { total: String(total) })
            : pulled === 0
              ? t("mondayFiles.result.nonePulled")
              : t("mondayFiles.result.somePulled", {
                  pulled: String(pulled),
                  total: String(total),
                }),
      );
      await qc.invalidateQueries({ queryKey: ["mondayIncoming"] });
      await qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  /** What one file's outcome says on the results list. */
  const resultLine = (r: MondayPullResult): string => {
    if (!r.ok) return r.error?.trim() || t("mondayFiles.result.failed");
    if (r.already) return t("mondayFiles.result.already");
    if (r.where === "plans") return t("mondayFiles.result.toPlans");
    if (r.where === "specs") return t("mondayFiles.result.toSpecs");
    return t("mondayFiles.result.toDocuments");
  };

  const dismiss = useMutation({
    mutationFn: dismissMondayJob,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["mondayIncoming"] }),
  });

  const rows = useMemo(() => incoming.data ?? [], [incoming.data]);
  // The pull note outlives the last incoming row: building the only job on the
  // list empties it, and "2 of 3 files pulled" is the sentence that must not
  // vanish with it.
  if (rows.length === 0 && !syncNow.isPending && !syncNote && !pullNote) return null;

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
      {pullNote && (
        <div style={{ marginTop: 6 }}>
          <p className="ok" style={{ margin: 0, fontSize: 12 }} data-testid="monday-pull-note">
            {pullNote}
          </p>
          {pullResults.length > 0 && (
            <ul className="unit-list" style={{ marginTop: 4 }}>
              {pullResults.map((r) => (
                <li
                  key={r.asset_id}
                  className="find-row"
                  data-testid="monday-pull-result"
                  style={{ fontSize: 11.5 }}
                >
                  <span style={{ minWidth: 0, flex: 1 }}>{r.name}</span>
                  <span className={r.ok ? "muted" : "error"}>{resultLine(r)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
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
                {/* Wave J (J3): Monday has always known when the windows are
                    due and the app has always thrown it away at build time.
                    Showing it here is how the office sees what carries over.
                    Same words as the job card's own line, so the fact reads
                    the same in both places. */}
                {j.est_arrival && (
                  <span>· {t("pipeline.card.eta", { date: fmtDate(j.est_arrival) })}</span>
                )}
              </div>
            </div>
            <div className="row-gap">
              <button
                className="button-like active-pill"
                onClick={() => {
                  setBuilding(j);
                  setJobCode(suggestCode(j.name));
                  setName(j.name);
                  setPullNote(null);
                  setPullResults([]);
                  // Everything ticked, each in the slot the file's own name
                  // suggests. Un-ticking is the deliberate act.
                  setFileChoices(
                    Object.fromEntries(
                      filesOnMonday(j).map((f) => [
                        f.asset_id,
                        {
                          kind: guessMondayFileKind(f.name, f.ext),
                          selected: true,
                        },
                      ]),
                    ),
                  );
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

            {/* The row's paperwork. Everything Monday holds, ticked, in the
                slot its own name suggests — so the ordinary case is one tap
                and the office only touches this when the guess is wrong. */}
            <label className="field-label">{t("mondayFiles.build.heading")}</label>
            {buildingFiles.length === 0 ? (
              <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
                {t("mondayFiles.build.none")}
              </p>
            ) : (
              <>
                <p className="muted" style={{ margin: "0 0 4px", fontSize: 11.5 }}>
                  {t("mondayFiles.build.blurb")}
                </p>
                <ul className="unit-list" data-testid="monday-build-files">
                  {buildingFiles.map((f) => {
                    const choice = fileChoices[f.asset_id];
                    const locked = !isExtractableFile(f.name, f.ext);
                    const size = fileSizeLabel(f.size);
                    return (
                      <li
                        key={f.asset_id}
                        className="find-row"
                        style={{ flexWrap: "wrap", gap: 6 }}
                      >
                        <label
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            minWidth: 0,
                            flex: 1,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={choice?.selected !== false}
                            aria-label={f.name}
                            onChange={(e) =>
                              setFileChoices((prev) => ({
                                ...prev,
                                [f.asset_id]: {
                                  kind:
                                    prev[f.asset_id]?.kind ??
                                    guessMondayFileKind(f.name, f.ext),
                                  selected: e.target.checked,
                                },
                              }))
                            }
                          />
                          <span style={{ minWidth: 0 }}>
                            {f.name}
                            {size && (
                              <span className="muted" style={{ fontSize: 11.5 }}>
                                {" "}
                                · {size}
                              </span>
                            )}
                          </span>
                        </label>
                        <select
                          value={
                            locked
                              ? "document"
                              : choice?.kind ?? guessMondayFileKind(f.name, f.ext)
                          }
                          disabled={locked}
                          aria-label={`${f.name} — ${t("mondayFiles.build.heading")}`}
                          onChange={(e) =>
                            setFileChoices((prev) => ({
                              ...prev,
                              [f.asset_id]: {
                                kind: e.target.value as MondayFileKind,
                                selected: prev[f.asset_id]?.selected !== false,
                              },
                            }))
                          }
                        >
                          <option value="building">{t("mondayFiles.kind.building")}</option>
                          <option value="specs">{t("mondayFiles.kind.specs")}</option>
                          <option value="document">{t("mondayFiles.kind.document")}</option>
                        </select>
                        {locked && (
                          <span
                            className="muted"
                            style={{ fontSize: 11, flexBasis: "100%" }}
                          >
                            {t("mondayFiles.build.lockedToDocument")}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            {build.isError && (
              <p className="error">{formatApiError(build.error)}</p>
            )}
            <div className="row-gap" style={{ marginTop: 10 }}>
              <button
                className="button-like active-pill"
                disabled={build.isPending || jobCode.trim() === ""}
                onClick={() => build.mutate(building)}
              >
                {build.isPending
                  ? buildingFiles.length > 0
                    ? t("mondayFiles.build.pulling")
                    : "Building…"
                  : "Build project"}
              </button>
              <button className="button-like" onClick={() => setBuilding(null)}>
                Cancel
              </button>
            </div>
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 11.5 }}>
              Dates and the Monday link carry over. Until install work starts,
              schedule changes in Monday keep updating this project.
            </p>
            {/* Wave J (J3): said plainly before the tap, because "Not ready" is
                a state somebody will have to clear by hand and a foreman should
                not discover it on the jobs list afterwards. One whole sentence
                per case rather than a stem with a clause spliced in, so it can
                be written properly in both languages. */}
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 11.5 }}>
              {building.est_arrival
                ? t("pipeline.monday.landsNotReadyWithEta", {
                    date: fmtDate(building.est_arrival),
                  })
                : t("pipeline.monday.landsNotReady")}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
