// Summon (owner, 2026-08-14): mid-install, call up to 8 helpers onto a
// heavy window. Everyone on the job gets rung (push, as hard as the
// platform allows); answering clocks the helper on and pays 10 points
// instantly; Complete stamps their minutes; the window's true cost shows
// lead + helper time. Windows over 4040 get a declinable prompt.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  answerSummon,
  closeSummon,
  completeSummonHelp,
  createSummon,
  listLiveSummons,
  listSummonHelpers,
  sizeSuggestsSummon,
  summonHelperMinutes,
  type Summon,
} from "../../lib/install/summons";
import { listRoster } from "../../lib/chat/api";
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

  const call = useMutation({
    mutationFn: async () => {
      const created = await createSummon(openingId, needed);
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
            body: `${myName ?? "An installer"} needs ${needed} for a heavy window. Answer to help (+10 pts).`,
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
    onSuccess: refresh,
    onError: (e) => setErr(formatApiError(e)),
  });
  const complete = useMutation({
    mutationFn: () => completeSummonHelp(summon!.id),
    onSuccess: refresh,
    onError: (e) => setErr(formatApiError(e)),
  });
  const end = useMutation({
    mutationFn: () => closeSummon(summon!.id),
    onSuccess: refresh,
    onError: (e) => setErr(formatApiError(e)),
  });

  const myHelp = (helpers.data ?? []).find(
    (h) => h.profile_id === myProfileId && !h.completed_at,
  );
  const iAmCaller = summon?.requested_by === myProfileId;
  const helperCount = helpers.data?.length ?? 0;
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

      {!summon && !suggest && installRunning && !actionsLocked && (
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
          <button
            className="primary big"
            style={{ marginTop: 8 }}
            disabled={call.isPending}
            onClick={() => call.mutate()}
          >
            {call.isPending ? "Ringing the crew…" : `Ring the crew — need ${needed}`}
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
          {(helpers.data ?? []).length > 0 && (
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>
              {(helpers.data ?? [])
                .map(
                  (h) =>
                    `${h.helper?.display_name ?? "helper"}${
                      h.minutes != null ? ` · ${h.minutes}m` : " · helping"
                    }`,
                )
                .join("  ·  ")}
              {manMinutes > 0 ? `  —  ${manMinutes} helper-min total` : ""}
            </p>
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
            <button
              className="primary big"
              style={{ marginTop: 8 }}
              disabled={complete.isPending}
              onClick={() => complete.mutate()}
            >
              {complete.isPending ? "Stamping…" : "Complete — back to my work"}
            </button>
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
