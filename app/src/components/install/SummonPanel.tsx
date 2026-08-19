// Summon (owner, 2026-08-14): mid-install, call up to 8 helpers onto a
// heavy window. Everyone on the job gets rung (push, as hard as the
// platform allows); answering clocks the helper on and pays 10 points
// instantly; Complete stamps their minutes; the window's true cost shows
// lead + helper time. Windows over 4040 get a declinable prompt.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  answerSummon,
  cancelSummonHelp,
  closeSummon,
  completeSummonHelp,
  createSummon,
  listLiveSummons,
  listSummonHelpers,
  sizeSuggestsSummon,
  summonEtaLine,
  summonHelperMinutes,
  type Summon,
} from "../../lib/install/summons";
import { listRoster } from "../../lib/chat/api";
import { supabase } from "../../lib/supabase";
import { sendPush } from "../../lib/permissions/pushServer";
import { formatApiError } from "../../lib/install/errors";
import { isForemanPlus } from "../../lib/install/types";
import { useViewAsRole } from "../../lib/viewAsRoleContext";

export function SummonPanel({
  projectId,
  openingId,
  openingCode,
  widthIn,
  heightIn,
  myProfileId,
  myName,
  effectiveRole,
  installRunning,
}: {
  projectId: string;
  openingId: string;
  openingCode: string;
  widthIn: number | null;
  heightIn: number | null;
  myProfileId: string | null;
  myName: string | null;
  effectiveRole: string;
  installRunning: boolean;
}) {
  const queryClient = useQueryClient();
  // View-as is a costume, not a login: every write here still runs as the
  // REAL signed-in user (by design — an owner browsing as Chris must never
  // write rows as Chris). So while a person-preview is on, the action
  // buttons lock and say so plainly, instead of letting a tap fly and come
  // back as "you called this summon — no answering yourself" (owner hit
  // exactly that trying to test an answer from Chris's view, 2026-08-18).
  const { previewPerson } = useViewAsRole();
  const actionsLocked = Boolean(previewPerson);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [needed, setNeeded] = useState(2);
  // When the hands are needed: null = right now, else minutes from the tap
  // (owner ask, 2026-08-19). Answerers see the countdown and get a 5-minute
  // warning push from the server-side sweep.
  const [leadMin, setLeadMin] = useState<number | null>(null);
  const [dismissedPrompt, setDismissedPrompt] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const live = useQuery({
    queryKey: ["summons", projectId],
    queryFn: () => listLiveSummons(projectId),
    refetchInterval: 20_000,
  });
  const summon: Summon | null =
    (live.data ?? []).find((s) => s.opening_id === openingId) ?? null;
  const helpers = useQuery({
    queryKey: ["summonHelpers", summon?.id],
    queryFn: () => listSummonHelpers(summon!.id),
    enabled: Boolean(summon),
    refetchInterval: 20_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["summons", projectId] });
    if (summon) {
      void queryClient.invalidateQueries({ queryKey: ["summonHelpers", summon.id] });
    }
  };

  // Answers land on the caller's screen the moment they happen (owner report,
  // 2026-08-19: "it takes a while to go through") — a realtime channel on
  // this summon's rows beats the 20s poll, which stays as the fallback.
  useEffect(() => {
    if (!summon) return;
    const channel = supabase
      .channel(`summon-live-${summon.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "summon_helpers", filter: `summon_id=eq.${summon.id}` },
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
      const created = await createSummon(openingId, needed, leadMin);
      // Ring the job's crew (never the caller). Push failures never block
      // the summon — the in-app banner and this card still carry it.
      try {
        const roster = await listRoster(projectId);
        const ids = roster.members
          .filter((m) => m.assigned && m.id !== myProfileId)
          .map((m) => m.id);
        if (ids.length > 0) {
          await sendPush({
            profileIds: ids,
            title: `🪟 Help needed — ${openingCode}`,
            body: `${myName ?? "An installer"} needs ${needed} for a heavy unit${
              leadMin ? ` in ${leadMin} min` : " now"
            }. Answer to help (+10 pts).`,
            tag: `summon-${created.id}`,
            url: `/projects/${projectId}/opening/${openingId}`,
            urgent: true,
          });
        }
      } catch {
        /* push is best-effort */
      }
      return created;
    },
    onSuccess: () => {
      setPickerOpen(false);
      setErr(null);
      refresh();
    },
    onError: (e) => setErr(formatApiError(e)),
  });

  const answer = useMutation({
    mutationFn: () => answerSummon(summon!.id),
    onSuccess: () => {
      refresh();
      // The ring is answered — take its notification out of the tray so it
      // stops saying "Answer to help" (owner report, 2026-08-19).
      if (summon) {
        void navigator.serviceWorker?.getRegistration().then((r) =>
          r?.getNotifications({ tag: `summon-${summon.id}` }).then((ns) => {
            for (const n of ns) n.close();
          }),
        );
      }
      // The caller learns THE MOMENT someone answers (owner report,
      // 2026-08-19) — a push straight to them, not a poll. Best-effort,
      // same as every other summon push.
      if (summon && myProfileId && summon.requested_by !== myProfileId) {
        const nowCount = helperCount + 1;
        void sendPush({
          profileIds: [summon.requested_by],
          title: `🙌 ${myName ?? "Someone"} is coming`,
          body: `${nowCount} of ${summon.needed} answered on ${openingCode}${
            summonEtaLine(summon.needed_at) ? ` — hands ${summonEtaLine(summon.needed_at)}` : ""
          }.`,
          tag: `summon-answer-${summon.id}`,
          url: `/projects/${projectId}/opening/${openingId}`,
        }).catch(() => {});
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
    onSuccess: () => {
      refresh();
      // Tell the caller straight away — a no-show they know about is a
      // seat they can refill.
      if (summon && summon.requested_by !== myProfileId) {
        void sendPush({
          profileIds: [summon.requested_by],
          title: `↩️ ${myName ?? "A helper"} can't make it`,
          body: `Their seat on ${openingCode} is open again.`,
          tag: `summon-bail-${summon.id}`,
          url: `/projects/${projectId}/opening/${openingId}`,
        }).catch(() => {});
      }
    },
    onError: (e) => setErr(formatApiError(e)),
  });
  const end = useMutation({
    mutationFn: () => closeSummon(summon!.id),
    onSuccess: refresh,
    onError: (e) => setErr(formatApiError(e)),
  });

  const myHelp = (helpers.data ?? []).find(
    (h) => h.profile_id === myProfileId && !h.completed_at && !h.canceled_at,
  );
  const iAmCaller = summon?.requested_by === myProfileId;
  const helperCount = (helpers.data ?? []).filter((h) => !h.canceled_at).length;
  const manMinutes = summonHelperMinutes(helpers.data ?? []);
  const suggest =
    installRunning &&
    !actionsLocked &&
    !summon &&
    !dismissedPrompt &&
    sizeSuggestsSummon(widthIn, heightIn);

  return (
    <div style={{ width: "100%" }}>
      {/* The 4040 rule: a declinable nudge, never a block (owner pick). */}
      {suggest && (
        <div className="detail-card" style={{ marginTop: 8, textAlign: "left" }}>
          <strong>2+ man lift.</strong>{" "}
          <span className="muted">
            This unit is over 4040 — summon help before you wrestle it alone?
          </span>
          <div className="row-gap" style={{ marginTop: 8 }}>
            <button className="button-like active-pill" onClick={() => setPickerOpen(true)}>
              🔔 Summon help
            </button>
            <button className="button-like" onClick={() => setDismissedPrompt(true)}>
              Not needed
            </button>
          </div>
        </div>
      )}

      {/* No live summon = the button is there — a window can need several
          summons in a day (owner, 2026-08-19), and ending one must always
          offer the next. The server still requires an open shift. */}
      {!summon && !suggest && !actionsLocked && (
        <button
          className="button-like"
          style={{ marginTop: 8 }}
          onClick={() => setPickerOpen((v) => !v)}
        >
          🔔 Summon help
        </button>
      )}

      {pickerOpen && !summon && !actionsLocked && (
        <div className="detail-card" style={{ marginTop: 8, textAlign: "left" }}>
          <span className="field-label">How many helpers?</span>
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
          <span className="field-label" style={{ marginTop: 10, display: "block" }}>
            When do you need them?
          </span>
          <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 6 }}>
            {([null, 15, 30, 45, 60] as const).map((m) => (
              <button
                key={m ?? "now"}
                className={
                  leadMin === m ? "button-like active-pill studio-mini" : "button-like studio-mini"
                }
                onClick={() => setLeadMin(m)}
              >
                {m === null ? "Right now" : `In ${m} min`}
              </button>
            ))}
          </div>
          {leadMin !== null && (
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
              Answerers see the countdown and get a 5-minute warning.
            </p>
          )}
          <button
            className="primary big"
            style={{ marginTop: 8 }}
            disabled={call.isPending}
            onClick={() => call.mutate()}
          >
            {call.isPending
              ? "Ringing the crew…"
              : `Ring the crew — need ${needed}${leadMin ? ` in ${leadMin} min` : " now"}`}
          </button>
        </div>
      )}

      {summon && (
        <div className="detail-card" style={{ marginTop: 8, textAlign: "left" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="field-label" style={{ margin: 0 }}>
              🔔 Summon — {helperCount}/{summon.needed}{" "}
              {summon.status === "covered" ? "covered" : "answered"}
            </span>
            {!actionsLocked && (iAmCaller || isForemanPlus(effectiveRole)) && (
              <button
                className="link"
                style={{ marginLeft: "auto", fontSize: 12 }}
                disabled={end.isPending}
                onClick={() => end.mutate()}
              >
                End summon
              </button>
            )}
          </div>
          {summonEtaLine(summon.needed_at) && (
            <p
              className={
                summonEtaLine(summon.needed_at) === "needed NOW" ? "error" : "muted"
              }
              style={{ margin: "6px 0 0", fontSize: 13, fontWeight: 600 }}
            >
              ⏱ Hands needed {summonEtaLine(summon.needed_at)}
            </p>
          )}
          {/* Who's coming, by name — the caller AND every answerer see the
              same list (owner ask, 2026-08-19). */}
          {(helpers.data ?? []).length > 0 && (
            <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none" }}>
              {(helpers.data ?? []).map((h) => (
                <li key={h.id} style={{ fontSize: 13, padding: "2px 0" }}>
                  <strong>{h.helper?.display_name ?? "Helper"}</strong>{" "}
                  <span className="muted">
                    {h.canceled_at
                      ? "backed out"
                      : h.minutes != null
                        ? `helped · ${h.minutes} min`
                        : h.completed_at
                          ? "done"
                          : `answered ${new Date(h.joined_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} — on the way`}
                  </span>
                </li>
              ))}
              {manMinutes > 0 && (
                <li className="muted" style={{ fontSize: 12, paddingTop: 2 }}>
                  {manMinutes} helper-min total
                </li>
              )}
            </ul>
          )}
          {!actionsLocked && !iAmCaller && !myHelp && summon.status === "open" && (
            <button
              className="primary big"
              style={{ marginTop: 8 }}
              disabled={answer.isPending}
              onClick={() => answer.mutate()}
            >
              {answer.isPending ? "Joining…" : "Answer — help carry (+10 pts)"}
            </button>
          )}
          {!actionsLocked && myHelp && (
            <>
              <button
                className="primary big"
                style={{ marginTop: 8 }}
                disabled={complete.isPending}
                onClick={() => complete.mutate()}
              >
                {complete.isPending ? "Stamping…" : "Complete — back to my work"}
              </button>
              <button
                className="link"
                style={{ marginTop: 6, fontSize: 12.5 }}
                disabled={bail.isPending}
                onClick={() => bail.mutate()}
              >
                {bail.isPending
                  ? "Backing out…"
                  : "Can't make it — give my seat back"}
              </button>
            </>
          )}
          {actionsLocked && (
            <p className="muted" style={{ margin: "8px 0 0", fontSize: 12.5 }}>
              You&rsquo;re viewing as {previewPerson?.name ?? "someone else"} —
              buttons here still act as your real account, so they&rsquo;re
              turned off. To answer as {previewPerson?.name ?? "them"}, they log
              in themselves.
            </p>
          )}
        </div>
      )}
      {err && <p className="error" style={{ marginTop: 6, fontSize: 12 }}>{err}</p>}
    </div>
  );
}
