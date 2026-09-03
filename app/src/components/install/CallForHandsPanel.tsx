// Call for hands on the whole job (job-level-summons slice 4). The window
// summon (SummonPanel) hangs off one opening and clocks a helper onto it; this
// one hangs off the JOB — a tracking job has no openings at all — and rings the
// crew clocked into that job by default, plus anyone the summoner reaches for
// by name. The summoner types what they need and where they are; a helper who
// lands here from the landing strip answers, helps, and taps Complete.
//
// Self-contained on purpose (the LiveSummonsStrip pattern): it fetches its own
// profile and role, so a screen adds one line — `<CallForHandsPanel …/>` — and
// passes nothing it has to assemble. `allowCreate` is the only lever: a
// tracking job's job page creates here; a data job creates from the window
// sheet and passes allowCreate={false}, so its job page only ever shows a LIVE
// call so a helper landing from the strip can still answer it.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  answerSummon,
  cancelSummonHelp,
  closeSummon,
  completeSummonHelp,
  createJobSummon,
  declineSummon,
  listClockedInOnJob,
  listLiveSummons,
  listSummonDeclines,
  listSummonHelpers,
  notifyCallForHands,
  summonEtaLine,
  type Summon,
} from "../../lib/install/summons";
import { getMyProfile } from "../../lib/install/api";
import { listProjectsAnyStatus } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { formatApiError } from "../../lib/install/errors";
import { isForemanPlus } from "../../lib/install/types";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { useViewAsRole } from "../../lib/viewAsRoleContext";
import { useT } from "../../lib/i18n";
import { ReachMorePicker } from "./ReachMorePicker";

export function CallForHandsPanel({
  projectId,
  jobLabel,
  allowCreate = true,
}: {
  projectId: string;
  /** The job's name for the push. Optional: a caller that already has the
   * project (ProjectDetail) passes it; a caller that doesn't (the window
   * sheet) lets the panel resolve it from the projects cache. */
  jobLabel?: string;
  /** A data job creates its call for hands from the window sheet, so its job
   * page passes false — it shows a live call (to answer) but no create form. */
  allowCreate?: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  // View-as is a costume: every write still runs as the real signed-in user,
  // so while previewing a person the action buttons lock (SummonPanel's rule).
  const { previewPerson } = useViewAsRole();
  const actionsLocked = Boolean(previewPerson);

  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const myProfileId = me.data?.id ?? null;
  const myName = me.data?.display_name ?? null;

  // Resolve the job's name when the caller didn't hand us one. Same cache key
  // ProjectDetail uses, so it's a hit on any screen that has opened the job.
  const projectsAll = useQuery({
    queryKey: ["projectsAll"],
    queryFn: listProjectsAnyStatus,
    enabled: !jobLabel,
  });
  const project = projectsAll.data?.find((p) => p.id === projectId);
  const label = jobLabel ?? project?.job_code ?? project?.name ?? "this job";

  const [formOpen, setFormOpen] = useState(false);
  const [needed, setNeeded] = useState(2);
  const [note, setNote] = useState("");
  const [whereNote, setWhereNote] = useState("");
  const [reachOpen, setReachOpen] = useState(false);
  const [extraIds, setExtraIds] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const live = useQuery({
    queryKey: ["summons", projectId],
    queryFn: () => listLiveSummons(projectId),
    refetchInterval: 20_000,
  });
  // The one live JOB-level call for hands on this job (opening_id null); the
  // window summons in the same read are SummonPanel's, not ours.
  const summon: Summon | null =
    (live.data ?? []).find((s) => s.opening_id === null) ?? null;

  // The same-job clocked-in crew — the default audience. Fetched only while
  // the reach-further picker is open, so it can grey them out (they already
  // get the call). The create mutation re-reads it fresh at submit time.
  const onJob = useQuery({
    queryKey: ["clockedInOnJob", projectId],
    queryFn: () => listClockedInOnJob(projectId),
    enabled: reachOpen,
  });

  const helpers = useQuery({
    queryKey: ["summonHelpers", summon?.id],
    queryFn: () => listSummonHelpers(summon!.id),
    enabled: Boolean(summon),
    refetchInterval: 20_000,
  });
  const declines = useQuery({
    queryKey: ["summonDeclines", summon?.id],
    queryFn: () => listSummonDeclines(summon!.id),
    enabled: Boolean(summon),
    refetchInterval: 20_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["summons", projectId] });
    if (summon) {
      void queryClient.invalidateQueries({ queryKey: ["summonHelpers", summon.id] });
      void queryClient.invalidateQueries({ queryKey: ["summonDeclines", summon.id] });
    }
  };

  // Answers land on the caller's screen the moment they happen — a realtime
  // channel beats the 20s poll, which stays as the fallback (SummonPanel's
  // pattern).
  useEffect(() => {
    if (!summon) return;
    const channel = supabase
      .channel(`job-summon-live-${summon.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "summon_helpers", filter: `summon_id=eq.${summon.id}` },
        () => refresh(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "summon_declines", filter: `summon_id=eq.${summon.id}` },
        () => refresh(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "summons", filter: `id=eq.${summon.id}` },
        () => refresh(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summon?.id]);

  const call = useMutation({
    mutationFn: async () => {
      const created = await createJobSummon(projectId, needed, note, whereNote);
      // Ring the same-job clocked-in crew (the default) plus anyone reached
      // for by name. Push is best-effort — the in-app strip carries the call
      // even if no device is subscribed.
      try {
        const onJob = await listClockedInOnJob(projectId);
        await notifyCallForHands({
          summonId: created.id,
          projectId,
          jobLabel: label,
          callerId: myProfileId,
          callerName: myName,
          needed,
          note,
          whereNote,
          sameJobIds: onJob.map((p) => p.profileId),
          extraIds,
        });
      } catch {
        /* push is best-effort */
      }
      return created;
    },
    onSuccess: () => {
      setFormOpen(false);
      setReachOpen(false);
      setExtraIds([]);
      setNote("");
      setWhereNote("");
      setErr(null);
      refresh();
    },
    onError: (e) => setErr(formatApiError(e)),
  });

  const answer = useMutation({
    mutationFn: () => answerSummon(summon!.id),
    onSuccess: () => {
      refresh();
      if (summon) {
        void navigator.serviceWorker?.getRegistration().then((r) =>
          r?.getNotifications({ tag: `summon-${summon.id}` }).then((ns) => {
            for (const n of ns) n.close();
          }),
        );
      }
    },
    onError: (e) => setErr(formatApiError(e)),
  });
  const complete = useMutation({
    mutationFn: () => completeSummonHelp(summon!.id),
    onSuccess: refresh,
    onError: (e) => setErr(formatApiError(e)),
  });
  const bail = useMutation({
    mutationFn: () => cancelSummonHelp(summon!.id),
    onSuccess: refresh,
    onError: (e) => setErr(formatApiError(e)),
  });
  const end = useMutation({
    mutationFn: () => closeSummon(summon!.id),
    onSuccess: refresh,
    onError: (e) => setErr(formatApiError(e)),
  });
  const decline = useMutation({
    mutationFn: () => declineSummon(summon!.id),
    onSuccess: refresh,
    onError: (e) => setErr(formatApiError(e)),
  });

  const myHelp = (helpers.data ?? []).find(
    (h) => h.profile_id === myProfileId && !h.completed_at && !h.canceled_at,
  );
  const myDecline = (declines.data ?? []).find((d) => d.profile_id === myProfileId);
  const iAmCaller = summon?.requested_by === myProfileId;
  const helperCount = (helpers.data ?? []).filter((h) => !h.canceled_at).length;
  const manMinutes = (helpers.data ?? [])
    .filter((h) => !h.canceled_at && h.minutes != null)
    .reduce((sum, h) => sum + (h.minutes ?? 0), 0);

  // Nothing to show: no live call, and this surface can't start one.
  if (!summon && !allowCreate) return null;

  return (
    <div style={{ width: "100%" }}>
      {!summon && allowCreate && !actionsLocked && !formOpen && (
        <button className="button-like" style={{ marginTop: 8 }} onClick={() => setFormOpen(true)}>
          🙌 {t("callhands.button")}
        </button>
      )}

      {!summon && allowCreate && !actionsLocked && formOpen && (
        <div className="detail-card" style={{ marginTop: 8, textAlign: "left" }}>
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
            {t("callhands.subtitle")}
          </p>
          <span className="field-label">{t("callhands.howMany")}</span>
          <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 6 }}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <button
                key={n}
                className={
                  needed === n ? "button-like active-pill studio-mini" : "button-like studio-mini"
                }
                onClick={() => setNeeded(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <input
            type="text"
            placeholder={t("callhands.whatFor")}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            style={{ width: "100%", marginTop: 8 }}
            aria-label={t("callhands.whatFor")}
          />
          <input
            type="text"
            placeholder={t("callhands.whereAmI")}
            value={whereNote}
            maxLength={500}
            onChange={(e) => setWhereNote(e.target.value)}
            style={{ width: "100%", marginTop: 8 }}
            aria-label={t("callhands.whereAmI")}
          />
          {!reachOpen ? (
            <button
              className="link"
              style={{ marginTop: 8, fontSize: 12.5 }}
              onClick={() => setReachOpen(true)}
            >
              {t("callhands.reach.title")} →
            </button>
          ) : (
            <ReachMorePicker
              callerId={myProfileId}
              sameJobIds={(onJob.data ?? []).map((p) => p.profileId)}
              selected={extraIds}
              onChange={setExtraIds}
            />
          )}
          <button
            className="primary big"
            style={{ marginTop: 8 }}
            disabled={call.isPending}
            onClick={() => call.mutate()}
          >
            {call.isPending ? t("callhands.ringing") : t("callhands.ring", { count: needed })}
          </button>
        </div>
      )}

      {summon && (
        <div className="detail-card" style={{ marginTop: 8, textAlign: "left" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="field-label" style={{ margin: 0 }}>
              🙌 {t("callhands.liveHeader", { count: helperCount, needed: summon.needed })}{" "}
              {summon.status === "covered"
                ? t("callhands.coveredWord")
                : t("callhands.answeredWord")}
            </span>
            {!actionsLocked && (iAmCaller || isForemanPlus(effectiveRole)) && (
              <button
                className="link"
                style={{ marginLeft: "auto", fontSize: 12 }}
                disabled={end.isPending}
                onClick={() => end.mutate()}
              >
                {t("callhands.end")}
              </button>
            )}
          </div>
          {summonEtaLine(summon.needed_at) && (
            <p
              className={summonEtaLine(summon.needed_at) === "needed NOW" ? "error" : "muted"}
              style={{ margin: "6px 0 0", fontSize: 13, fontWeight: 600 }}
            >
              ⏱ {summonEtaLine(summon.needed_at)}
            </p>
          )}
          {summon.note && (
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>
              &ldquo;{summon.note}&rdquo;
            </p>
          )}
          {summon.where_note && (
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>
              📍 {summon.where_note}
            </p>
          )}
          {(helpers.data ?? []).length > 0 && (
            <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none" }}>
              {(helpers.data ?? []).map((h) => (
                <li key={h.id} style={{ fontSize: 13, padding: "2px 0" }}>
                  <strong>{h.helper?.display_name ?? t("callhands.reach.someone")}</strong>{" "}
                  <span className="muted">
                    {h.canceled_at
                      ? t("callhands.backedOut")
                      : h.minutes != null
                        ? `${h.minutes} min`
                        : h.completed_at
                          ? t("callhands.done")
                          : t("callhands.onTheWay")}
                  </span>
                </li>
              ))}
              {manMinutes > 0 && (
                <li className="muted" style={{ fontSize: 12, paddingTop: 2 }}>
                  {t("callhands.helperMin", { count: manMinutes })}
                </li>
              )}
            </ul>
          )}
          {(declines.data ?? []).length > 0 && (
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>
              {t("callhands.cantCome")}{" "}
              {(declines.data ?? []).map((d) => d.decliner?.display_name ?? "").join(", ")}
            </p>
          )}
          {!actionsLocked && !iAmCaller && !myHelp && summon.status === "open" && (
            <>
              <button
                className="primary big"
                style={{ marginTop: 8 }}
                disabled={answer.isPending}
                onClick={() => answer.mutate()}
              >
                {answer.isPending ? t("callhands.joining") : t("callhands.answer")}
              </button>
              <button
                className="link"
                style={{ marginTop: 6, fontSize: 12.5 }}
                disabled={decline.isPending || Boolean(myDecline)}
                onClick={() => decline.mutate()}
              >
                {myDecline
                  ? t("callhands.cantHelpNoted")
                  : decline.isPending
                    ? t("callhands.sayingSo")
                    : t("callhands.cantHelp")}
              </button>
            </>
          )}
          {!actionsLocked && myHelp && (
            <>
              <button
                className="primary big"
                style={{ marginTop: 8 }}
                disabled={complete.isPending}
                onClick={() => complete.mutate()}
              >
                {complete.isPending ? t("callhands.stamping") : t("callhands.complete")}
              </button>
              <button
                className="link"
                style={{ marginTop: 6, fontSize: 12.5 }}
                disabled={bail.isPending}
                onClick={() => bail.mutate()}
              >
                {bail.isPending ? t("callhands.backingOut") : t("callhands.cantMakeIt")}
              </button>
            </>
          )}
          {actionsLocked && (
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>
              {t("callhands.lockedViewAs")}
            </p>
          )}
        </div>
      )}
      {err && <p className="error" style={{ marginTop: 6, fontSize: 12 }}>{err}</p>}
    </div>
  );
}
