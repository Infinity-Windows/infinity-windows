// Turning "we know about this one" into something somebody actually chases.
//
// Labelling a spec/plan discrepancy (see `specReconciliation.ts`) tells the
// review screen to stop shouting about it. That is the right thing for the
// screen and the wrong thing for the job: the supplier still hasn't sent the
// sheet for Black Desert mark #7, and a label that only quietens a screen is
// how that gets forgotten until a crew is standing in front of the opening.
//
// So the first time a discrepancy is labelled it also opens a trackable issue,
// and un-labelling resolves that issue instead of deleting it, which keeps the
// history of what was chased and when.
//
// THE DEDUP GUARANTEE. Extraction can be re-run at will, so "raise an issue for
// each discrepancy" would spray duplicates. The guarantee here is structural
// rather than behavioural: `project_spec_discrepancies` is unique on
// (project_id, mark_code, kind) and carries the `issue_id` link itself, so an
// issue is created only when that link is null. Re-running extraction any
// number of times cannot produce a second issue, because the second attempt
// finds the link already populated. Un-labelling keeps the row (status flips to
// 'withdrawn') precisely so the link survives and a re-label reopens the SAME
// issue rather than raising a new one.
//
// This module is the pure half: the state machine, the wording, and the role
// predicate. The database RPC `acknowledge_spec_discrepancy` is the executor
// and MIRRORS the state machine below — it has to run server-side to be atomic
// and to enforce the role guard, but the decision it makes is the one
// `issueActionForAcknowledgement` describes, and these tests pin that contract.

import { markLabel, type Discrepancy } from "./specReconciliation";
import { isForemanPlus } from "./types";
import type { IssueKind } from "../issues";

/**
 * The issue kind raised for a spec/plan discrepancy.
 *
 * Deliberately NOT `missing`. That kind means one specific thing everywhere
 * else in the app — a physical unit that didn't come off the truck. It is
 * created with a `window_id`, resolved by receiving that unit, counted into
 * reorder needs, and displayed under the heading "Missing deliveries". Filing
 * "the supplier's sheet doesn't cover mark #7" there would put a paperwork
 * problem in the warehouse's delivery list, where nobody chasing a supplier
 * would look and where it would muddle the receiving screen's counts.
 */
export const SPEC_GAP_ISSUE_KIND = "spec_gap" as IssueKind;

/** What the linked issue is doing right now, as far as the label knows. */
export interface IssueLink {
  /** The issue this discrepancy already raised, if it ever raised one. */
  issueId: string | null;
  /** That issue's status, when we have it. */
  issueStatus?: "open" | "resolved" | null;
}

/**
 * What labelling a discrepancy should do to its issue. PURE.
 *
 *   - never raised one           → `create`
 *   - raised one, since resolved → `reopen` (the same issue, never a second)
 *   - raised one, still open     → `none`
 *
 * The `none` case is the one that carries the dedup guarantee: it is what a
 * repeat label — or a re-extract followed by a re-label — lands on.
 */
export function issueActionForAcknowledgement(
  link: IssueLink,
): "create" | "reopen" | "none" {
  if (!link.issueId) return "create";
  return link.issueStatus === "resolved" ? "reopen" : "none";
}

/**
 * What un-labelling should do. Resolving an already-resolved issue is a no-op
 * rather than an error, so un-labelling twice is safe. PURE.
 */
export function issueActionForWithdrawal(link: IssueLink): "resolve" | "none" {
  if (!link.issueId) return "none";
  return link.issueStatus === "resolved" ? "none" : "resolve";
}

/**
 * Raising and resolving these is a foreman+ action, matching who can see the
 * reconciliation report at all. An installer sees one calm line on the unit in
 * their hand and never the project-wide list, so there is nothing for them to
 * label. Mirrors the guard inside the RPC. PURE.
 */
export function canManageSpecDiscrepancyIssues(
  role: string | null | undefined,
): boolean {
  return isForemanPlus(role);
}

/** "Black Desert (BLACK22)" — how a job is named to someone outside the app. */
export function projectLabel(
  project: { job_code?: string | null; name?: string | null } | null | undefined,
): string {
  const code = project?.job_code?.trim();
  const name = project?.name?.trim();
  if (name && code) return `${name} (${code})`;
  return name || code || "this job";
}

/** "1 unit" / "3 units" / "" when the plans don't have any. */
function units(d: Discrepancy): string {
  if (d.units <= 0) return "";
  return `${d.units} ${d.units === 1 ? "unit" : "units"} on the plans`;
}

/**
 * What the issue says. Written for whoever picks it up in the Issues list —
 * possibly days later, possibly on a phone — so it names the job, the mark, and
 * what is actually wrong, and ends with the thing to go and do. Someone should
 * be able to act on it without opening the project. PURE.
 */
export function describeDiscrepancyForIssue(params: {
  /** e.g. "Black Desert (BLACK22)". */
  projectLabel: string;
  discrepancy: Discrepancy;
  /** What the foreman typed when they labelled it, if anything. */
  note?: string | null;
}): string {
  const { discrepancy: d } = params;
  const mark = markLabel(d);
  const count = units(d);
  const where = `${params.projectLabel}: `;

  let body: string;
  switch (d.kind) {
    case "mark_without_spec":
      body =
        `mark ${mark} has no spec sheet in the supplier's set` +
        (count ? ` — ${count}` : "") +
        `. Ask the supplier for the missing sheet.`;
      break;
    case "spec_without_mark":
      body =
        `the spec sheet covers mark ${mark} but no window on the plans uses it` +
        (d.hasSize ? "" : " — and it carries no size") +
        `. Check with the supplier whether it belongs on this job.`;
      break;
    case "spec_without_size":
      body =
        `mark ${mark} has a spec but no size on it` +
        (count ? ` — ${count}` : "") +
        `. Get the dimensions from the supplier before anything is cut.`;
      break;
    case "spec_without_drawing":
      body =
        `mark ${mark} has a written spec but no drawing` +
        (count ? ` — ${count}` : "") +
        `. Ask the supplier for the elevation so the crew can check the shape.`;
      break;
  }

  const trimmed = params.note?.trim();
  return trimmed ? `${where}${body} Note: ${trimmed}` : `${where}${body}`;
}
