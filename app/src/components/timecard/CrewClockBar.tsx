// The roster's bulk clock, for supervisors (owner ask, 2026-09-04).
//
// The owner opened Team timecards and found fourteen people clocked into
// OFFICE a minute or two apart — the fingerprint of somebody standing in the
// shop punching fourteen phones in by hand. This is the one tap that does it,
// and the one that clocks them all out again at the end of the day.
//
// It does NOT fork the clock-in picker. The job list is the same active-jobs
// list the Jobs page reads (listProjects), the cost codes come from
// getClockCostCodesForProject on the SAME query key the clock block and the
// clock sheet use — so a job with its own subset scopes this picker exactly as
// it scopes an installer's — and the mode step reuses the clock block's own
// catalog strings. What is genuinely new is the toolbox attestation, because
// clocking somebody else in is the one path where nobody signed anything.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { isMissingFunction } from "../../lib/schemaErrors";
import { getMyProfile } from "../../lib/install/api";
import { sendPush } from "../../lib/permissions/pushServer";
import { getClockCostCodesForProject } from "../../lib/costCodes";
import { effectiveClockInMode, normalizeModes, type JobMode } from "../../lib/jobModes";
import { useT } from "../../lib/i18n";
import {
  clockInCrew,
  clockOutCrew,
  type CrewClockOutcome,
} from "../../lib/timeclock";
import {
  actuallyChanged,
  clockedInPushBody,
  clockedOutPushBody,
  crewToClockOut,
  outcomeKind,
  planCrewClockIn,
  refusalReason,
  withSkipped,
  type CrewClockMember,
} from "../../lib/crewClock";
import type { Project } from "../../lib/types";

// Spelled out rather than built by string concatenation, so a new outcome
// added to the server without a line of copy is a compile error here rather
// than a blank chip on somebody's screen.
const OUTCOME_KEYS = {
  clocked_in: "crewclock.outcome.clocked_in",
  already_on_this_job: "crewclock.outcome.already_on_this_job",
  moved_from_other_job: "crewclock.outcome.moved_from_other_job",
  clocked_out: "crewclock.outcome.clocked_out",
  already_out: "crewclock.outcome.already_out",
  skipped: "crewclock.outcome.skipped",
  unknown: "crewclock.outcome.unknown",
} as const;

/** The plain-English line for one person's answer. */
function OutcomeLine({ name, outcome }: { name: string; outcome: string }) {
  const t = useT();
  const kind = outcomeKind(outcome);
  const text =
    kind === "refused"
      ? t("crewclock.outcome.refused", { reason: refusalReason(outcome) })
      : t(OUTCOME_KEYS[kind]);
  return (
    <li className="find-row">
      <strong style={{ flex: 1, minWidth: 0 }}>{name}</strong>
      <span className={kind === "refused" ? "tcx-chip bad" : "tcx-chip"}>{text}</span>
    </li>
  );
}

export function CrewClockBar({
  members,
  selected,
  projects,
  onDone,
}: {
  /** The roster, in the order it is on screen. */
  members: CrewClockMember[];
  selected: string[];
  /** Active jobs, already in Jobs-page order (listProjects). */
  projects: Project[];
  /** Refetch the roster; called after anything actually changed. */
  onDone: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });

  const [sheet, setSheet] = useState<null | "in" | "out">(null);
  const [projectId, setProjectId] = useState("");
  const [costCodeId, setCostCodeId] = useState("");
  const [pickedMode, setPickedMode] = useState<JobMode>("data");
  const [note, setNote] = useState("");
  // Both start OFF. The attestation because it is a claim nobody should make
  // by accident; the move because a supervisor ticking fourteen boxes cannot
  // be assumed to know one of them started on another site an hour ago.
  const [attested, setAttested] = useState(false);
  const [move, setMove] = useState(false);
  const [results, setResults] = useState<CrewClockOutcome[] | null>(null);
  // The people this sheet deliberately did NOT send, frozen at the moment the
  // button was pressed. It has to be a snapshot: onDone() clears the selection,
  // so by the time the answer is on screen `plan.elsewhere` is empty and the
  // three people still on somebody else's job would vanish from the list of
  // fourteen names that was ticked (2026-09-04 review).
  const [skipped, setSkipped] = useState<string[]>([]);

  // Same query key as ClockInBlock / ClockSheet, so the list a supervisor sees
  // here is literally the cached one an installer would see for that job.
  const costCodes = useQuery({
    queryKey: ["clockCostCodes", projectId || "all"],
    queryFn: () => getClockCostCodesForProject(projectId || null),
    enabled: sheet === "in",
  });

  const nameById = useMemo(
    () => new Map(members.map((m) => [m.id, m.name])),
    [members],
  );
  const chosen = projects.find((p) => p.id === projectId) ?? null;
  const isBothMode = normalizeModes(chosen?.allowed_modes).length >= 2;
  const plan = useMemo(
    () => planCrewClockIn(members, selected, projectId || null, move),
    [members, selected, projectId, move],
  );
  const outIds = useMemo(() => crewToClockOut(members, selected), [members, selected]);

  const close = () => {
    setSheet(null);
    setResults(null);
    setSkipped([]);
  };

  /**
   * Open a sheet with both claims cleared.
   *
   * The attestation is a statement about THIS group of people, made now — a
   * box left ticked from the last batch would let the second one through
   * without anybody saying anything, which is the whole thing the tick exists
   * to prevent. The move box resets for the same reason: off by default means
   * off every time, not off once. The job, the cost code and the note are
   * conveniences and stay put.
   */
  const open = (which: "in" | "out") => {
    setResults(null);
    setSkipped([]);
    setAttested(false);
    setMove(false);
    setSheet(which);
  };

  /** Tell each person the app changed their punch (English — push copy law). */
  const pushEveryone = (list: CrewClockOutcome[], jobLabel: string | null) => {
    const byName = me.data?.display_name ?? "";
    const at = new Date().toISOString();
    for (const id of actuallyChanged(list)) {
      // A supervisor who ticked their own row does not need a push about the
      // thing they just did — the same rule ShiftEditor follows (K4).
      if (id === me.data?.id) continue;
      const out = list.find((r) => r.profile_id === id);
      const clockedOut = outcomeKind(out?.outcome ?? "") === "clocked_out";
      void sendPush({
        profileIds: [id],
        title: clockedOut ? "You were clocked out" : "You were clocked in",
        body: clockedOut
          ? clockedOutPushBody(byName, at)
          : clockedInPushBody(byName, jobLabel, at),
        tag: `crew-clock-${clockedOut ? "out" : "in"}-${id}-${at.slice(0, 13)}`,
        url: "/clock",
      });
    }
  };

  const doClockIn = useMutation({
    mutationFn: () =>
      clockInCrew({
        profileIds: plan.willClockIn,
        projectId,
        costCodeId,
        note: note.trim() || null,
        mode: effectiveClockInMode(chosen?.allowed_modes, pickedMode),
        talkAttested: attested,
        moveIfElsewhere: move,
      }),
    onSuccess: (list) => {
      setResults(list);
      pushEveryone(list, chosen?.job_code ?? null);
      // Today's talk may now be signed for people who had not signed it, so
      // the compliance reads have to be re-asked as well as the roster.
      void qc.invalidateQueries({ queryKey: ["toolboxToday"] });
      onDone();
    },
  });

  const doClockOut = useMutation({
    mutationFn: () => clockOutCrew(outIds),
    onSuccess: (list) => {
      setResults(list);
      pushEveryone(list, null);
      onDone();
    },
  });

  // Everyone who was ticked gets a line, including the ones no request carried.
  // Their word differs by sheet: somebody held back from a clock-in is still on
  // another job, while somebody held back from a clock-out was simply already
  // off — which is exactly what the server would have answered had it been
  // asked, so it reuses that same line rather than inventing a second one.
  const answers = useMemo(
    () =>
      results
        ? withSkipped(results, skipped, sheet === "out" ? "already_out" : undefined)
        : [],
    [results, skipped, sheet],
  );

  const busy = doClockIn.isPending || doClockOut.isPending;
  const failure = doClockIn.error ?? doClockOut.error;
  // The migration has not landed on this database yet. The roster itself is
  // fine — only this bar cannot do its job — so say that, plainly, rather than
  // showing a supervisor a schema-cache error.
  const failureText = failure
    ? isMissingFunction(failure)
      ? t("crewclock.notReady")
      : formatApiError(failure)
    : null;

  return (
    <>
      <div className="crewclock-bar">
        <span className="crewclock-bar-count">
          {t("crewclock.bar.count", { n: selected.length })}
        </span>
        <button
          type="button"
          className="button-like active-pill"
          disabled={selected.length === 0}
          onClick={() => open("in")}
        >
          {t("crewclock.bar.clockIn")}
        </button>
        <button
          type="button"
          className="button-like"
          disabled={selected.length === 0}
          onClick={() => open("out")}
        >
          {t("crewclock.bar.clockOut")}
        </button>
      </div>

      {sheet && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={
            sheet === "in"
              ? t("crewclock.in.title", { n: plan.willClockIn.length })
              : t("crewclock.out.title", { n: outIds.length })
          }
          onClick={close}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            {results ? (
              <>
                <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>
                  {t("crewclock.results.title")}
                </h2>
                <ul className="unit-list">
                  {answers.map((r) => (
                    <OutcomeLine
                      key={r.profile_id}
                      name={nameById.get(r.profile_id) ?? "Crew"}
                      outcome={r.outcome}
                    />
                  ))}
                </ul>
                <button
                  type="button"
                  className="button-like active-pill"
                  style={{ marginTop: 10 }}
                  onClick={close}
                >
                  {t("crewclock.results.close")}
                </button>
              </>
            ) : sheet === "in" ? (
              <>
                <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>
                  {t("crewclock.in.title", { n: plan.willClockIn.length })}
                </h2>

                <label className="field-label" htmlFor="crewclock-job">
                  {t("crewclock.in.job")}
                </label>
                <select
                  id="crewclock-job"
                  value={projectId}
                  onChange={(e) => {
                    setProjectId(e.target.value);
                    // A code held over from the previous job can be outside the
                    // new job's subset — the same reset ClockInBlock does.
                    setCostCodeId("");
                  }}
                >
                  <option value="">{t("crewclock.in.pickJob")}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.job_code} — {p.name}
                    </option>
                  ))}
                </select>

                <label className="field-label" htmlFor="crewclock-code">
                  {t("clock.label.costCode")}
                </label>
                <select
                  id="crewclock-code"
                  value={costCodeId}
                  onChange={(e) => setCostCodeId(e.target.value)}
                >
                  <option value="">—</option>
                  {(costCodes.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.label}
                    </option>
                  ))}
                </select>

                {/* Only a job that allows BOTH asks; a single-mode job records
                    its one mode silently, exactly as the clock block does. */}
                {isBothMode && (
                  <>
                    <label className="field-label" htmlFor="crewclock-mode">
                      {t("clockblock.mode.label")}
                    </label>
                    <select
                      id="crewclock-mode"
                      value={pickedMode}
                      onChange={(e) => setPickedMode(e.target.value as JobMode)}
                    >
                      <option value="data">{t("clockblock.mode.data")}</option>
                      <option value="tracking">{t("clockblock.mode.tracking")}</option>
                    </select>
                  </>
                )}

                <label className="field-label" htmlFor="crewclock-note">
                  {t("crewclock.in.note")}
                </label>
                <input
                  id="crewclock-note"
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />

                {/* SAFETY / toolbox — needs bilingual review. */}
                <label
                  className="row-gap"
                  style={{ alignItems: "flex-start", marginTop: 10, gap: 8 }}
                >
                  <input
                    type="checkbox"
                    checked={attested}
                    onChange={(e) => setAttested(e.target.checked)}
                  />
                  <span style={{ fontSize: 13 }}>
                    {t("crewclock.in.attest")}
                    <span className="muted" style={{ display: "block", fontSize: 11.5 }}>
                      {t("crewclock.in.attestHelp")}
                    </span>
                  </span>
                </label>

                <label className="row-gap" style={{ alignItems: "center", marginTop: 8, gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={move}
                    onChange={(e) => setMove(e.target.checked)}
                  />
                  <span style={{ fontSize: 13 }}>{t("crewclock.in.move")}</span>
                </label>
                {!move && plan.elsewhere.length > 0 && (
                  <p className="muted" style={{ fontSize: 11.5, margin: "6px 0 0" }}>
                    {t("crewclock.in.moveOff", { n: plan.elsewhere.length })}{" "}
                    {plan.elsewhere.map((id) => nameById.get(id) ?? "Crew").join(", ")}
                  </p>
                )}

                {failureText && <p className="error">{failureText}</p>}

                <div className="row-gap" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="button-like active-pill"
                    disabled={
                      busy ||
                      !attested ||
                      !projectId ||
                      !costCodeId ||
                      plan.willClockIn.length === 0
                    }
                    onClick={() => {
                      setSkipped(plan.elsewhere);
                      doClockIn.mutate();
                    }}
                  >
                    {busy ? t("crewclock.in.going") : t("crewclock.in.go")}
                  </button>
                  <button type="button" className="button-like" onClick={close}>
                    {t("crewclock.cancel")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>
                  {t("crewclock.out.title", { n: outIds.length })}
                </h2>
                <p style={{ margin: 0 }}>
                  {outIds.length === 0
                    ? t("crewclock.out.nobody")
                    : t("crewclock.out.body", { n: outIds.length })}
                </p>
                {failureText && <p className="error">{failureText}</p>}
                <div className="row-gap" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="button-like active-pill"
                    disabled={busy || outIds.length === 0}
                    onClick={() => {
                      // Everybody ticked who is already off the clock: the
                      // server never hears about them, so their (true) line —
                      // "was already off the clock" — is added here.
                      const off = new Set(outIds);
                      setSkipped(selected.filter((id) => !off.has(id)));
                      doClockOut.mutate();
                    }}
                  >
                    {busy ? t("crewclock.out.going") : t("crewclock.out.go")}
                  </button>
                  <button type="button" className="button-like" onClick={close}>
                    {t("crewclock.cancel")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
