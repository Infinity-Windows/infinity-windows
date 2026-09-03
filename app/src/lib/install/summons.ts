// Summon (owner, 2026-08-14): call up to 8 helpers onto a heavy window.
// Answering clocks the helper on (their own timer row, like flashing) and
// pays 10 points instantly; Complete stamps their minutes; the window's
// true cost is lead time + every helper's time. Reads are open; every
// write goes through a security-definer RPC.

import { supabase } from "../supabase";
import { filterToLiveProjects } from "../liveProjects";
import { sendPush } from "../permissions/pushServer";

export interface Summon {
  id: string;
  project_id: string;
  /** The window this call for hands hangs off — or null for a JOB-level call
   * for hands (job-level-summons slice 4, 2026-09-03): a tracking job has no
   * openings, so "come help me carry this" attaches to the job itself, with
   * `where_note` standing in for the window. */
  opening_id: string | null;
  requested_by: string;
  needed: number;
  status: "open" | "covered" | "closed";
  created_at: string;
  closed_at: string | null;
  /** When the hands are needed. Null = "now" (pre-ETA summons). */
  needed_at?: string | null;
  /** Optional plain-words why ("second story, no elevator"). */
  note?: string | null;
  /** "Where I am on the job" — a job-level call for hands has no window, so
   * this says where to walk to ("north side, second floor"). Null on a window
   * summon: the opening already says where (job-level-summons slice 4). */
  where_note?: string | null;
  requester?: { display_name: string | null } | null;
  /** Embedded for the landing strip — absent on older reads, so optional. */
  project?: { job_code: string | null } | null;
  opening?: { opening_code: string | null } | null;
  helpers?: Pick<SummonHelper, "profile_id" | "completed_at" | "canceled_at">[] | null;
  /** Who said they can't come — read so a decline can take the row off
   * their own screen. Absent on older reads, so optional. */
  declines?: Pick<SummonDecline, "profile_id">[] | null;
}

export interface SummonHelper {
  id: string;
  summon_id: string;
  profile_id: string;
  joined_at: string;
  completed_at: string | null;
  /** Backed out ("Can't make it") — seat reopened, points reversed. */
  canceled_at?: string | null;
  minutes: number | null;
  helper?: { display_name: string | null } | null;
}

/** Said "can't help" — informational only, no points, no seat effects. */
export interface SummonDecline {
  summon_id: string;
  profile_id: string;
  created_at: string;
  decliner?: { display_name: string | null } | null;
}

function isMissingTableError(e: { code?: string; message?: string } | null): boolean {
  return Boolean(
    e && (e.code === "42P01" || /relation .* does not exist/i.test(e.message ?? "")),
  );
}

const SUMMON_SELECT =
  "*, requester:profiles!summons_requested_by_fkey(display_name), project:projects(job_code), opening:project_openings(opening_code), helpers:summon_helpers(profile_id, completed_at, canceled_at), declines:summon_declines(profile_id)";

/**
 * A summon is over one day after it was sent (owner ask, 2026-09-02: "a
 * summons should expire 1 day after the user sends the summons"). The server
 * sweep (expire_summons, every 10 minutes) is what actually closes the row;
 * the same rule is read on the phone so the landing strip never leaves a
 * day-old call sitting there in the gap between sweeps.
 *
 * It is applied AFTER the read, by `visibleSummons` — never as a `created_at`
 * bound in the query, and never against the handset's own clock. `created_at`
 * is stamped by `now()` on the server; `Date.now()` is whatever the phone
 * believes. A handset a day ahead (a dead battery restoring a bad clock,
 * someone setting the date by hand) would ask for rows newer than any that
 * exist and show that installer no calls for hands at all, with nothing on
 * screen to explain it. And the caller's own expired summon has to come back
 * from the server, or the strip has nothing to tell them nobody came with.
 */
export const SUMMON_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Live (open/covered) summons on a job — Dispatch indicator + the sheet. */
export async function listLiveSummons(projectId: string): Promise<Summon[]> {
  const { data, error } = await supabase
    .from("summons")
    .select(SUMMON_SELECT)
    .eq("project_id", projectId)
    .in("status", ["open", "covered"])
    .order("created_at");
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return filterToLiveProjects((data ?? []) as unknown as Summon[]);
}

/**
 * Every live summon on every job — the landing pages' call-for-hands strip
 * (owner ask, 2026-08-18): a live summon should find helpers where they
 * already are, My Work and Home, not only on the window's own sheet. One
 * read: a call for hands is never quietly hidden — except for a job the
 * owner just deleted (Wave D), since nobody should keep getting summoned
 * onto a job that no longer exists. What each viewer then sees is
 * `visibleSummons`, which drops the ones they declined and the day-old ones
 * that are not their own.
 */
export async function listAllLiveSummons(): Promise<Summon[]> {
  const { data, error } = await supabase
    .from("summons")
    .select(SUMMON_SELECT)
    .in("status", ["open", "covered"])
    .order("created_at");
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return filterToLiveProjects((data ?? []) as unknown as Summon[]);
}

export async function listSummonHelpers(summonId: string): Promise<SummonHelper[]> {
  const { data, error } = await supabase
    .from("summon_helpers")
    .select("*, helper:profiles!summon_helpers_profile_id_fkey(display_name)")
    .eq("summon_id", summonId)
    .order("joined_at");
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as unknown as SummonHelper[];
}

/** Who can't come — the muted line the caller and every helper see. */
export async function listSummonDeclines(summonId: string): Promise<SummonDecline[]> {
  const { data, error } = await supabase
    .from("summon_declines")
    .select("*, decliner:profiles!summon_declines_profile_id_fkey(display_name)")
    .eq("summon_id", summonId)
    .order("created_at");
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as unknown as SummonDecline[];
}

/** One person on the clock (job-level-summons slice 4). `jobCode` is null on
 * the same-job read — everyone is on the one job — and carries the job code on
 * the reach-further read, where it says where a person is. */
export interface ClockedInPerson {
  profileId: string;
  displayName: string | null;
  jobCode: string | null;
}

interface OpenShiftRow {
  profile_id: string;
  worker?: { display_name: string | null } | null;
  project?: { job_code: string | null } | null;
}

/**
 * The DEFAULT audience for a JOB-level call for hands (job-level-summons
 * slice 4): everyone with an OPEN shift on THIS job right now. This is NOT
 * listRoster — that is the SCHEDULED crew, which is the wrong set. A call for
 * hands rings the people actually clocked into the job, wherever the schedule
 * said they'd be; someone scheduled but not yet on the clock is not carrying
 * anything, and someone clocked into a DIFFERENT job is not here to help. The
 * `status = 'open'` + `clock_out_at is null` pair is the same "genuinely on
 * the clock" test getOpenShift uses.
 */
export async function listClockedInOnJob(projectId: string): Promise<ClockedInPerson[]> {
  const { data, error } = await supabase
    .from("time_shifts")
    .select("profile_id, worker:profiles!profile_id(display_name)")
    .eq("project_id", projectId)
    .eq("status", "open")
    .is("clock_out_at", null);
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return dedupeClockedIn((data ?? []) as unknown as OpenShiftRow[]);
}

/**
 * Everyone clocked in ANYWHERE right now — the reach-further picker's starting
 * list (job-level-summons slice 4). Carries each person's job so the picker
 * can say where they are before you pull them off it onto your own.
 */
export async function listClockedInAnywhere(): Promise<ClockedInPerson[]> {
  const { data, error } = await supabase
    .from("time_shifts")
    .select("profile_id, worker:profiles!profile_id(display_name), project:projects(job_code)")
    .eq("status", "open")
    .is("clock_out_at", null);
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return dedupeClockedIn((data ?? []) as unknown as OpenShiftRow[]);
}

/** One row per person, not per shift — the audience is a set of people. A
 * person should never hold two open shifts, but the read must be a set even
 * if the data ever isn't. `jobCode` rides along when the row carries a project
 * embed (the reach-further read); the same-job read leaves it null. */
function dedupeClockedIn(rows: readonly OpenShiftRow[]): ClockedInPerson[] {
  const seen = new Map<string, ClockedInPerson>();
  for (const r of rows) {
    if (!r.profile_id || seen.has(r.profile_id)) continue;
    seen.set(r.profile_id, {
      profileId: r.profile_id,
      displayName: r.worker?.display_name ?? null,
      jobCode: r.project?.job_code ?? null,
    });
  }
  return [...seen.values()];
}

export async function createSummon(
  openingId: string,
  needed: number,
  leadMinutes?: number | null,
  note?: string | null,
): Promise<Summon> {
  const { data, error } = await supabase.rpc("create_summon", {
    p_opening_id: openingId,
    p_needed: needed,
    p_lead_minutes: leadMinutes ?? null,
    p_note: note?.trim() || null,
  });
  if (error) throw error;
  return data as Summon;
}

/**
 * Call for hands on the whole JOB — no window (job-level-summons slice 4). A
 * tracking job has no openings, so this is how "come help me carry this" gets
 * out on one. `whereNote` is the "where I am on the job" line the job path
 * carries in place of a window. Same server RPC family as createSummon, a
 * distinct name (create_job_summon) so the two can never resolve ambiguously.
 */
export async function createJobSummon(
  projectId: string,
  needed: number,
  note?: string | null,
  whereNote?: string | null,
  leadMinutes?: number | null,
): Promise<Summon> {
  const { data, error } = await supabase.rpc("create_job_summon", {
    p_project_id: projectId,
    p_needed: needed,
    p_lead_minutes: leadMinutes ?? null,
    p_note: note?.trim() || null,
    p_where_note: whereNote?.trim() || null,
  });
  if (error) throw error;
  return data as Summon;
}

export async function answerSummon(summonId: string): Promise<SummonHelper> {
  const { data, error } = await supabase.rpc("answer_summon", {
    p_summon_id: summonId,
  });
  if (error) throw error;
  return data as SummonHelper;
}

export async function completeSummonHelp(summonId: string): Promise<SummonHelper> {
  const { data, error } = await supabase.rpc("complete_summon_help", {
    p_summon_id: summonId,
  });
  if (error) throw error;
  return data as SummonHelper;
}

/** Back out of a summon you answered — seat reopens, points reverse. */
export async function cancelSummonHelp(summonId: string): Promise<SummonHelper> {
  const { data, error } = await supabase.rpc("cancel_summon_help", {
    p_summon_id: summonId,
  });
  if (error) throw error;
  return data as SummonHelper;
}

/**
 * Say you can't come. No points, no seat change — answering later retracts
 * this automatically (server-side). Idempotent: safe to tap more than once.
 */
export async function declineSummon(summonId: string): Promise<SummonDecline> {
  const { data, error } = await supabase.rpc("decline_summon", {
    p_summon_id: summonId,
  });
  if (error) throw error;
  return data as SummonDecline;
}

export async function closeSummon(summonId: string): Promise<Summon> {
  const { data, error } = await supabase.rpc("close_summon", {
    p_summon_id: summonId,
  });
  if (error) throw error;
  return data as Summon;
}

// ------------------------------------------------------------- pure bits

/**
 * Who a JOB-level call for hands rings (job-level-summons slice 4): the
 * same-job clocked-in crew, PLUS anyone chosen through "Reach more people",
 * as one deduped set, minus the caller — nobody rings themselves. Pure so the
 * audience math is tested without a database or a push.
 */
export function callForHandsTargets(
  sameJobIds: readonly string[],
  extraIds: readonly string[],
  callerId: string | null | undefined,
): string[] {
  const set = new Set<string>();
  for (const id of sameJobIds) if (id) set.add(id);
  for (const id of extraIds) if (id) set.add(id);
  if (callerId) set.delete(callerId);
  return [...set];
}

export interface CallForHandsPushInput {
  summonId: string;
  projectId: string;
  jobLabel: string;
  callerId: string | null;
  callerName: string | null;
  needed: number;
  note?: string | null;
  whereNote?: string | null;
  /** The default audience: profile ids clocked into this job. */
  sameJobIds: readonly string[];
  /** Reach-further additions from the by-name picker (may be empty). */
  extraIds?: readonly string[];
}

/**
 * Ring the computed audience for a job-level call for hands. Best-effort like
 * every summon push (sendPush never throws); returns false when there was
 * nobody to ring so the caller can tell the summoner the call is live but
 * silent. The deep link lands on the JOB, not a window — there isn't one.
 */
export async function notifyCallForHands(
  input: CallForHandsPushInput,
): Promise<boolean> {
  const profileIds = callForHandsTargets(
    input.sameJobIds,
    input.extraIds ?? [],
    input.callerId,
  );
  if (profileIds.length === 0) return false;
  const why = input.note?.trim();
  const where = input.whereNote?.trim();
  const tail = [why, where ? `📍 ${where}` : null].filter(Boolean).join(" · ");
  return sendPush({
    profileIds,
    title: `🙌 Hands needed — ${input.jobLabel}`,
    body: `${input.callerName ?? "Someone"} needs ${input.needed} on ${input.jobLabel}${
      tail ? ` — ${tail.slice(0, 120)}` : ""
    }. Answer to help (+10 pts).`,
    tag: `summon-${input.summonId}`,
    url: `/projects/${input.projectId}`,
    urgent: true,
  });
}

/** Helper man-minutes on a summon: completed rows as stamped, open rows
 * live against `now` — the number the window's true cost breakdown shows. */
export function summonHelperMinutes(
  helpers: readonly Pick<SummonHelper, "joined_at" | "completed_at" | "minutes" | "canceled_at">[],
  now: number = Date.now(),
): number {
  let total = 0;
  for (const h of helpers) {
    if (h.canceled_at) {
      continue; // backed out — their 0 minutes stay out of the total
    }
    if (h.minutes != null) {
      total += h.minutes;
    } else if (!h.completed_at) {
      total += Math.max(0, Math.min(480, Math.floor((now - Date.parse(h.joined_at)) / 60000)));
    }
  }
  return total;
}

/**
 * The countdown every viewer reads on a timed summon: "by 1:05 PM · 22 min"
 * while it's ahead, "needed NOW" once the time has passed, null for an
 * untimed summon (the pre-ETA "come when you can").
 */
export function summonEtaLine(
  neededAt: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!neededAt) return null;
  const at = Date.parse(neededAt);
  if (Number.isNaN(at)) return null;
  const when = new Date(at).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  const minsLeft = Math.round((at - now) / 60_000);
  if (minsLeft <= 0) return "needed NOW";
  return `by ${when} · ${minsLeft} min`;
}

/**
 * The landing strip's one-line story for a live summon: who needs hands, how
 * many, where — in the crew's words. `mine` flips the voice ("You called
 * for…") so your own summon reads as confirmation, not as somebody else's
 * emergency.
 *
 * Once a call is a day old it is over (owner ask, 2026-09-02). The caller is
 * the only person still shown it, and what they need is the ending, not a
 * countdown — so their line says so plainly instead of reading as open.
 */
export function summonStripLine(
  s: Pick<
    Summon,
    "needed" | "status" | "requester" | "project" | "opening" | "needed_at" | "helpers"
  > &
    Partial<Pick<Summon, "created_at">>,
  mine: boolean,
  now: number | null = Date.now(),
): string {
  const where = [
    s.project?.job_code ?? null,
    s.opening?.opening_code ? `#${s.opening.opening_code}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (mine && s.created_at && summonExpired(s.created_at, now)) {
    // "Nobody came" has to be true to be worth saying — a call that got
    // hands and then ran out of day gets the other half of the sentence.
    const anyoneCame = (s.helpers ?? []).some((h) => !h.canceled_at);
    const ended = anyoneCame
      ? "Expired — the call ended after a day"
      : "Expired — nobody came in a day";
    return where ? `${ended} — ${where}` : ended;
  }
  const hands = `${s.needed} ${s.needed === 1 ? "hand" : "hands"}`;
  const head = mine
    ? `You called for ${hands}`
    : `${s.requester?.display_name ?? "Someone"} needs ${hands}`;
  let base = where ? `${head} — ${where}` : head;
  // The countdown is a live timer, not a hiding rule: with no measured
  // offset the device's own clock is the only one there is, and a wrong one
  // makes a minute count look off rather than making a call disappear.
  const eta = summonEtaLine(s.needed_at, now ?? Date.now());
  if (eta) base = `${base} · ${eta}`;
  return s.status === "covered" ? `${base} (covered)` : base;
}

/**
 * Has this viewer answered this summon and not backed out? Drives the strip
 * row ("You answered — on the way" instead of an Answer pill) so a person
 * who already committed is never re-asked (owner report, 2026-08-19).
 */
export function iAnswered(
  s: Pick<Summon, "helpers">,
  myProfileId: string | null | undefined,
): boolean {
  if (!myProfileId) return false;
  return (s.helpers ?? []).some(
    (h) => h.profile_id === myProfileId && !h.canceled_at,
  );
}

/**
 * The clock the one-day rule is read against: the database's, reconstructed
 * on the phone from a measured offset (`clockSkewMs`, wave T's `server_now`
 * RPC) rather than trusted from `Date.now()`. The device's *elapsed* time is
 * fine — it is its idea of the date that can be hours or days out.
 *
 * `null` — no offset measured yet, or the phone is offline — means "no clock
 * worth deciding on", and then nothing is treated as expired. Showing a call
 * ten minutes past its day costs someone a walk they didn't need; hiding a
 * live one costs them the help.
 */
export function summonNow(
  skewMs: number | null | undefined,
  deviceNowMs: number = Date.now(),
): number | null {
  return skewMs == null ? null : deviceNowMs - skewMs;
}

/**
 * Is this call over? One day from `created_at`, matching the server rule
 * (`created_at < now() - interval '1 day'`) exactly — a summon sent 24 hours
 * ago on the nose is still live for that instant, one tick later it is not.
 * Same boundary in both places, so the phone and the database never disagree
 * about a row on screen.
 */
export function summonExpired(
  createdAt: string,
  now: number | null = Date.now(),
): boolean {
  if (now == null) return false; // no trusted clock: never hide the call
  const at = Date.parse(createdAt);
  if (Number.isNaN(at)) return false; // unreadable date: never hide the call
  return now - at > SUMMON_LIFETIME_MS;
}

/**
 * What one person should actually see on their landing strip (owner ask,
 * 2026-09-02: "I should have the option to say Decline so that it goes off
 * of my screen. That way I don't have these summons piled up").
 *
 * Two things come off: a summon you declined, and a summon older than a day.
 * One thing deliberately stays — your OWN expired call. You are the person
 * owed an answer about it, so it holds its place reading "Expired — nobody
 * came in a day" rather than vanishing without a word; the server sweep is
 * what finally takes it away.
 *
 * Everything else stays, including summons you answered and covered ones: a
 * call for hands is never quietly hidden.
 */
export function visibleSummons(
  rows: readonly Summon[],
  myProfileId: string | null | undefined,
  now: number | null = Date.now(),
): Summon[] {
  return rows.filter((s) => {
    const mine = Boolean(myProfileId) && s.requested_by === myProfileId;
    if (
      myProfileId &&
      (s.declines ?? []).some((d) => d.profile_id === myProfileId)
    ) {
      return false;
    }
    if (!summonExpired(s.created_at, now)) return true;
    return mine;
  });
}

/**
 * Owner rule: anything bigger than 4040 (4'0" × 4'0") likely needs a
 * summon — the install-start prompt fires when EITHER side beats 48".
 * Declinable by design (owner pick).
 */
export function sizeSuggestsSummon(
  widthIn: number | null | undefined,
  heightIn: number | null | undefined,
): boolean {
  return (widthIn ?? 0) > 48 || (heightIn ?? 0) > 48;
}
