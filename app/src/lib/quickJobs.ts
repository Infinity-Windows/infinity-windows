// Quick tracking jobs — the pure rules behind "start a Tracking-only job in a
// tap from the clock-in" (standard-tracking-jobs slice 5, 2026-09-03).
//
// WHY (owner ask): service and warranty work turns up without a job on the
// board — a truck rolls to a callback and the crew needs somewhere to clock
// their hours NOW, not after the office builds a job. A foreman makes one on
// the spot: a name (or just an address) and it exists, tracking-only. The
// creation itself is api.createTrackingJob; this file is the two decisions
// that must be right BEFORE the write and are worth testing on their own:
//   1. what the job is CALLED when the name box is left blank, and
//   2. whether one ALREADY EXISTS — so a second person joins the live job
//      instead of forking a duplicate for the same callback.
//
// No React, no Supabase here: the naming and the match are unit-tested
// directly (quickJobs.test.ts) rather than through a ClockInBlock render.

import type { Project } from "./types";
import { allowsTracking } from "./jobModes";

/** Trim + lowercase + collapse runs of whitespace, so "  123  Main St " and
 * "123 main st" compare equal. */
function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The name a quick tracking job gets. The typed name wins; blank falls back to
 * the address, then the customer, then a plain label — a job with no name at
 * all can't be created (createProject refuses), and "auto-named from the
 * address/customer" is the owner's own wording for the blank case.
 */
export function quickJobName(input: {
  name?: string | null;
  address?: string | null;
  customerName?: string | null;
}): string {
  const name = (input.name ?? "").trim();
  if (name) return name;
  const address = (input.address ?? "").trim();
  if (address) return address;
  const customer = (input.customerName ?? "").trim();
  if (customer) return customer;
  return "Tracking job";
}

/** A short random tail so two callbacks named "Warranty" never collide on the
 * projects.job_code UNIQUE. base36, four chars — plenty for hand-made jobs. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, "0");
}

/**
 * A job_code for a quick tracking job, derived from its name plus a random
 * tail. Emits only [A-Z0-9-] so it passes createProject's own sanitiser
 * unchanged; the tail keeps it unique without a round-trip to check. `suffix`
 * is injectable so the test is deterministic.
 */
export function quickTrackingJobCode(name: string, suffix: string = randomSuffix()): string {
  const base =
    name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 16)
      .replace(/-+$/g, "") || "JOB";
  return `${base}-${suffix}`;
}

/** True when two free-text values plausibly name the same place: one contains
 * the other once normalised. Guards against matching on a stray character —
 * two chars minimum, so "a" doesn't join every job on the board. */
function fieldMatches(candidate: string | null | undefined, typed: string): boolean {
  const a = norm(candidate);
  const b = norm(typed);
  if (!a || b.length < 2) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * Open tracking jobs whose name OR address matches what the foreman is typing
 * — the de-dupe list shown BEFORE the create button, so a second person joins
 * the live callback instead of forking a duplicate.
 *
 * Only tracking-allowed, live jobs are candidates: a data job is never a quick
 * tracking job, and a finished or trashed job is not something to join. The
 * caller passes the jobs it already loaded (ClockInBlock's `projects` query,
 * which is active + non-deleted); the status/deleted guard here is belt and
 * suspenders so the match rule is honest on any list it is handed.
 */
export function matchingTrackingJobs(
  projects: readonly Project[],
  name: string,
  address: string,
): Project[] {
  const typedName = name.trim();
  const typedAddress = address.trim();
  if (!typedName && !typedAddress) return [];
  return projects.filter((p) => {
    if (p.status !== "active" || p.deleted_at) return false;
    if (!allowsTracking(p.allowed_modes)) return false;
    return (
      (typedName !== "" && fieldMatches(p.name, typedName)) ||
      (typedAddress !== "" && fieldMatches(p.address, typedAddress))
    );
  });
}
