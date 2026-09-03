// "Need a job for this?" — an installer with no job to clock into asks a lead
// to make one (standard-tracking-jobs slice 5, 2026-09-03).
//
// WHY (owner ask): an installer rolls up to a callback with no job on the
// board and can't create one (creation stays foreman+). Rather than stand
// there, they tap one button: it rings every foreman+ who is ON THE CLOCK
// right now — the leads actually working, wherever they are — PLUS every
// supervisor as a backstop, so the request never falls into a hole when no
// foreman happens to be punched in. Whoever gets it makes the tracking job
// (api.createTrackingJob) and the installer clocks in.
//
// The AUDIENCE is the part worth testing on its own, so it is a pure function
// (needJobAudience) over an already-fetched clocked-in list and profile list;
// requestJobForClockIn just wires those reads to it and rings the result.

import { listProfiles } from "./install/api";
import { isForemanPlus, isSupervisorPlus, type CrewRole } from "./install/types";
import { listClockedInAnywhere } from "./install/summons";
import { sendPush } from "./permissions/pushServer";

/** The bit of a profile the audience math reads. `role` is left loose (raw
 * string tolerated) — isForemanPlus/isSupervisorPlus already normalise it. */
type RoledProfile = { id: string; role?: CrewRole | string | null };

/**
 * Who a "need a job" request rings: every foreman+ currently clocked in (any
 * job) UNION every supervisor+, minus the requester — nobody rings themselves.
 *
 * The union is why "if no foreman+ is on shift, all supervisors" needs no
 * special case: supervisors are always in the set, so an empty on-shift-lead
 * list leaves exactly the supervisor backstop. A foreman on the clock is added
 * on top; a supervisor is in whether or not they are punched in, because they
 * are the safety net.
 */
export function needJobAudience(
  clockedInIds: readonly string[],
  profiles: readonly RoledProfile[],
  callerId: string | null | undefined,
): string[] {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const set = new Set<string>();
  // Foreman+ who are on the clock right now.
  for (const id of clockedInIds) {
    const p = byId.get(id);
    if (p && isForemanPlus(p.role)) set.add(id);
  }
  // Every supervisor+, on shift or not — the backstop.
  for (const p of profiles) {
    if (p.id && isSupervisorPlus(p.role)) set.add(p.id);
  }
  if (callerId) set.delete(callerId);
  return [...set];
}

export interface NeedJobInput {
  /** The installer's own words ("warranty callback, front door"). */
  note?: string | null;
  /** Optional address so a lead can name the job from it. */
  address?: string | null;
  callerId: string | null;
  callerName: string | null;
}

/**
 * Ring the computed audience. Best-effort like every push (sendPush never
 * throws); returns false when there was nobody to ring so the caller can tell
 * the installer nobody is reachable rather than leaving them thinking help is
 * coming. Reuses the slice-4 presence read (listClockedInAnywhere).
 */
export async function requestJobForClockIn(input: NeedJobInput): Promise<boolean> {
  const [clockedIn, profiles] = await Promise.all([
    listClockedInAnywhere(),
    listProfiles(),
  ]);
  const profileIds = needJobAudience(
    clockedIn.map((c) => c.profileId),
    profiles,
    input.callerId,
  );
  if (profileIds.length === 0) return false;
  const note = input.note?.trim();
  const address = input.address?.trim();
  const tail = [note, address ? `📍 ${address}` : null].filter(Boolean).join(" · ");
  return sendPush({
    profileIds,
    title: "🙋 Someone needs a job",
    body: `${input.callerName ?? "An installer"} needs a job to clock into${
      tail ? ` — ${tail.slice(0, 140)}` : ""
    }. Start a quick tracking job so they can clock in.`,
    tag: `need-job-${input.callerId ?? "anon"}`,
    url: "/",
  });
}
