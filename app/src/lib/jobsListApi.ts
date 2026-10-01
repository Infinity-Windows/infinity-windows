// Data access for the Jobs page's "Recently worked" group — the one read
// lib/jobsList.ts's pure helpers don't already get from an existing api
// module (listMyPublished covers "Scheduled").
//
// PERSONAL work only, from the two places real field time actually lives:
// custom-work sessions and time-clock shifts, both scoped to the SIGNED-IN
// profile's own rows. Never `project.updated_at` (anyone's edit lands there)
// and never another person's history — "recently worked" means this person
// stood on the job, not that the job moved.

import { supabase } from "./supabase";
import {
  recentlyWorkedProjectIds,
  type RecentWorkSessionRow,
  type RecentWorkShiftRow,
} from "./jobsList";

/** How far back "recently worked" looks, and how many rows either query will
 * ever pull. Bounded on both axes on purpose: 90 days keeps the group honest
 * about what "recent" means, and the row cap keeps a long-tenured installer's
 * read cheap even inside that window — this is a jobs-list grouping hint, not
 * a report, so it degrades gracefully if it misses an old outlier. */
const RECENT_WORK_DAYS = 90;
const RECENT_WORK_ROW_LIMIT = 200;

function recentWorkSinceIso(): string {
  return new Date(Date.now() - RECENT_WORK_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The project ids this person actually worked in the last 90 days, from
 * custom-work sessions and time-clock shifts alike, excluding anything on a
 * voided or rejected shift (CONTEXT.md: Void — a voided punch "leaves every
 * total instantly", and a rejected one never happened either).
 *
 * Two independent queries rather than a join: the tables don't share a key
 * that would let PostgREST embed one in the other, and this only needs the
 * project id and the one status field off each — explicit selects, house
 * rule, never `select("*")`.
 */
export async function listRecentlyWorkedProjectIds(profileId: string): Promise<Set<string>> {
  const since = recentWorkSinceIso();

  const [sessionsRes, shiftsRes] = await Promise.all([
    supabase
      .from("custom_work_sessions")
      .select("project_id, shift_status")
      .eq("profile_id", profileId)
      .not("project_id", "is", null)
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(RECENT_WORK_ROW_LIMIT),
    supabase
      .from("time_shifts")
      .select("project_id, status")
      .eq("profile_id", profileId)
      .not("project_id", "is", null)
      .gte("clock_in_at", since)
      .order("clock_in_at", { ascending: false })
      .limit(RECENT_WORK_ROW_LIMIT),
  ]);
  if (sessionsRes.error) throw sessionsRes.error;
  if (shiftsRes.error) throw shiftsRes.error;

  return recentlyWorkedProjectIds(
    (sessionsRes.data ?? []) as RecentWorkSessionRow[],
    (shiftsRes.data ?? []) as RecentWorkShiftRow[],
  );
}
