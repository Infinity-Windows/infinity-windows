// A call for hands finds helpers where they already are (owner ask,
// 2026-08-18): while a summon is live it rides the landing pages — My Work
// for installers, Home for foremen — not only the window's own sheet.
// Tapping a row lands on that sheet, where Answer clocks you on. The strip
// renders nothing when nothing is live, so most days it does not exist.
//
// Decline (owner ask, 2026-09-02): "I should have the option to say Decline
// so that it goes off of my screen. That way I don't have these summons
// piled up." Declining costs nothing and changes no seats — it tells the
// caller you're out and takes the row off YOUR strip. Between that and the
// one-day expiry, the strip only ever holds calls you could still walk to.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { clockSkewMs, fetchServerNowMs } from "../../lib/clockSkew";
import { getMyProfile } from "../../lib/install/api";
import { formatApiError } from "../../lib/install/errors";
import { pushToast } from "../../lib/toast";
import { useT } from "../../lib/i18n";
import {
  declineSummon,
  iAnswered,
  listAllLiveSummons,
  summonExpired,
  summonNow,
  summonStripLine,
  visibleSummons,
} from "../../lib/install/summons";

export function LiveSummonsStrip() {
  const queryClient = useQueryClient();
  const t = useT();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const live = useQuery({
    queryKey: ["liveSummonsAll"],
    queryFn: listAllLiveSummons,
    // Pushes announce a new summon; this keeps the strip honest for anyone
    // already sitting on the page.
    refetchInterval: 30_000,
  });
  // Whose day is it? The database's. Every summon's created_at is stamped by
  // the server, so the one-day rule is read against the server's clock,
  // measured once as an offset from this phone's (clockSkew.ts, the same
  // precedent as the 30-day trash countdown). A handset whose date has
  // drifted must never hide a live call for hands from the one person
  // standing next to the window — until the offset is known, nothing is
  // treated as expired.
  const skew = useQuery({
    queryKey: ["clockSkewMs"],
    queryFn: async () => clockSkewMs(Date.now(), await fetchServerNowMs()),
    staleTime: 5 * 60_000,
  });
  const now = summonNow(skew.data);

  // A declined row leaves the screen on the tap, not on the refetch — a
  // phone on bad signal must not leave the summon sitting there looking
  // like the tap missed. Put back if the write fails.
  const [dismissed, setDismissed] = useState<string[]>([]);

  const decline = useMutation({
    mutationFn: (summonId: string) => declineSummon(summonId),
    onMutate: (summonId: string) => {
      setDismissed((ids) => [...ids, summonId]);
    },
    onSuccess: () => {
      pushToast(t("summon.declined"), "success");
      void queryClient.invalidateQueries({ queryKey: ["liveSummonsAll"] });
      // The window's own sheet keeps a live "Can't come" list, so every
      // project-scoped summon read refreshes too.
      void queryClient.invalidateQueries({ queryKey: ["summons"] });
      void queryClient.invalidateQueries({ queryKey: ["summonDeclines"] });
    },
    onError: (e, summonId) => {
      setDismissed((ids) => ids.filter((id) => id !== summonId));
      pushToast(formatApiError(e), "error");
    },
  });

  const rows = visibleSummons(live.data ?? [], me.data?.id, now).filter(
    (s) => !dismissed.includes(s.id),
  );
  if (rows.length === 0) return null;

  return (
    <section aria-label="Live summons" style={{ display: "grid", gap: 8 }}>
      {rows.map((s) => {
        const mine = Boolean(me.data?.id && s.requested_by === me.data.id);
        const answered = iAnswered(s, me.data?.id);
        // Only your own expired call survives the visibility rule, and it is
        // a record of what happened, not a call anyone can still answer.
        const expired = summonExpired(s.created_at, now);
        const open = s.status === "open" && !expired;
        return (
          <div
            key={s.id}
            className="find-row"
            style={{
              border: `1px solid ${open ? "var(--danger)" : "var(--border)"}`,
              borderRadius: 12,
              padding: "10px 14px",
              gap: 10,
            }}
          >
            {/* The whole row still opens the sheet — Decline is a SIBLING of
                that link, never inside it, so a tap on "no" can't also walk
                you to the window. */}
            <Link
              to={`/projects/${s.project_id}/opening/${s.opening_id}`}
              style={{
                minWidth: 0,
                flex: 1,
                display: "flex",
                alignItems: "center",
                gap: 10,
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <span style={{ minWidth: 0, flex: 1 }}>
                <strong className={answered && !expired ? "ok" : open ? "error" : "muted"}>
                  {expired
                    ? t("summon.status.expired")
                    : answered
                      ? t("summon.status.answered")
                      : open
                        ? t("summon.status.open")
                        : t("summon.status.covered")}
                </strong>{" "}
                <span>{summonStripLine(s, mine, now)}</span>
              </span>
              {open && !mine && !answered && (
                <span className="button-like active-pill" aria-hidden>
                  {t("summon.action.answer")}
                </span>
              )}
            </Link>
            {open && !mine && !answered && (
              <button
                className="link"
                style={{ fontSize: 12.5 }}
                disabled={decline.isPending}
                onClick={() => decline.mutate(s.id)}
              >
                {t("summon.action.decline")}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
