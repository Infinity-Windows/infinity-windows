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
//
// Two races closed after Codex's review of #666 (2026-09-27):
//
//   * A read that asked Forge "signed today?" BEFORE the signature was filed
//     could land after Forge confirmed it and write "not signed" over the
//     confirmation. The signature had already left the phone's queue, so the
//     gate asked for a second one. A confirmation now stops any such read, and
//     the outbox remembers it — per person, on the phone — so no older answer,
//     and no screen that was closed at the moment it arrived, can undo it.
//   * The live "today's talk" read was kept under one key for every day and
//     judged by when it FINISHED. One that asked for Sep 27's talk at
//     23:59:59 and finished at 00:00:01 was taken as Sep 28's. The read is now
//     kept under the day it asks for, the talk it hands out says which day
//     that was (`for_day`), a signature is refused on any other day
//     (lib/toolbox.ts), and an open screen moves to the new day's talk at
//     midnight by itself.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { getTodayTalk, type SafetyTalk } from "./ops";
import { myTodayCompletion } from "./toolbox";
import {
  confirmedSignatureFor,
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

/** Where the live "today's talk" read for one day is kept. */
export function todayTalkKey(day: string): readonly ["todayTalk", string] {
  return ["todayTalk", day];
}

/**
 * The phone's today, YYYY-MM-DD — and a re-render of the caller at the next
 * midnight, so a screen left open overnight moves to the new day by itself.
 * Every render reads the clock, so a render for any other reason after
 * midnight is already on the new day.
 */
export function useLocalDay(): string {
  const [, setTick] = useState(0);
  const day = localDateOf(new Date());
  useEffect(() => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timer = setTimeout(() => setTick((n) => n + 1), next.getTime() - now.getTime() + 250);
    return () => clearTimeout(timer);
  }, [day]);
  return day;
}

export interface TodayTalkView {
  /**
   * Today's talk, carrying the day it is handed out for (`for_day`); null
   * when there is none today; undefined while unknown.
   */
  data: SafetyTalk | null | undefined;
  /** The answer is known — the gates hold only on a KNOWN unsigned talk. */
  isSuccess: boolean;
}

/**
 * Today's talk: the live read asked for today, otherwise the one fetched
 * ahead for today while there was signal. A talk asked for on an earlier day
 * says nothing about today, and neither does "no talk" asked for then — which
 * is why both reads are kept under the day they asked about, not judged by
 * when they finished.
 */
export function useTodayTalk(enabled = true): TodayTalkView {
  const today = useLocalDay();
  const live = useQuery({
    queryKey: todayTalkKey(today),
    queryFn: () => getTodayTalk(today),
    enabled,
  });
  // Filled by lib/toolboxAhead.ts while there is signal; only READ here
  // (skipToken: a gate never fires a read of its own, and the reader stays
  // off the first screen).
  const ahead = useQuery<SafetyTalk | null>({
    queryKey: ["toolboxTalk", today],
    queryFn: skipToken,
  });

  // Any answer asked for today counts — also one a later refetch failed to
  // refresh, which is the dead zone with bars this is for.
  const talk = live.data !== undefined ? live.data : ahead.data;
  const known = live.data !== undefined || ahead.data !== undefined;
  // The day rides on the talk, so signing it on any other day can be refused
  // (a card left open across midnight still holds yesterday's).
  const data = useMemo(() => (talk ? { ...talk, for_day: today } : talk), [talk, today]);
  return known ? { data: data ?? null, isSuccess: true } : { data: undefined, isSuccess: false };
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
  useLocalDay();
  const query = useQuery({
    queryKey: ["toolboxToday", profileId],
    queryFn: () => myTodayCompletion(profileId!),
    enabled: on,
  });
  const snapshot = useSyncExternalStore(subscribe, getToolboxQueueSnapshot, getToolboxQueueSnapshot);
  // Forge's confirmation of a signature this phone sent, remembered by the
  // outbox per person (on the phone, too) the moment it arrives — so neither
  // a read that asked before it was filed, nor a gate that was not on screen
  // when it was sent, nor a reload, can turn it back into "not signed".
  const confirmed = useSyncExternalStore(
    subscribe,
    () => confirmedSignatureFor(profileId),
    () => confirmedSignatureFor(profileId),
  );
  // The queue has to have been read for a signature on it to count; whoever
  // mounts first asks (it is once per session).
  useEffect(() => {
    initOutboxAutoFlush();
  }, []);
  // The moment Forge files a signature this phone sent, its row becomes the
  // cached answer — without it the screens would fall back to the last read,
  // the empty one from before the signature, until a re-read came back. Any
  // read still in the air is stopped first: it asked before the signature was
  // filed, and landing after this it would write "not signed" over it (Codex
  // review of #666). The stop is synchronous — the read's late answer is
  // dropped, its state put back — so the row written next is what stays.
  useEffect(
    () =>
      subscribeToolboxSent((_entry, sent) => {
        const r = sent as { profile_id?: unknown; signed_at?: unknown } | null;
        if (!r || typeof r.profile_id !== "string" || typeof r.signed_at !== "string") return;
        const key = ["toolboxToday", r.profile_id];
        void qc.cancelQueries({ queryKey: key, exact: true });
        qc.setQueryData(key, r);
      }),
    [qc],
  );

  const now = new Date();
  const row = profileId ? (query.data as ToolboxCompletionView | null | undefined) : undefined;
  // A real row is judged by when it was signed; a row with no time on it (a
  // placeholder some screen wrote) by when it was read.
  const serverToday =
    row && (row.signed_at ? signedToday(row.signed_at, now) : readToday(query.dataUpdatedAt, now)) ? row : null;
  const confirmedToday = confirmed && signedToday(confirmed.signed_at, now) ? confirmed : null;
  const pending = todaysPendingSignature(snapshot.entries, profileId, now);

  if (serverToday && !serverToday.pending) {
    return { data: serverToday, isSuccess: true, pending: false, refused: false };
  }
  if (confirmedToday) {
    return { data: confirmedToday, isSuccess: true, pending: false, refused: false };
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
