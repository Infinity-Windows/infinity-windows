// Who hears about a window nobody drew.
//
// Wave E (transcripts program, Q18). The point of letting an installer record
// a missed unit is that somebody with a purchase order finds out the same
// afternoon, not at the end of the job — so the ring has to reach the office
// even when every lead is up a ladder.
//
// Same shape as needJob.ts's audience (slice 5): the on-shift leads UNION
// every supervisor, minus the person who just tapped it. The union is why
// "what if no foreman is on this job" needs no special case — supervisors are
// always in the set, so an empty on-shift list still rings the office.
//
// The audience math is pure so it can be tested without a database; the wiring
// underneath it is three reads and a push.

import { listProfiles } from "./api";
import { isForemanPlus, isSupervisorPlus, type CrewRole } from "./types";
import { listClockedInOnJob } from "./summons";
import { sendPush } from "../permissions/pushServer";

type RoledProfile = { id: string; role?: CrewRole | string | null };

/**
 * PURE: every supervisor+, plus every foreman+ clocked in ON THIS JOB, minus
 * the person who added it. Deliberately job-scoped rather than
 * clocked-in-anywhere: a foreman on a different site cannot walk over and look
 * at the hole, and the supervisor backstop already covers the office.
 */
export function missedUnitAudience(
  clockedInOnJobIds: readonly string[],
  profiles: readonly RoledProfile[],
  callerId: string | null | undefined,
): string[] {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const set = new Set<string>();
  for (const id of clockedInOnJobIds) {
    const p = byId.get(id);
    if (p && isForemanPlus(p.role)) set.add(id);
  }
  for (const p of profiles) {
    if (p.id && isSupervisorPlus(p.role)) set.add(p.id);
  }
  if (callerId) set.delete(callerId);
  return [...set];
}

/** The push body. English by design — push copy is not translated. */
export function missedUnitPushBody(
  jobName: string,
  addedBy: string | null,
  code: string,
): string {
  return `${addedBy ?? "Someone"} added ${code} on ${jobName} — a window or door that isn't on the plans.`;
}

export interface MissedUnitPushInput {
  projectId: string;
  jobName: string;
  openingCode: string;
  openingId: string;
  addedBy: string | null;
  callerId: string | null;
}

/**
 * Ring the audience. Best-effort like every push (sendPush never throws);
 * returns false when there was nobody to ring, so the caller can say so rather
 * than let somebody believe the office already knows.
 */
export async function announceMissedUnit(
  input: MissedUnitPushInput,
): Promise<boolean> {
  const [onJob, profiles] = await Promise.all([
    listClockedInOnJob(input.projectId),
    listProfiles(),
  ]);
  const profileIds = missedUnitAudience(
    onJob.map((c) => c.profileId),
    profiles,
    input.callerId,
  );
  if (profileIds.length === 0) return false;
  return sendPush({
    profileIds,
    title: "🪟 Missed unit added",
    body: missedUnitPushBody(input.jobName, input.addedBy, input.openingCode),
    tag: `missed-unit-${input.openingId}`,
    url: `/projects/${input.projectId}/opening/${input.openingId}`,
  });
}
