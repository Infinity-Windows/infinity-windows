// Today's toolbox talk and the next few days', kept on the phone while it has
// signal (offline toolbox signing, owner go 2026-09-25).
//
// Signing with no signal needs the talk to sign. The phone kept only "today's
// talk" under a key with no date in it, so a phone whose last signal was
// yesterday opened this morning holding YESTERDAY's talk, and had nothing at
// all for today. Every time there is signal — at start, on sign-in, and when
// the app comes back to the front or the connection returns — this reads each
// day's talk from today on and keeps it under that day's own key
// (["toolboxTalk", "YYYY-MM-DD"], kept offline), which is where the gates look
// for today's talk when the live read is from an earlier day
// (lib/useToolboxGate.ts).
//
// WHY FOUR DAYS (today and the next three). There is one talk per calendar day,
// weekends included (the rotation walks the whole library on Saturday and
// Sunday so a weekend crew still has one), and a lead can pin a talk to any
// date. The longest ordinary stretch between a phone's last signal and the
// next morning's signature is a weekend: signal on Friday, signing on Monday
// — three days ahead. Reading further ahead makes each day's talk earlier than
// anybody would, which a lead pinning a talk to that date then has to replace
// (assignTalk does, while nobody has signed it), and adds nothing for a crew
// that opens the app with signal at least once over a weekend.

import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import type { SafetyTalk } from "./ops";
import { localDateOf } from "./toolboxSign";

export const TALK_DAYS_AHEAD = 4;

/**
 * One date's talk: the date's own row, or the one the rotation makes for it
 * — what getTodayTalk (lib/ops.ts) answers on that day. No "newest talk"
 * fallback: that stands in for today on a database without the rotation, and
 * is never some other day's talk. Throws when neither read answers, so
 * nothing is kept for that day.
 */
export async function getTalkForDate(date: string): Promise<SafetyTalk | null> {
  const { data, error } = await supabase
    .from("safety_talks").select("*")
    .eq("talk_date", date)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!error && data) return data as SafetyTalk;

  const rpc = await supabase.rpc("get_or_create_toolbox_talk_for_date", { p_date: date });
  if (rpc.error) throw rpc.error;
  return (rpc.data as SafetyTalk | null) ?? null;
}

/** Half an hour between reads on the same day: signal comes and goes a lot. */
export const TALK_PREFETCH_EVERY_MS = 30 * 60_000;

/** Today and the next days, on the phone's own calendar. */
export function talkDatesAhead(now: Date = new Date(), days: number = TALK_DAYS_AHEAD): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    out.push(localDateOf(d));
  }
  return out;
}

/**
 * Read each day's talk and keep it. Never rejects: a day that cannot be read
 * keeps whatever the phone already had for it, and the others still land.
 * A day read within the last half hour is not read again.
 */
export async function prefetchToolboxTalks(qc: QueryClient, now: Date = new Date()): Promise<void> {
  await Promise.allSettled(
    talkDatesAhead(now).map((date) =>
      qc.fetchQuery({
        queryKey: ["toolboxTalk", date],
        queryFn: () => getTalkForDate(date),
        staleTime: TALK_PREFETCH_EVERY_MS,
        retry: 0,
      }),
    ),
  );
}

/** Is now a time to read ahead? With signal, and not twice in half an hour on one day. */
export function shouldPrefetchTalks(s: {
  online: boolean;
  lastRunAt: number | null;
  lastRunDay: string | null;
  now: number;
}): boolean {
  if (!s.online) return false;
  if (s.lastRunAt === null || s.lastRunDay !== localDateOf(new Date(s.now))) return true;
  return s.now - s.lastRunAt >= TALK_PREFETCH_EVERY_MS;
}

let lastRunAt: number | null = null;
let lastRunDay: string | null = null;
let wiredFor: QueryClient | null = null;

/** Read ahead now, if it is time to (see shouldPrefetchTalks). */
export function prefetchToolboxTalksIfDue(qc: QueryClient): void {
  const now = Date.now();
  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  if (!shouldPrefetchTalks({ online, lastRunAt, lastRunDay, now })) return;
  lastRunAt = now;
  lastRunDay = localDateOf(new Date(now));
  void prefetchToolboxTalks(qc, new Date(now));
}

/**
 * Read ahead at start and at sign-in (the caller), and again whenever the app
 * comes back to the front or the connection returns. Wired once per session.
 */
export function initToolboxTalkPrefetch(qc: QueryClient): void {
  prefetchToolboxTalksIfDue(qc);
  if (wiredFor === qc || typeof window === "undefined") return;
  wiredFor = qc;
  const again = () => prefetchToolboxTalksIfDue(qc);
  window.addEventListener("online", again);
  window.addEventListener("focus", again);
  document.addEventListener?.("visibilitychange", () => {
    if (document.visibilityState === "visible") again();
  });
}
