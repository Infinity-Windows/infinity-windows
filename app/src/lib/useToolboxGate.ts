// Today's toolbox talk, and whether this person has signed it, as every gate
// should read them (offline toolbox signing, owner go 2026-09-25).
//
// The clock-in, unit work, the nag banner and the Safety page all ask the
// same two questions, and they used to ask the server directly. With no
// signal that went wrong twice over:
//
//   * a signature made on this phone is not on the server until the truck
//     finds signal, so the gates stayed shut on a talk the person had just
//     signed. The signature now waits in the outbox, and a signature for
//     today still on the phone counts as signed — waiting to send, or refused
//     and saying so — exactly the way a queued clock-in counts as clocked in
//     (K0.1, useOpenShiftView);
//   * both answers are cached for the phone, under keys with no date in them,
//     so a phone that last had signal yesterday opened this morning with
//     YESTERDAY's talk and YESTERDAY's signature: every gate open, and a
//     clock-in the server would refuse. An answer read before today's
//     midnight no longer counts for today. Today's talk comes from the days
//     fetched ahead while there was signal (lib/toolboxAhead.ts), and a
//     signature counts only for the day it was signed — the rule the server
//     keeps too (20261033000000).

import { useEffect, useSyncExternalStore } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { getTodayTalk, type SafetyTalk } from "./ops";
import { myTodayCompletion } from "./toolbox";
import {
  getToolboxQueueSnapshot,
  initOutboxAutoFlush,
  subscribe,
  subscribeToolboxSent,
} from "./offline/outbox";
import {
  localDateOf,
  pendingCompletionOf,
  signedToday,
  todaysPendingSignature,
  type ToolboxCompletionView,
} from "./toolboxSign";

/** True when a cached answer was read on the phone's today. */
function readToday(dataUpdatedAt: number, now: Date): boolean {
  return dataUpdatedAt > 0 && localDateOf(new Date(dataUpdatedAt)) === localDateOf(now);
}

export interface TodayTalkView {
  /** Today's talk; null when there is none today; undefined while unknown. */
  data: SafetyTalk | null | undefined;
  /** The answer is known — the gates hold only on a KNOWN unsigned talk. */
  isSuccess: boolean;
}

/**
 * Today's talk: the live read when it was made today, otherwise the one
 * fetched ahead for today while there was signal. A talk cached on an earlier
 * day says nothing about today, and neither does "no talk" cached then.
 */
export function useTodayTalk(enabled = true): TodayTalkView {
  const now = new Date();
  const today = localDateOf(now);
  const live = useQuery({ queryKey: ["todayTalk"], queryFn: getTodayTalk, enabled });
  // Filled by lib/toolboxAhead.ts while there is signal; only READ here
  // (skipToken: a gate never fires a read of its own, and the reader stays
  // off the first screen).
  const ahead = useQuery<SafetyTalk | null>({
    queryKey: ["toolboxTalk", today],
    queryFn: skipToken,
  });

  // Any answer read today counts — also one a later refetch failed to
  // refresh, which is the dead zone with bars this is for.
  if (live.data !== undefined && readToday(live.dataUpdatedAt, now)) {
    return { data: live.data ?? null, isSuccess: true };
  }
  if (ahead.data !== undefined) return { data: ahead.data, isSuccess: true };
  if (live.data && live.data.talk_date === today) {
    return { data: live.data, isSuccess: true };
  }
  return { data: undefined, isSuccess: false };
}

export interface ToolboxTodayView {
  /** Today's signature — Forge's row, or the one still on this phone. */
  data: ToolboxCompletionView | null | undefined;
  /** The answer is known (see TodayTalkView). */
  isSuccess: boolean;
  /** Signed on this phone, not in Forge yet. */
  pending: boolean;
  /** Signed on this phone, and Forge refused it: sendError says why. */
  refused: boolean;
}

/**
 * Has this person signed today's talk? Forge's answer when it has one for
 * today; otherwise the signature still on this phone; otherwise no.
 * `enabled` switches off only the read from Forge (the landing block on the
 * clock has no gate to open); a signature on this phone is always counted,
 * because reading it costs nothing.
 */
export function useToolboxToday(profileId: string | null | undefined, enabled = true): ToolboxTodayView {
  const qc = useQueryClient();
  const on = Boolean(profileId) && enabled;
  const query = useQuery({
    queryKey: ["toolboxToday", profileId],
    queryFn: () => myTodayCompletion(profileId!),
    enabled: on,
  });
  const snapshot = useSyncExternalStore(subscribe, getToolboxQueueSnapshot, getToolboxQueueSnapshot);
  // The queue has to have been read for a signature on it to count; whoever
  // mounts first asks (it is once per session).
  useEffect(() => {
    initOutboxAutoFlush();
  }, []);
  // The moment Forge files a signature this phone sent, its row becomes the
  // cached answer — without it the screens would fall back to the last read,
  // the empty one from before the signature, until a re-read came back.
  useEffect(
    () =>
      subscribeToolboxSent((_entry, row) => {
        const r = row as { profile_id?: unknown; signed_at?: unknown } | null;
        if (r && typeof r.profile_id === "string" && typeof r.signed_at === "string") {
          qc.setQueryData(["toolboxToday", r.profile_id], r);
        }
      }),
    [qc],
  );

  const now = new Date();
  const row = profileId ? (query.data as ToolboxCompletionView | null | undefined) : undefined;
  // A real row is judged by when it was signed; a row with no time on it (a
  // placeholder some screen wrote) by when it was read.
  const serverToday =
    row && (row.signed_at ? signedToday(row.signed_at, now) : readToday(query.dataUpdatedAt, now)) ? row : null;
  const pending = todaysPendingSignature(snapshot.entries, profileId, now);

  if (serverToday && !serverToday.pending) {
    return { data: serverToday, isSuccess: true, pending: false, refused: false };
  }
  if (pending) {
    const view = pendingCompletionOf(pending);
    return { data: view, isSuccess: true, pending: true, refused: Boolean(view.sendFailed) };
  }
  if (!on) return { data: undefined, isSuccess: false, pending: false, refused: false };
  // Any answer the phone holds says "not signed today" once it names no
  // signature for today: a refetch that failed on bars-but-no-data keeps it,
  // and yesterday's row is not today's. Only a phone with no answer at all
  // does not know.
  const known = query.data !== undefined;
  return { data: known ? null : undefined, isSuccess: known, pending: false, refused: false };
}
