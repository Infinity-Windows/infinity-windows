import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { supabase } from "../supabase";
import { filterToLiveProjects } from "../liveProjects";
import { isOwner } from "./types";
import { isMissingColumn, isMissingFunction as isMissingSchemaFunction, isMissingTable } from "../schemaErrors";
import type { Project, WindowType } from "../types";
import type { DraftOpening, ExistingOpeningLite, PlansetKindLike } from "./extract";
import { markBase, planDraftPersistence } from "./extract";
import type { MarkSpecDraft, ProjectMarkSpec } from "./specs";
import { mergeSpecsByMark, parseSpecRow } from "./specs";
import { dropCropsForPlanset } from "./cropCache";
import { validateBbox, type Bbox } from "./markDrawing";
import { buildSequenceAssignments, maxExistingSequence } from "./mapDispatch";
import { extractSpecsDeterministic } from "./specsDeterministic";
import { parseSpecPageStatuses, type SpecPageStatus } from "./specPageStatus";
import { pendingPages, type StoredPageProgress } from "./extractionProgress";
import { formatApiError } from "./errors";
import { visionMarksToDrafts, type RawVisionMark } from "./specsVision";
import type { DiscrepancyKind } from "./specReconciliation";
import { elevationAppearances, type ElevationAppearance } from "./elevationViews";
import { splitCalloutsByFloorPlan } from "./planDetails";
import {
  isPinMoveDenied,
  PIN_MOVE_DENIED,
  type PinMove,
} from "./pinHistory";
import { foremanOnlyRefusal, REMOVED_LIST_DENIED } from "./openingAccess";
import { isDataOff, type DataOffKind } from "./dataOff";
import { specKindColumns, type SpecKindColumns } from "./unitKind";
import type { CustomMarkRegistrationPayload } from "../modelstudio/customMarks";
import type {
  InstallEvent,
  MarkElevationView,
  MemoTopics,
  PlanOutline,
  Planset,
  PlansetFormat,
  PlansetKind,
  PlansetStatus,
  Profile,
  ProjectOpening,
  RemovedOpening,
} from "./types";

// The assignee embed lists profile columns explicitly rather than `*`: profiles
// holds a credential column (pin_hash) that no client role may read, so a `*`
// against that table now fails outright — and should keep failing if another
// secret column is ever added.
export const OPENING_SELECT =
  "*, window_types(*), windows:assigned_window_id(*), projects(*), assignee:assigned_to(id, display_name, skill_level, role, active)";

async function actor(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.email ?? null;
}

// --- Crew profiles ---

// Never select the PIN to the client; it's verified server-side via RPC. Since
// 20260729200000_profiles_rls_lockdown.sql the database enforces this too — the
// authenticated role holds column privileges on exactly this list.
// Explicit on purpose, forever: `profiles` holds pin_hash, which no client role
// may read, so `select("*")` against it fails by design. Add a column here only
// after a migration grants SELECT on it to `authenticated`.
export const PROFILE_COLS =
  "id, display_name, skill_level, role, active, language, can_see_costs, can_see_pay, retired_at, created_at, updated_at";

/**
 * The columns a database might not have yet, newest first, with the name the
 * error will mention.
 *
 * Not a nicety: `profiles` is the FIRST thing every screen reads — the role
 * behind every guard comes from here — so asking for a column a database has
 * not got yet does not empty one screen, it white-screens the whole app for
 * the whole company. The frontend and the backend deploy as separate
 * workflows, and the backend one has silently failed before, so "the app is
 * live and the migration is not" is a state that really happens.
 *
 * Newest first because Postgres names one missing column per error: a database
 * missing both drops `retired_at`, retries, is told about `can_see_costs`, and
 * drops that too.
 */
const OPTIONAL_PROFILE_COLS: readonly { column: string; inList: string }[] = [
  { column: "retired_at", inList: ", retired_at" },
  { column: "can_see_costs", inList: ", can_see_costs, can_see_pay" },
];

/** Narrowed for the life of the tab, the first time the database says it has
 * no such column. One extra round trip on one read, never on every one. */
let profileCols = PROFILE_COLS;

// `data` is `unknown` because a `.select()` given a runtime string (rather than
// a literal) loses PostgREST's row inference — the callers below cast, exactly
// as they already did when they passed the constant straight in.
async function readProfiles(
  run: (cols: string) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<{ data: unknown; error: unknown }> {
  let result = await run(profileCols);
  // One retry per optional column, so a database missing all of them still
  // lands on a list it can answer rather than failing on the second one.
  for (let attempt = 0; attempt < OPTIONAL_PROFILE_COLS.length; attempt++) {
    if (!result.error) return result;
    const dropped = OPTIONAL_PROFILE_COLS.find(
      (c) =>
        profileCols.includes(c.inList) && isMissingColumn(result.error, c.column),
    );
    if (!dropped) return result;
    profileCols = profileCols.replace(dropped.inList, "");
    result = await run(profileCols);
  }
  return result;
}

/** Emails that auto-promote to Owner on first/any sign-in. */
const OWNER_BOOTSTRAP_EMAILS = new Set([
  "ammon@horizonsolarusa.com",
  "isaacammonbarlow@gmail.com",
]);

function isOwnerBootstrapEmail(email: string | undefined): boolean {
  return OWNER_BOOTSTRAP_EMAILS.has((email ?? "").trim().toLowerCase());
}

/** A database that predates the RPC, rather than the RPC refusing the caller. */
export function isMissingFunction(error: unknown): boolean {
  return isMissingSchemaFunction(error);
}

/** Ensure the signed-in user has a profile row; return it. */
export async function ensureMyProfile(): Promise<Profile | null> {
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return null;

  const { data: existing, error } = await readProfiles((cols) =>
    supabase.from("profiles").select(cols).eq("id", user.id).maybeSingle(),
  );
  if (error) throw error;

  const bootstrapOwner = isOwnerBootstrapEmail(user.email);

  let profile = existing as Profile | null;
  if (!profile) {
    const displayName = bootstrapOwner
      ? "Ammon"
      : (user.email ?? "installer").split("@")[0];
    // `role` is deliberately not sent. The authenticated role has no INSERT
    // privilege on profiles.role, so every new account lands on the 'installer'
    // column default and only a supervisor can lift it from there.
    const { data: created, error: insErr } = await readProfiles((cols) =>
      supabase
        .from("profiles")
        .insert({ id: user.id, display_name: displayName })
        .select(cols)
        .single(),
    );
    if (insErr) throw insErr;
    profile = created as Profile;
  }

  // Bootstrap: promote the founder emails to Owner. This happens server-side —
  // claim_owner_bootstrap() re-checks the email against the verified JWT, so the
  // browser is asking for the promotion rather than granting it to itself.
  if (
    bootstrapOwner &&
    (profile.role !== "owner" ||
      profile.display_name !== "Ammon" ||
      !profile.active)
  ) {
    const { error: bootErr } = await supabase.rpc("claim_owner_bootstrap");
    // A database that predates the RPC still signs in, just unpromoted; any
    // other failure is real and should surface.
    if (bootErr && !isMissingFunction(bootErr)) throw bootErr;
    if (!bootErr) {
      const { data: reread, error: rereadErr } = await readProfiles((cols) =>
        supabase.from("profiles").select(cols).eq("id", user.id).maybeSingle(),
      );
      if (rereadErr) throw rereadErr;
      profile = (reread as Profile | null) ?? profile;
    }
  }

  return profile;
}

/** The signed-in user's own profile — NEVER affected by person preview. */
export async function getRealProfile(): Promise<Profile | null> {
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return null;
  const { data, error } = await readProfiles((cols) =>
    supabase.from("profiles").select(cols).eq("id", user.id).maybeSingle(),
  );
  if (error) throw error;
  return data as Profile | null;
}

export async function getMyProfile(): Promise<Profile | null> {
  const me = await getRealProfile();

  // Person preview (owner-only, session-scoped): every "my …" surface keys
  // off this profile, so returning the previewed person makes the whole app
  // read as THEM. Display-side only — server writes still stamp the real
  // auth.uid(), and RLS still governs what this login may read.
  //
  // This DOES read the raw sessionStorage key directly rather than going
  // through useEffectiveRole's clamp (view-as ceiling, 2026-09-01) — checked
  // and left as-is on purpose: `isOwner(me.role)` gates it on the caller's
  // real, server-fetched role, and owner already sits at the top rank, so a
  // previewed person's role can never outrank the viewer here. A non-owner
  // forging this key gets nothing — `me.role` still comes from the server.
  if (me && isOwner(me.role)) {
    try {
      const raw = sessionStorage.getItem("infinity.viewAsPerson");
      const preview = raw ? (JSON.parse(raw) as { id?: string }) : null;
      if (preview?.id && preview.id !== me.id) {
        const { data: other } = await readProfiles((cols) =>
          supabase.from("profiles").select(cols).eq("id", preview.id).maybeSingle(),
        );
        if (other) return other as Profile;
      }
    } catch {
      /* no preview */
    }
  }
  return me;
}

/**
 * Everyone this app may still OFFER — the default, and the one every picker,
 * schedule, push audience and @-mention list should use.
 *
 * Removed logins are left out. A person whose login was removed for good
 * (20260987000000) must not turn up in an assignment picker, on the crew board,
 * or in a push audience — they are gone, and offering them is how somebody ends
 * up assigned to nobody. Excluding them HERE rather than at each picker is
 * deliberate: it makes the safe answer the default, so a picker written next
 * month gets it without anybody remembering.
 *
 * The screens that read back who DID something — the roster, timecards, a
 * unit's Record — want the removed people too, and call
 * listProfilesIncludingRemoved() instead.
 */
export async function listProfiles(): Promise<Profile[]> {
  const everyone = await listProfilesIncludingRemoved();
  return everyone.filter((p) => !p.retired_at);
}

/**
 * Everyone who ever had a login, removed people included.
 *
 * For the screens that put a NAME on finished work: the roster (which shows a
 * removed person greyed out and marked Removed), timecards, a unit's Record.
 * Their name is kept exactly as it was — renaming years of finished work into
 * "Removed" would be a worse lie than the one it fixed.
 */
export async function listProfilesIncludingRemoved(): Promise<Profile[]> {
  const { data, error } = await readProfiles((cols) =>
    supabase
      .from("profiles")
      .select(cols)
      .order("role", { ascending: false })
      .order("display_name"),
  );
  if (error) throw error;
  return (data ?? []) as Profile[];
}

/** PIN status/verify happen server-side; the value never reaches the client. */
export async function myPinStatus(): Promise<boolean> {
  const { data, error } = await supabase.rpc("my_pin_status");
  if (error) return false;
  return Boolean(data);
}

export async function checkMyPin(
  pin: string,
): Promise<{ ok: true } | { ok: false; reason: "wrong" | "network" }> {
  const { data, error } = await supabase.rpc("check_my_pin", { p_pin: pin });
  if (error) return { ok: false, reason: "network" };
  return data ? { ok: true } : { ok: false, reason: "wrong" };
}

export interface AccessRequest {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  requested_role: string;
  note: string | null;
  status: "pending" | "approved" | "denied";
  /** Who decided it. Null while pending, and after a Re-open. */
  decided_by: string | null;
  decided_at: string | null;
  /**
   * Why, in the decider's own words. Optional, and absent (rather than null)
   * on a database that predates 20260987000000.
   */
  decision_note?: string | null;
  created_at: string;
}

export async function submitAccessRequest(payload: {
  name: string;
  email?: string;
  phone?: string;
  requested_role?: string;
  note?: string;
}): Promise<void> {
  const { error } = await supabase.from("access_requests").insert({
    name: payload.name,
    email: payload.email ?? null,
    phone: payload.phone ?? null,
    requested_role: payload.requested_role ?? "installer",
    note: payload.note ?? null,
  });
  if (error) throw error;
}

export async function listAccessRequests(): Promise<AccessRequest[]> {
  const { data, error } = await supabase
    .from("access_requests")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as AccessRequest[];
}

/**
 * Deny a request (with an optional reason) or re-open a denied one.
 *
 * Goes through the RPC, not a PATCH: `decide_access_request` is SECURITY
 * DEFINER, stamps `decided_by` from the verified session rather than from
 * anything the browser sends, and refuses to write 'approved' at all —
 * approving means an account now exists, and only the approve-access-request
 * edge function can make that true. Before 20260987000000 the table's own
 * policy let ANY signed-in user write any of this, which is the hole this
 * closes.
 *
 * Falls back to the plain update on a database that has not had the migration
 * yet, so a phone ahead of the deploy can still clear its queue.
 */
export async function decideAccessRequest(
  id: string,
  status: "denied" | "pending",
  note?: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("decide_access_request", {
    p_id: id,
    p_status: status,
    p_note: note?.trim() || null,
  });
  if (!error) return;
  if (!isMissingFunction(error)) throw error;

  const { error: fallbackErr } = await supabase
    .from("access_requests")
    .update({
      status,
      decided_at: status === "pending" ? null : new Date().toISOString(),
    })
    .eq("id", id);
  if (fallbackErr) throw fallbackErr;
}

/**
 * File a request from somebody who already has a login.
 *
 * Not a client-side write of 'approved' — see decideAccessRequest above. The
 * edge function does it on the service role and writes the note that stops the
 * row reading as though this queue made the account.
 */
export async function markRequestAlreadyLinked(id: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke(
    "approve-access-request",
    { body: { request_id: id, action: "mark_already_linked" } },
  );
  if (error) {
    const context = (error as { context?: Response }).context;
    if (context && typeof context.json === "function") {
      const body = await context.json().catch(() => null);
      if (body?.error) throw new Error(String(body.error));
    }
    throw error;
  }
  if (data?.error) throw new Error(String(data.error));
}

export interface ApprovedAccount {
  user_id: string;
  email: string;
  display_name: string;
  role: string;
  temporary_password: string;
  requested_role: string;
}

/**
 * Approve a request AND create the login, which are the same action as far as
 * anyone using this app is concerned.
 *
 * Marking the row approved was all this used to do, and it left the person with
 * no way in — an owner then had to create the account by hand in the Supabase
 * dashboard. Only the service role may create a user, so the work happens in
 * the `approve-access-request` edge function; it lands them as an installer and
 * hands back a one-time password to pass on.
 */
/**
 * An error from the approve function that the screen can act on rather than
 * only print. Today there is one: the email already has an account, which is
 * the commonest thing that goes wrong in this queue and the one the Admin
 * screen offers a one-tap answer to.
 */
export class ApproveAccessError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = "ApproveAccessError";
    this.code = code;
  }
}

/** True when this request's person already has a login, so nothing was made. */
export function isAlreadyHasLogin(err: unknown): boolean {
  return err instanceof ApproveAccessError && err.code === "already_has_login";
}

export async function approveAccessRequest(
  id: string,
): Promise<ApprovedAccount> {
  const { data, error } = await supabase.functions.invoke(
    "approve-access-request",
    { body: { request_id: id } },
  );
  if (error) {
    // A non-2xx from an edge function arrives as a FunctionsHttpError whose
    // message is just "Edge Function returned a non-2xx status code". The
    // reason the crew needs to read — "that email already has an account" —
    // is in the response body, so dig it out rather than showing the wrapper.
    const context = (error as { context?: Response }).context;
    if (context && typeof context.json === "function") {
      const body = await context.json().catch(() => null);
      if (body?.error) {
        throw new ApproveAccessError(
          String(body.error),
          typeof body.code === "string" ? body.code : null,
        );
      }
    }
    throw error;
  }
  if (data?.error) {
    throw new ApproveAccessError(
      String(data.error),
      typeof data.code === "string" ? data.code : null,
    );
  }
  return data as ApprovedAccount;
}

export async function setMyPin(pin: string): Promise<void> {
  const { error } = await supabase.rpc("set_my_pin", { p_pin: pin });
  if (error) throw error;
}

/**
 * Set the signed-in user's own app language. The RPC is the only writer of
 * profiles.language — the column is revoked from the authenticated role at the
 * grant level (20260968000000_profile_language.sql) — and it scopes the write
 * to auth.uid()'s own row, so this can only ever change your own preference.
 */
export async function setMyLanguage(lang: "en" | "es"): Promise<void> {
  const { error } = await supabase.rpc("set_my_language", { p_lang: lang });
  if (error) throw error;
}

export async function updateProfile(
  id: string,
  patch: Partial<Pick<Profile, "display_name" | "skill_level" | "role" | "active">>,
): Promise<void> {
  // Role changes go through the guarded RPC (lead-only); other fields direct.
  const { role, ...rest } = patch;
  if (role) {
    const { error } = await supabase.rpc("set_profile_role", {
      p_target: id,
      p_role: role,
    });
    if (error) throw error;
  }
  if (Object.keys(rest).length > 0) {
    const { error } = await supabase
      .from("profiles")
      .update({ ...rest, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
  }
}

/**
 * Wave Z: hand somebody (or take back) "Sees costs" / "Sees pay rates".
 * Owner-only, refused in SQL — `profiles.can_see_costs` and `.can_see_pay` are
 * readable but never directly writable, exactly like `role` and `language`, so
 * set_profile_grants is the one door. Pass null for a grant to leave it alone,
 * which is what lets the Roster's two checkboxes flip independently.
 */
export async function setProfileGrants(
  id: string,
  grants: { costs?: boolean | null; pay?: boolean | null },
): Promise<void> {
  const { error } = await supabase.rpc("set_profile_grants", {
    p_profile_id: id,
    p_costs: grants.costs ?? null,
    p_pay: grants.pay ?? null,
  });
  if (error) throw error;
}

async function actorId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

// --- Foreman-push assignment ---

/**
 * Which screen a hand-over came from, for the assignment history row the
 * database writes (wave Y, Y5). The database cannot work this out — it has no
 * idea which button was tapped — so the caller says.
 */
export type AssignVia = "dispatch" | "map" | "auto";

export async function assignOpeningToInstaller(
  openingId: string,
  profileId: string,
  sequence?: number | null,
  via: AssignVia = "dispatch",
): Promise<ProjectOpening> {
  const args = {
    p_opening_id: openingId,
    p_profile_id: profileId,
    p_actor_id: await actorId(),
    p_sequence: sequence ?? null,
  };
  const { data, error } = await supabase.rpc("assign_opening_to_installer", {
    ...args,
    p_via: via,
  });
  if (!error) return data as ProjectOpening;
  // A phone ahead of the migration: the five-argument form does not exist yet.
  // Handing out work matters more than knowing which screen it came from, so
  // fall back to the old call — the history row still lands, reading
  // "dispatch", which is what the trigger assumes when nobody says otherwise.
  if (!isMissingSchemaFunction(error)) throw refusalOrError(error);
  const retry = await supabase.rpc("assign_opening_to_installer", args);
  if (retry.error) throw refusalOrError(retry.error);
  return retry.data as ProjectOpening;
}

/**
 * The one sequenced-dispatch RPC path: append an ordered batch of openings
 * to an installer's route (tap order becomes 1..N after whatever they
 * already have), or clear them when `profileId` is null. Built on
 * mapDispatch's pure sequencing helpers so every tap-to-assign surface —
 * the fit-view map (MapsInteractive) and the 3D model viewer
 * (JobModelViewer) alike — computes the exact same sequence for the same
 * taps instead of maintaining two copies of this math that could drift.
 */
export async function assignOpeningsInOrder(
  openings: readonly Pick<ProjectOpening, "id" | "assigned_to" | "sequence">[],
  orderedIds: readonly string[],
  profileId: string | null,
  via: AssignVia = "map",
): Promise<void> {
  if (!profileId) {
    for (const id of orderedIds) await unassignOpening(id);
    return;
  }
  const startAfter = maxExistingSequence(openings, profileId, orderedIds);
  const plan = buildSequenceAssignments(orderedIds, startAfter);
  for (const { openingId, sequence } of plan) {
    await assignOpeningToInstaller(openingId, profileId, sequence, via);
  }
}

export async function unassignOpening(openingId: string): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("unassign_opening", {
    p_opening_id: openingId,
  });
  // Wave Y put the foreman+ rank inside the RPC, so this can now refuse — and
  // a refusal is a sentence for a person, not a PostgREST code.
  if (error) throw refusalOrError(error);
  return data as ProjectOpening;
}

export async function startOpeningWork(openingId: string): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("start_opening_work", {
    p_opening_id: openingId,
  });
  if (error) throw error;
  return data as ProjectOpening;
}

/**
 * Flag an opening to the lead (empty note and no kind clears the flag).
 *
 * Wave E gave the flag a REASON. The reason rides a THREE-argument overload
 * rather than a defaulted third parameter, because PostgREST picks an overload
 * by the set of argument names it is sent and a defaulted parameter would make
 * every old two-argument call ambiguous. A phone running ahead of the server
 * has no three-argument form to call, so it falls back to the old one: the
 * flag is still raised, and the reason reads as "other" until the migration
 * lands — which is what every pre-wave-E flag reads as anyway.
 */
export async function flagOpening(
  openingId: string,
  note: string | null,
  kind?: DataOffKind | null,
): Promise<ProjectOpening> {
  if (kind) {
    const withKind = await supabase.rpc("flag_opening", {
      p_opening_id: openingId,
      p_note: note,
      p_kind: kind,
    });
    if (!withKind.error) return withKind.data as ProjectOpening;
    if (!isMissingSchemaFunction(withKind.error)) throw withKind.error;
  }
  const { data, error } = await supabase.rpc("flag_opening", {
    p_opening_id: openingId,
    p_note: note,
  });
  if (error) throw error;
  return data as ProjectOpening;
}

/**
 * Take a data-off flag back down. Foreman+ in SQL, because clearing it is a
 * claim that somebody went and checked — see clear_opening_flag. Degrades to
 * the old "flag with an empty note" clear on a database without the RPC.
 */
export async function clearOpeningFlag(openingId: string): Promise<ProjectOpening> {
  const cleared = await supabase.rpc("clear_opening_flag", {
    p_opening_id: openingId,
  });
  if (!cleared.error) return cleared.data as ProjectOpening;
  if (!isMissingSchemaFunction(cleared.error)) throw cleared.error;
  return flagOpening(openingId, null);
}

/**
 * How many units on each of these jobs carry a data-off flag.
 *
 * Job history's line ("3 units data off") reads this: a finished job's honest
 * epitaph is not only how long it took, it is how much of what it recorded was
 * wrong. Degrades to an empty map on a database without the flag column — no
 * flags there is the truth there, not an error screen.
 */
export async function countDataOffByProject(
  projectIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (projectIds.length === 0) return out;
  const { data, error } = await supabase
    .from("project_openings")
    .select("project_id, flag_kind, flag_note")
    .in("project_id", [...projectIds]);
  if (error) {
    if (isMissingColumn(error, "flag_kind") || isMissingTable(error, "project_openings")) {
      return out;
    }
    throw error;
  }
  for (const row of (data ?? []) as {
    project_id: string;
    flag_kind?: string | null;
    flag_note?: string | null;
  }[]) {
    if (!isDataOff(row)) continue;
    out.set(row.project_id, (out.get(row.project_id) ?? 0) + 1);
  }
  return out;
}

// --- A window or door nobody drew (wave E) ---------------------------------

export interface FieldUnitInput {
  projectId: string;
  kind: "window" | "door";
  widthIn: number;
  heightIn: number;
  /** "bucket/path" of a photo already uploaded, or null. */
  photoPath?: string | null;
  /** Where it was tapped on the plan, both 0–1. Null on a job with no map. */
  pinX?: number | null;
  pinY?: number | null;
  /** Which sheet the tap was on — meaningless without a pin. */
  pageNumber?: number | null;
  note?: string | null;
}

/**
 * Add a window or door the paperwork never had. The server checks PRESENCE,
 * not rank: an open shift on that job is the permission, because the person
 * looking at the hole is the person who should be able to record it.
 */
export async function addFieldUnit(input: FieldUnitInput): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("add_field_unit", {
    p_project_id: input.projectId,
    p_kind: input.kind,
    p_width_in: input.widthIn,
    p_height_in: input.heightIn,
    p_photo_path: input.photoPath ?? null,
    p_pin_x: input.pinX ?? null,
    p_pin_y: input.pinY ?? null,
    p_note: input.note ?? null,
    p_page_number: input.pageNumber ?? null,
  });
  if (error) throw error;
  return data as ProjectOpening;
}

/** Keep it, under a name the paperwork now uses. Supervisor+. */
export async function renameFieldUnit(
  openingId: string,
  code: string,
): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("rename_field_unit", {
    p_opening_id: openingId,
    p_code: code,
  });
  if (error) throw error;
  return data as ProjectOpening;
}

/** It turned out to be a mark we already had. Refused once anyone has worked it. */
export async function mergeFieldUnit(
  openingId: string,
  intoCode: string,
): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("merge_field_unit", {
    p_opening_id: openingId,
    p_into_code: intoCode,
  });
  if (error) throw error;
  return data as ProjectOpening;
}

/** Take it back off the job — the ordinary soft delete, restorable. */
export async function removeFieldUnit(
  openingId: string,
  reason?: string | null,
): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("remove_field_unit", {
    p_opening_id: openingId,
    p_reason: reason ?? null,
  });
  if (error) throw error;
  return data as ProjectOpening;
}

export interface JobNote {
  id: string;
  project_id: string;
  author_name: string | null;
  note: string;
  created_at: string;
}

export async function addJobNote(projectId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc("add_job_note", {
    p_project_id: projectId,
    p_note: note,
  });
  if (error) throw error;
}

export async function listJobNotes(projectId: string): Promise<JobNote[]> {
  const { data, error } = await supabase
    .from("job_notes")
    .select("id, project_id, author_name, note, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as JobNote[];
}

/**
 * Build a Tracking job out into a full Data job (standard-tracking-jobs slice
 * 6). One-way: the promote_project_to_data RPC ADDS 'data' to the job's
 * allowed_modes — a tracking-only job becomes data+tracking, a job that already
 * allows data is a no-op — so the previously-hidden data screens (the map, Maps
 * Interactive, Model Studio, framing/flash/unit tracking, dispatch) switch on
 * the instant this returns and the ["projectsAll"] cache is refreshed. The RPC
 * touches nothing but allowed_modes, so every project-scoped record already
 * logged (time, photos, daily logs, cost codes, summons) is carried straight
 * through. Foreman+ is enforced server-side (_is_lead); the returned row carries
 * the new modes so the caller need not re-fetch to know what turned on.
 */
export async function promoteProjectToData(projectId: string): Promise<Project> {
  const { data, error } = await supabase.rpc("promote_project_to_data", {
    p_project_id: projectId,
  });
  if (error) throw new Error(formatApiError(error));
  return data as Project;
}

// --- Opening notes: a free-form record on one opening ---
//
// The point (owner ask, settled 2026-08-21): explain why a window took much
// longer than expected than the estimate. Unlike job_notes, there is no RPC
// - RLS alone gates the write (author must be the caller; see
// 20260923000000_opening_notes.sql), so this reads and writes the table
// directly, the same way project_messages does.

/** True when the table hasn't been migrated yet on this database. */
function isMissingOpeningNotesTable(error: unknown): boolean {
  return isMissingTable(error, "opening_notes");
}

const OPENING_NOTE_SELECT =
  "id, opening_id, author, body, created_at, author_profile:author(id, display_name)";

export interface OpeningNote {
  id: string;
  opening_id: string;
  author: string | null;
  body: string;
  created_at: string;
  /** Joined the way `assignee` is on OPENING_SELECT - never `select("*")` on profiles. */
  author_profile?: Pick<Profile, "id" | "display_name"> | null;
}

/** Every note on this opening, newest first. Best-effort: [] pre-migration. */
export async function listOpeningNotes(openingId: string): Promise<OpeningNote[]> {
  const { data, error } = await supabase
    .from("opening_notes")
    .select(OPENING_NOTE_SELECT)
    .eq("opening_id", openingId)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingOpeningNotesTable(error)) return [];
    throw error;
  }
  return (data ?? []) as unknown as OpeningNote[];
}

/**
 * Post a note as the signed-in user. RLS requires `author = auth.uid()`, so
 * there is no "post as someone else" to guard here - the server refuses it.
 */
export async function addOpeningNote(openingId: string, body: string): Promise<OpeningNote> {
  const { data, error } = await supabase
    .from("opening_notes")
    .insert({ opening_id: openingId, author: await actorId(), body })
    .select(OPENING_NOTE_SELECT)
    .single();
  if (error) throw error;
  return data as unknown as OpeningNote;
}

export async function setOpeningsSequence(openingIds: string[]): Promise<void> {
  const { error } = await supabase.rpc("set_openings_sequence", {
    p_opening_ids: openingIds,
  });
  if (error) throw error;
}

export interface InstallerTypeStat {
  installer_id: string;
  window_type_id: string;
  n: number;
  median_minutes: number | null;
  avg_grade: number | null;
  fail_rate: number | null;
  last_at: string | null;
}

/** Per-installer proven performance per type (drives learned dispatch). */
export async function listInstallerTypeStats(): Promise<InstallerTypeStat[]> {
  const { data, error } = await supabase.from("installer_type_stats").select("*");
  if (error) throw error;
  return (data ?? []) as InstallerTypeStat[];
}

export interface InstallerLeaderRow {
  installer_id: string;
  display_name: string;
  installs: number;
  median_minutes: number | null;
  avg_grade: number | null;
  fail_rate: number | null;
}

/** One person's installs in a window — the timecard's per-day units. */
export interface ProfileInstallEvent {
  id: string;
  installer_id: string;
  credited_to?: string | null;
  minutes: number | null;
  quality_grade: number | null;
  created_at: string;
  opening?: { opening_code: string; project_id: string } | null;
}

/**
 * The units this person INSTALLED in a window — theirs when they filed it and
 * nobody else was credited, plus everything anybody filed under their name
 * (wave Y). A foreman filing three windows for Sam at the end of the day puts
 * three units on Sam's card and none on his own, which is what happened.
 *
 * Degrades to the old installer_id-only read on a database without the column,
 * so a phone ahead of the migration shows a timecard rather than an error.
 */
export async function listInstallEventsForProfile(
  profileId: string,
  startIso: string,
  endIso: string,
): Promise<ProfileInstallEvent[]> {
  // Two literal selects rather than one built string: the client types the
  // response off the select TEXT, and a computed one comes back as a parser
  // error instead of a row.
  const first = await supabase
    .from("install_events")
    .select(
      "id, installer_id, credited_to, minutes, quality_grade, created_at, opening:project_opening_id(opening_code, project_id)",
    )
    .is("voided_at", null)
    .gte("created_at", startIso)
    .lt("created_at", endIso)
    .or(`credited_to.eq.${profileId},and(credited_to.is.null,installer_id.eq.${profileId})`)
    .order("created_at", { ascending: true });
  if (!first.error) return (first.data ?? []) as unknown as ProfileInstallEvent[];
  if (!isMissingColumn(first.error, "credited_to")) throw first.error;
  const fallback = await supabase
    .from("install_events")
    .select(
      "id, installer_id, minutes, quality_grade, created_at, opening:project_opening_id(opening_code, project_id)",
    )
    .eq("installer_id", profileId)
    .is("voided_at", null)
    .gte("created_at", startIso)
    .lt("created_at", endIso)
    .order("created_at", { ascending: true });
  if (fallback.error) throw fallback.error;
  return (fallback.data ?? []) as unknown as ProfileInstallEvent[];
}

/**
 * Company analytics: per-installer install counts, speed, quality.
 *
 * The person is who INSTALLED the unit — coalesce(credited_to, installer_id),
 * wave Y — not who typed it in, so a lead filing the last three of the day
 * does not quietly climb his own leaderboard.
 */
export async function getInstallerLeaderboard(): Promise<InstallerLeaderRow[]> {
  const [profilesRes, firstEvents] = await Promise.all([
    supabase.from("profiles").select("id, display_name"),
    supabase
      .from("install_events")
      .select("installer_id, credited_to, minutes, quality_grade")
      .not("installer_id", "is", null),
  ]);
  const eventsRes: { data: unknown; error: unknown } = isMissingColumn(
    firstEvents.error,
    "credited_to",
  )
    ? await supabase
        .from("install_events")
        .select("installer_id, minutes, quality_grade")
        .not("installer_id", "is", null)
    : firstEvents;
  if (profilesRes.error) throw profilesRes.error;
  if (eventsRes.error) throw eventsRes.error;

  const nameById = new Map(
    (profilesRes.data ?? []).map((p) => [p.id, p.display_name]),
  );
  const byInstaller = new Map<
    string,
    { minutes: number[]; grades: number[] }
  >();
  for (const e of ((eventsRes.data ?? []) as unknown) as {
    installer_id: string | null;
    credited_to?: string | null;
    minutes: number | null;
    quality_grade: number | null;
  }[]) {
    const who = e.credited_to ?? e.installer_id;
    if (!who) continue;
    const b = byInstaller.get(who) ?? { minutes: [], grades: [] };
    if (e.minutes != null) b.minutes.push(e.minutes);
    if (e.quality_grade != null) b.grades.push(e.quality_grade);
    byInstaller.set(who, b);
  }

  const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const rows: InstallerLeaderRow[] = [];
  for (const [id, b] of byInstaller) {
    const installs = Math.max(b.minutes.length, b.grades.length);
    const fails = b.grades.filter((g) => g <= 2).length;
    rows.push({
      installer_id: id,
      display_name: nameById.get(id) ?? "unknown",
      installs,
      median_minutes: median(b.minutes),
      avg_grade:
        b.grades.length === 0
          ? null
          : Math.round((b.grades.reduce((s, g) => s + g, 0) / b.grades.length) * 10) / 10,
      fail_rate:
        b.grades.length === 0 ? null : Math.round((fails / b.grades.length) * 1000) / 10,
    });
  }
  return rows.sort((a, b) => b.installs - a.installs);
}

export interface JobVarianceRow {
  id: string;
  job_code: string;
  name: string;
  estimated_minutes: number | null;
  actual_minutes: number;
  installed: number;
  openings: number;
}

/** Estimate-vs-actual per job (bid accuracy). */
export async function getJobVariance(): Promise<JobVarianceRow[]> {
  const { data: projects, error: pErr } = await supabase
    .from("projects")
    .select("id, job_code, name, estimated_minutes");
  if (pErr) throw pErr;

  const { data: openings, error: oErr } = await supabase
    .from("project_openings")
    .select("project_id, status");
  if (oErr) throw oErr;

  const { data: events, error: eErr } = await supabase
    .from("install_events")
    .select("minutes, project_opening_id");
  if (eErr) throw eErr;

  // Map opening -> project to attribute actual minutes.
  const openingProject = new Map<string, string>();
  const openingCounts = new Map<string, { installed: number; total: number }>();
  for (const o of openings ?? []) {
    const c = openingCounts.get(o.project_id) ?? { installed: 0, total: 0 };
    c.total += 1;
    if (o.status === "installed") c.installed += 1;
    openingCounts.set(o.project_id, c);
  }

  const { data: openingRows } = await supabase
    .from("project_openings")
    .select("id, project_id");
  for (const o of openingRows ?? []) openingProject.set(o.id, o.project_id);

  const actualByProject = new Map<string, number>();
  for (const e of events ?? []) {
    const pid = openingProject.get(e.project_opening_id);
    if (pid && e.minutes != null) {
      actualByProject.set(pid, (actualByProject.get(pid) ?? 0) + e.minutes);
    }
  }

  return (projects ?? []).map((p) => {
    const c = openingCounts.get(p.id) ?? { installed: 0, total: 0 };
    return {
      id: p.id,
      job_code: p.job_code,
      name: p.name,
      estimated_minutes: p.estimated_minutes ?? null,
      actual_minutes: actualByProject.get(p.id) ?? 0,
      installed: c.installed,
      openings: c.total,
    };
  });
}

/** Shape installer stats into the dispatch engine's perf lookup. */
export function buildPerfIndex(
  stats: InstallerTypeStat[],
): Record<string, Record<string, InstallerTypeStat>> {
  const idx: Record<string, Record<string, InstallerTypeStat>> = {};
  for (const s of stats) {
    (idx[s.installer_id] ??= {})[s.window_type_id] = s;
  }
  return idx;
}

export async function saveJobEstimate(
  projectId: string,
  minutes: number,
  crew: number,
): Promise<void> {
  const { error } = await supabase
    .from("projects")
    .update({
      estimated_minutes: minutes,
      estimated_crew: crew,
      estimated_at: new Date().toISOString(),
    })
    .eq("id", projectId);
  if (error) throw error;
}

export interface Clearance {
  installer_id: string;
  window_type_id: string;
  cleared_at: string;
}

export async function listClearances(): Promise<Clearance[]> {
  const { data, error } = await supabase
    .from("installer_clearance")
    .select("installer_id, window_type_id, cleared_at");
  if (error) throw error;
  return (data ?? []) as Clearance[];
}

export interface CapabilityBadge {
  installer_id: string;
  capability: string;
  granted_at: string;
}

export async function listCapabilityBadges(): Promise<CapabilityBadge[]> {
  const { data, error } = await supabase
    .from("capability_badges")
    .select("installer_id, capability, granted_at");
  if (error) throw error;
  return (data ?? []) as CapabilityBadge[];
}

export async function setCapabilityBadge(
  installerId: string,
  capability: string,
  granted: boolean,
): Promise<void> {
  const { error } = await supabase.rpc("set_capability_badge", {
    p_installer_id: installerId,
    p_capability: capability,
    p_granted: granted,
  });
  if (error) throw refusalOrError(error);
}

export async function setClearance(
  installerId: string,
  windowTypeId: string,
  cleared: boolean,
): Promise<void> {
  const { error } = await supabase.rpc("set_clearance", {
    p_installer_id: installerId,
    p_window_type_id: windowTypeId,
    p_cleared: cleared,
  });
  if (error) throw error;
}

/** Openings assigned to a given installer (their work list). */
export async function listMyOpenings(
  projectId: string,
  profileId: string,
): Promise<ProjectOpening[]> {
  const { data, error } = await supabase
    .from("project_openings")
    .select(OPENING_SELECT)
    .eq("project_id", projectId)
    .eq("assigned_to", profileId)
    .order("sequence", { ascending: true, nullsFirst: false })
    .order("opening_code");
  if (error) throw error;
  // Wave D: a trashed job's own row is hidden by RLS, but this table isn't
  // — its openings keep reading live for the whole 30-day trash window
  // otherwise (see liveProjects.ts).
  return filterToLiveProjects(data as ProjectOpening[]);
}

/** Every opening this installer is assigned across all active jobs. */
export async function listMyOpeningsAllJobs(
  profileId: string,
): Promise<ProjectOpening[]> {
  const { data, error } = await supabase
    .from("project_openings")
    .select(OPENING_SELECT)
    .eq("assigned_to", profileId)
    .order("sequence", { ascending: true, nullsFirst: false })
    .order("opening_code");
  if (error) throw error;
  return filterToLiveProjects(data as ProjectOpening[]);
}

/** Count of this installer's assigned, not-yet-installed openings (nav badge). */
export async function countMyOpenOpenings(profileId: string): Promise<number> {
  const { count, error } = await supabase
    .from("project_openings")
    .select("id", { count: "exact", head: true })
    .eq("assigned_to", profileId)
    .neq("status", "installed");
  if (error) return 0;
  return count ?? 0;
}

// --- Plansets ---

export function plansetFormatFromName(name: string): PlansetFormat | null {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "pdf" || ext === "dwg" || ext === "dxf") return ext;
  return null;
}

export async function listPlansets(projectId: string): Promise<Planset[]> {
  const { data, error } = await supabase
    .from("project_plansets")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function uploadPlanset(
  projectId: string,
  file: File,
  kind: PlansetKind = "building",
): Promise<Planset> {
  const format = plansetFormatFromName(file.name);
  if (!format) throw new Error("Only PDF, DWG, or DXF plansets are supported.");

  const safeName = file.name.replace(/[^\w.-]+/g, "_");
  const path = `${projectId}/${Date.now()}-${safeName}`;
  const { error: upErr } = await supabase.storage
    .from("plansets")
    .upload(path, file, { contentType: file.type || undefined });
  if (upErr) throw upErr;

  // DWG/DXF can't convert client-side; store raw and mark conversion pending.
  const status: PlansetStatus = format === "pdf" ? "uploaded" : "converting";
  const { data, error } = await supabase
    .from("project_plansets")
    .insert({
      project_id: projectId,
      storage_path: path,
      source_format: format,
      status,
      kind,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updatePlanset(
  id: string,
  patch: Partial<Pick<Planset, "status" | "page_count" | "converted_pdf_path">>,
): Promise<void> {
  const { error } = await supabase
    .from("project_plansets")
    .update(patch)
    .eq("id", id);
  if (error) throw error;
}

export async function downloadPlanset(planset: Planset): Promise<ArrayBuffer> {
  const path = planset.converted_pdf_path ?? planset.storage_path;
  const { data, error } = await supabase.storage.from("plansets").download(path);
  if (error) throw error;
  return data.arrayBuffer();
}

// --- Manual plan outlines ---

const LOCAL_OUTLINES_KEY = "infinity.planOutlines.v1";

function isMissingOutlineTable(error: unknown): boolean {
  return isMissingTable(error, "project_plan_outlines");
}

function isMissingFeaturesColumn(error: unknown): boolean {
  return isMissingColumn(error, "features");
}

function readLocalOutlines(): PlanOutline[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(LOCAL_OUTLINES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => {
        try {
          return parseOutlineRow(row as Parameters<typeof parseOutlineRow>[0]);
        } catch {
          return null;
        }
      })
      .filter((row): row is PlanOutline => !!row);
  } catch {
    return [];
  }
}

function writeLocalOutlines(rows: PlanOutline[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LOCAL_OUTLINES_KEY, JSON.stringify(rows));
}

function listLocalOutlines(
  projectId: string,
  plansetId?: string,
): PlanOutline[] {
  return readLocalOutlines()
    .filter(
      (row) =>
        row.project_id === projectId &&
        (!plansetId || row.planset_id === plansetId),
    )
    .sort(
      (a, b) =>
        a.page_number - b.page_number ||
        a.created_at.localeCompare(b.created_at),
    );
}

function saveLocalOutline(args: {
  outlineId?: string;
  projectId: string;
  plansetId: string;
  pageNumber: number;
  points: { x: number; y: number }[];
  pageAspect: number;
  features?: unknown;
}): PlanOutline {
  const now = new Date().toISOString();
  const rows = readLocalOutlines();
  if (args.outlineId) {
    const idx = rows.findIndex((row) => row.id === args.outlineId);
    if (idx >= 0) {
      const next: PlanOutline = {
        ...rows[idx],
        project_id: args.projectId,
        planset_id: args.plansetId,
        page_number: args.pageNumber,
        points: args.points,
        page_aspect: args.pageAspect,
        features: args.features ?? rows[idx].features ?? {},
        updated_at: now,
      };
      rows[idx] = next;
      writeLocalOutlines(rows);
      return next;
    }
  }
  const created: PlanOutline = {
    id: args.outlineId ?? crypto.randomUUID(),
    project_id: args.projectId,
    planset_id: args.plansetId,
    page_number: args.pageNumber,
    points: args.points,
    page_aspect: args.pageAspect,
    features: args.features ?? {},
    created_at: now,
    updated_at: now,
  };
  writeLocalOutlines([...rows, created]);
  return created;
}

function deleteLocalOutline(
  plansetId: string,
  pageNumber: number,
  outlineId?: string,
): void {
  writeLocalOutlines(
    readLocalOutlines().filter((row) => {
      if (row.planset_id !== plansetId || row.page_number !== pageNumber) {
        return true;
      }
      if (outlineId) return row.id !== outlineId;
      return false;
    }),
  );
}

function parseOutlineRow(row: {
  id: string;
  project_id: string;
  planset_id: string;
  page_number: number;
  points: unknown;
  page_aspect: number | string;
  features?: unknown;
  created_at: string;
  updated_at: string;
}): PlanOutline {
  const raw = Array.isArray(row.points) ? row.points : [];
  const points = raw
    .map((p) => {
      if (!p || typeof p !== "object") return null;
      const x = Number((p as { x?: unknown }).x);
      const y = Number((p as { y?: unknown }).y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return {
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
      };
    })
    .filter((p): p is { x: number; y: number } => !!p);
  return {
    id: row.id,
    project_id: row.project_id,
    planset_id: row.planset_id,
    page_number: row.page_number,
    points,
    page_aspect: Number(row.page_aspect) || 0.7,
    features: row.features ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listPlanOutlines(
  projectId: string,
  plansetId?: string,
): Promise<PlanOutline[]> {
  let q = supabase
    .from("project_plan_outlines")
    .select("*")
    .eq("project_id", projectId)
    .order("page_number")
    .order("created_at");
  if (plansetId) q = q.eq("planset_id", plansetId);
  const { data, error } = await q;
  if (error) {
    if (isMissingOutlineTable(error)) {
      return listLocalOutlines(projectId, plansetId);
    }
    throw error;
  }
  const remote = (data ?? []).map(parseOutlineRow);
  // Keep any browser-local drafts until the DB table is available everywhere.
  const local = listLocalOutlines(projectId, plansetId);
  if (local.length === 0) return remote;
  const byId = new Map(remote.map((row) => [row.id, row]));
  for (const row of local) byId.set(row.id, row);
  return [...byId.values()].sort(
    (a, b) =>
      a.page_number - b.page_number ||
      a.created_at.localeCompare(b.created_at),
  );
}

export async function savePlanOutline(args: {
  outlineId?: string;
  projectId: string;
  plansetId: string;
  pageNumber: number;
  points: { x: number; y: number }[];
  pageAspect: number;
  features?: unknown;
}): Promise<PlanOutline> {
  const values: Record<string, unknown> = {
    project_id: args.projectId,
    planset_id: args.plansetId,
    page_number: args.pageNumber,
    points: args.points,
    page_aspect: args.pageAspect,
    updated_at: new Date().toISOString(),
  };
  if (args.features !== undefined) values.features = args.features;
  const run = async (vals: Record<string, unknown>) => {
    const query = args.outlineId
      ? supabase
          .from("project_plan_outlines")
          .update(vals)
          .eq("id", args.outlineId)
      : supabase.from("project_plan_outlines").insert(vals);
    return query.select("*").single();
  };
  let { data, error } = await run(values);
  if (error && "features" in values && isMissingFeaturesColumn(error)) {
    // DB has the table but not the newer features column yet.
    const { features: _skipped, ...withoutFeatures } = values;
    ({ data, error } = await run(withoutFeatures));
  }
  if (error) {
    if (isMissingOutlineTable(error)) {
      return saveLocalOutline(args);
    }
    throw error;
  }
  const saved = parseOutlineRow(data);
  // Drop the local copy once the row is on the server.
  deleteLocalOutline(args.plansetId, args.pageNumber, saved.id);
  return saved;
}

/**
 * Drop a browser-local outline draft without going near the database. Used
 * when a draft GRADUATES: the tracer submits it as a real row, and the local
 * copy must stop shadowing the saved one.
 */
export function discardLocalOutline(
  plansetId: string,
  pageNumber: number,
  outlineId?: string,
): void {
  deleteLocalOutline(plansetId, pageNumber, outlineId);
}

export async function deletePlanOutline(
  plansetId: string,
  pageNumber: number,
  outlineId?: string,
): Promise<void> {
  let query = supabase
    .from("project_plan_outlines")
    .delete()
    .eq("planset_id", plansetId)
    .eq("page_number", pageNumber);
  if (outlineId) query = query.eq("id", outlineId);
  const { error } = await query;
  if (error) {
    if (isMissingOutlineTable(error)) {
      deleteLocalOutline(plansetId, pageNumber, outlineId);
      return;
    }
    throw error;
  }
  deleteLocalOutline(plansetId, pageNumber, outlineId);
}

/** True when we can render this planset as a PDF in the app. */
export function plansetIsViewable(planset: Planset): boolean {
  return Boolean(
    planset.converted_pdf_path || planset.source_format === "pdf",
  );
}

/**
 * The project's SPECS plansets — the manufacturer sheets carrying both the
 * per-mark spec table and each mark's elevation drawing. Newest first, because
 * `listPlansets` is.
 *
 * Plural on purpose. A job routinely holds more than one of these at a time:
 * the supplier's original cut sheet, plus an ADDENDUM sheet for units added
 * later. Every one of them is current, and each one is the source of truth for
 * the marks that were read off it. PURE.
 */
export function findSpecsPlansets(plansets: Planset[]): Planset[] {
  return (plansets ?? []).filter(
    (p) => p.kind === "specs" && plansetIsViewable(p),
  );
}

/**
 * Ids of {@link findSpecsPlansets} — the set a drawing's provenance is checked
 * against by `isDrawingStale`. PURE.
 */
export function specsPlansetIds(plansets: Planset[]): string[] {
  return findSpecsPlansets(plansets).map((p) => p.id);
}

/**
 * The specs planset ONE spec's drawing coordinates belong to.
 *
 * Every renderer, prefetch and cache key resolves the file PER SPEC through
 * here rather than asking for "the" specs planset, so an added unit drawn on
 * the addendum and a mark drawn on the original both show their own picture
 * off their own file (Mad Moose, 2026-09-01).
 *
 * A spec that names a planset gets that planset or NOTHING — falling back to
 * another file would crop the same page number out of a different sheet, which
 * is the one failure worth refusing (see `isDrawingStale`).
 *
 * A spec with no recorded planset is legacy — every row written before the
 * provenance column existed, including the live Smith / PV Townhomes drawings.
 * On a job with ONE specs sheet there is only one file it could mean, so it
 * renders exactly as it always has. On a job with two, guessing the newest is a
 * guess: page 3 of a one-page addendum shows nothing, and page 3 of a longer
 * addendum shows a confident picture of the wrong window. Once addenda are
 * normal that guess stops being rare, so we show text only instead. PURE.
 */
export function findSpecsPlansetFor(
  plansets: Planset[],
  spec: { planset_id?: string | null },
): Planset | null {
  const specsPlansets = findSpecsPlansets(plansets);
  const source = spec?.planset_id;
  if (!source) return specsPlansets.length === 1 ? specsPlansets[0] : null;
  return specsPlansets.find((p) => p.id === source) ?? null;
}

/**
 * The project's current BUILDING planset — the architect's sheets: the floor
 * drawings the map is built from and the exterior elevations the reference
 * pictures are cropped from. `kind` defaults to building on legacy rows, and
 * `listPlansets` returns newest first.
 */
export function findBuildingPlanset(plansets: Planset[]): Planset | null {
  return (
    plansets.find(
      (p) => (p.kind ?? "building") === "building" && plansetIsViewable(p),
    ) ?? null
  );
}

/** Signed URL for opening/downloading the stored file (1 hour). */
export async function getPlansetSignedUrl(
  planset: Planset,
): Promise<string> {
  const path = planset.converted_pdf_path ?? planset.storage_path;
  const { data, error } = await supabase.storage
    .from("plansets")
    .createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}

// --- Openings ---

export async function listOpenings(
  projectId: string,
): Promise<ProjectOpening[]> {
  const { data, error } = await supabase
    .from("project_openings")
    .select(OPENING_SELECT)
    .eq("project_id", projectId)
    .order("opening_code");
  if (error) throw error;
  // Wave D: the dispatch board / install lists read this directly by
  // project_id, which isn't covered by the projects RLS hide — see
  // liveProjects.ts.
  return filterToLiveProjects(data as ProjectOpening[]);
}

export async function getOpening(id: string): Promise<ProjectOpening | null> {
  const { data, error } = await supabase
    .from("project_openings")
    .select(OPENING_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Every table that points at `project_openings`, with the column that does it.
 *
 * `install_events` and `qc_checks` are ON DELETE CASCADE — deleting the opening
 * destroys them. The other three are ON DELETE SET NULL, which orphans the row
 * (an installer's open flag loses the window it was about). Neither outcome is
 * acceptable during a routine re-extract, so any opening named here is kept.
 */
const OPENING_REFERENCE_TABLES: { table: string; column: string }[] = [
  { table: "install_events", column: "project_opening_id" },
  { table: "qc_checks", column: "project_opening_id" },
  { table: "issues", column: "opening_id" },
  { table: "task_sessions", column: "opening_id" },
  { table: "service_cases", column: "opening_id" },
];

/** Postgres/PostgREST codes for "that table or column isn't in this schema". */
const MISSING_RELATION_CODES = new Set(["42P01", "42703", "PGRST205", "PGRST204"]);

/**
 * Which of these openings are referenced by install events, QC checks, issues,
 * task sessions or service cases?
 *
 * A table that doesn't exist in this database is skipped; any other error is
 * thrown, because guessing "nothing references it" would licence a delete.
 */
export async function openingsReferencedElsewhere(
  openingIds: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (openingIds.length === 0) return found;

  const chunks: string[][] = [];
  for (let i = 0; i < openingIds.length; i += 200) {
    chunks.push(openingIds.slice(i, i + 200));
  }

  for (const { table, column } of OPENING_REFERENCE_TABLES) {
    for (const chunk of chunks) {
      const { data, error } = await supabase
        .from(table)
        .select(column)
        .in(column, chunk);
      if (error) {
        if (MISSING_RELATION_CODES.has(error.code ?? "")) break;
        throw error;
      }
      for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
        const id = row[column];
        if (typeof id === "string") found.add(id);
      }
    }
  }

  return found;
}

/**
 * Everything `planDraftPersistence` needs to decide what a re-extract may
 * delete. Named explicitly, never `*`, so adding a column to `project_openings`
 * cannot quietly change what a re-extract considers field work.
 */
export const EXISTING_OPENING_COLS =
  "id, opening_code, confirmed, status, pin_x, pin_y, page_number, planset_id, assigned_to, work_started_at, ro_width_in, ro_height_in, ro_quick_ok, condition, field_added";

/**
 * The same list as the database knew it before 20260977000000 added
 * `field_added` — the first fallback for a phone running ahead of the server.
 */
export const EXISTING_OPENING_COLS_NO_FIELD_ADDED =
  "id, opening_code, confirmed, status, pin_x, pin_y, page_number, planset_id, assigned_to, work_started_at, ro_width_in, ro_height_in, ro_quick_ok, condition";

/**
 * The same list as the database knew it before 20260966000000 added
 * `ro_quick_ok` — the fallback for a phone running further ahead still.
 */
export const EXISTING_OPENING_COLS_NO_QUICK_OK =
  "id, opening_code, confirmed, status, pin_x, pin_y, page_number, planset_id, assigned_to, work_started_at, ro_width_in, ro_height_in, condition";

/** What either of those two selects hands back. `ro_quick_ok` is optional so
 *  the same variable holds both — a row read without it is a row nobody
 *  quick-checked. */
interface ExistingOpeningRow {
  id: string;
  opening_code: string;
  confirmed: boolean | null;
  status: string | null;
  pin_x: number | string | null;
  pin_y: number | string | null;
  page_number: number | null;
  planset_id: string | null;
  assigned_to: string | null;
  work_started_at: string | null;
  ro_width_in: number | string | null;
  ro_height_in: number | string | null;
  ro_quick_ok?: boolean | null;
  condition: string | null;
  /** Wave E. Optional for the same reason ro_quick_ok is: a database that has
   *  never heard of it has no field-added rows to protect. */
  field_added?: boolean | null;
}

/**
 * Save a fresh extract as unconfirmed drafts. Guardrail (same philosophy as
 * the Horizon BOM rule): confirmed openings are never deleted or overwritten
 * by a re-extract.
 *
 * Crucially, replacement is scoped by planset KIND — uploading the specs sheet
 * no longer wipes the marked building plan's openings (that bug collapsed
 * Smith Residence from ~105 openings down to 6). The building plan is the
 * authoritative source of openings; specs enriches types. Manually placed pins
 * are preserved across a same-kind re-extract. See `planDraftPersistence`.
 */
export async function saveDraftOpenings(
  projectId: string,
  plansetId: string,
  drafts: DraftOpening[],
  opts?: { specsAuthoritative?: boolean },
): Promise<{ inserted: number; skipped: number; unmatchedPlanMarks: string[] }> {
  if (drafts.length === 0)
    return { inserted: 0, skipped: 0, unmatchedPlanMarks: [] };

  const [{ data: plansets, error: psErr }, first] = await Promise.all([
    supabase
      .from("project_plansets")
      .select("id, kind")
      .eq("project_id", projectId),
    supabase
      .from("project_openings")
      .select(EXISTING_OPENING_COLS)
      .eq("project_id", projectId),
  ]);
  if (psErr) throw psErr;

  // The app bundle can reach a phone before the migration reaches the server,
  // and deploying the backend has silently failed on this project before. Every
  // other read of an opening asks for `*` (OPENING_SELECT) and so rides that
  // out; this explicit list is the one that would name a column the database
  // has not got yet, and the whole draft save is thrown away with it — a
  // foreman taps "Load marks from plans" and no openings are saved at all.
  // Read the row without the quick check instead: on a server that has never
  // heard of the column, "nobody quick-checked anything" is exactly the truth.
  //
  // Two rungs now, newest column first, because the two migrations that added
  // them can land separately: a server with ro_quick_ok but no field_added
  // must not lose the quick check on the way down.
  let existing: ExistingOpeningRow[] | null = first.data;
  if (first.error) {
    // Either name is a reason to peel back — PostgREST names whichever unknown
    // column it hit first, and on a database missing both that is not
    // necessarily the newest one.
    const peelable =
      isMissingColumn(first.error, "field_added") ||
      isMissingColumn(first.error, "ro_quick_ok");
    if (!peelable) throw first.error;
    const noFieldAdded = await supabase
      .from("project_openings")
      .select(EXISTING_OPENING_COLS_NO_FIELD_ADDED)
      .eq("project_id", projectId);
    if (!noFieldAdded.error) {
      existing = noFieldAdded.data;
    } else {
      if (!isMissingColumn(noFieldAdded.error, "ro_quick_ok")) throw noFieldAdded.error;
      const retry = await supabase
        .from("project_openings")
        .select(EXISTING_OPENING_COLS_NO_QUICK_OK)
        .eq("project_id", projectId);
      if (retry.error) throw retry.error;
      existing = retry.data;
    }
  }

  const referenced = await openingsReferencedElsewhere(
    (existing ?? []).map((o) => o.id as string),
  );

  const normalizeKind = (kind: unknown): PlansetKindLike =>
    kind === "specs" ? "specs" : "building";
  const kindById = new Map(
    (plansets ?? []).map((p) => [p.id, normalizeKind(p.kind)]),
  );
  const incomingKind = kindById.get(plansetId) ?? "building";

  const existingLite: ExistingOpeningLite[] = (existing ?? []).map((o) => ({
    id: o.id,
    opening_code: o.opening_code,
    confirmed: Boolean(o.confirmed),
    status: String(o.status ?? "planned"),
    pin_x: o.pin_x == null ? null : Number(o.pin_x),
    pin_y: o.pin_y == null ? null : Number(o.pin_y),
    page_number: o.page_number ?? 1,
    planset_kind: o.planset_id
      ? (kindById.get(o.planset_id) ?? "building")
      : "building",
    planset_id: o.planset_id ?? null,
    assigned_to: o.assigned_to ?? null,
    work_started_at: o.work_started_at ?? null,
    ro_width_in: o.ro_width_in == null ? null : Number(o.ro_width_in),
    ro_height_in: o.ro_height_in == null ? null : Number(o.ro_height_in),
    ro_quick_ok: Boolean(o.ro_quick_ok),
    condition: o.condition ?? null,
    field_added: Boolean(o.field_added),
    referenced: referenced.has(o.id),
  }));

  const plan = planDraftPersistence(
    existingLite,
    drafts,
    incomingKind,
    opts?.specsAuthoritative ?? false,
  );

  if (plan.deleteIds.length > 0) {
    const { error: delErr } = await supabase
      .from("project_openings")
      .delete()
      .in("id", plan.deleteIds);
    if (delErr) throw refusalOrError(delErr);
  }

  if (plan.inserts.length === 0)
    return {
      inserted: 0,
      skipped: plan.skipped,
      unmatchedPlanMarks: plan.unmatchedPlanMarks,
    };

  const { error } = await supabase.from("project_openings").insert(
    plan.inserts.map((d) => ({
      project_id: projectId,
      planset_id: plansetId,
      opening_code: d.opening_code,
      window_type_id: d.window_type_id,
      label: d.label,
      page_number: d.page_number,
      pin_x: d.pin_x ?? null,
      pin_y: d.pin_y ?? null,
      origin_pin_x: d.origin_pin_x ?? d.pin_x ?? null,
      origin_pin_y: d.origin_pin_y ?? d.pin_y ?? null,
      origin_page_number: d.page_number,
      confirmed: false,
    })),
  );
  if (error) throw refusalOrError(error);
  return {
    inserted: plan.inserts.length,
    skipped: plan.skipped,
    unmatchedPlanMarks: plan.unmatchedPlanMarks,
  };
}

/**
 * A foreman-only refusal as a bare Error so its sentence reaches the crew on
 * its own, without PostgREST's trailing `[42501]`. Anything else is rethrown
 * untouched for `formatApiError` to deal with as it always has.
 */
function refusalOrError(error: unknown): unknown {
  const refusal = foremanOnlyRefusal(error);
  return refusal ? new Error(refusal) : error;
}

/**
 * Upsert catalog types from a specs extract so mark #14 becomes a real
 * window_types row (type_code = 14) with size/color/category when known.
 * Then patch drafts that still lack a window_type_id.
 */
export async function ensureTypesFromSpecs(
  drafts: DraftOpening[],
): Promise<DraftOpening[]> {
  if (drafts.length === 0) return drafts;

  const byMark = new Map<string, DraftOpening>();
  for (const d of drafts) {
    if (!byMark.has(d.mark_code)) byMark.set(d.mark_code, d);
  }

  const { data: existing, error: listErr } = await supabase
    .from("window_types")
    .select("id, type_code, name, category, width_in, height_in, notes");
  if (listErr) throw listErr;

  const byCode = new Map(
    (existing ?? []).map((t) => [t.type_code.toUpperCase(), t]),
  );
  const markToTypeId = new Map<string, string>();

  for (const [mark, sample] of byMark) {
    const code = mark.toUpperCase();
    let row = byCode.get(code);
    const category =
      sample.kind === "door" ? "door" : sample.kind === "window" ? "window" : null;
    const notesParts = [
      sample.color ? `Color: ${sample.color}` : null,
      sample.type_text && sample.type_text !== code
        ? `Spec: ${sample.type_text}`
        : null,
    ].filter(Boolean);
    const notes = notesParts.length ? notesParts.join(" · ") : null;
    const name =
      sample.type_text && sample.type_text !== code
        ? `${sample.type_text} (#${mark})`
        : `Mark #${mark}`;

    if (!row) {
      const { data: created, error: insErr } = await supabase
        .from("window_types")
        .insert({
          type_code: code,
          name,
          category,
          width_in: sample.width_in,
          height_in: sample.height_in,
          notes,
          // Not part of the closed ~100 catalog. Flag it so it never
          // silently masquerades as a real catalog product in the brain.
          provisional: true,
        })
        .select("id, type_code")
        .single();
      if (insErr) throw insErr;
      row = {
        id: created.id,
        type_code: created.type_code,
        name,
        category,
        width_in: sample.width_in,
        height_in: sample.height_in,
        notes,
      };
      byCode.set(code, row);
    } else {
      // Fill gaps only — never overwrite a catalog product's known dims.
      const patch: Record<string, unknown> = {};
      if (row.width_in == null && sample.width_in != null) {
        patch.width_in = sample.width_in;
      }
      if (row.height_in == null && sample.height_in != null) {
        patch.height_in = sample.height_in;
      }
      if (!row.category && category) patch.category = category;
      if (notes && !(row as { notes?: string | null }).notes) patch.notes = notes;
      if (Object.keys(patch).length > 0) {
        const { error: upErr } = await supabase
          .from("window_types")
          .update(patch)
          .eq("id", row.id);
        if (upErr) throw upErr;
      }
    }
    markToTypeId.set(mark, row.id);
  }

  return drafts.map((d) => ({
    ...d,
    window_type_id: d.window_type_id ?? markToTypeId.get(d.mark_code) ?? null,
  }));
}

/**
 * Link a specs extract onto openings already on the job (by base mark).
 * Only updates unconfirmed / planned drafts' window_type_id when empty or
 * when force-linking from a fresh specs upload.
 */
export async function linkSpecsToOpenings(
  projectId: string,
  drafts: DraftOpening[],
): Promise<{ linked: number }> {
  if (drafts.length === 0) return { linked: 0 };

  const markToType = new Map<string, string>();
  for (const d of drafts) {
    if (d.window_type_id) markToType.set(d.mark_code, d.window_type_id);
  }
  if (markToType.size === 0) return { linked: 0 };

  const { data: openings, error } = await supabase
    .from("project_openings")
    .select("id, opening_code, window_type_id, confirmed, status")
    .eq("project_id", projectId);
  if (error) throw error;

  let linked = 0;
  for (const o of openings ?? []) {
    if (o.confirmed || o.status !== "planned") continue;
    const mark = markBase(o.opening_code);
    const typeId = markToType.get(mark);
    if (!typeId) continue;
    if (o.window_type_id === typeId) continue;
    const { error: upErr } = await supabase
      .from("project_openings")
      .update({ window_type_id: typeId })
      .eq("id", o.id);
    if (upErr) throw upErr;
    linked += 1;
  }
  return { linked };
}

export async function updateOpening(
  id: string,
  patch: Partial<
    Pick<
      ProjectOpening,
      | "opening_code"
      | "window_type_id"
      | "label"
      | "page_number"
      | "pin_x"
      | "pin_y"
      // Wave V-A: confirming or dismissing a suggested placement goes through
      // this same function — pin_x/pin_y is exactly "the tracer already
      // writes them" (ProjectMap's placePin), and clearing suggested_* in the
      // same call is what marks a suggestion resolved so a rescan leaves it
      // alone. Confirming sets both; dismissing sets only the suggested_*
      // ones, which never touches pin_x/pin_y/page_number and so never
      // trips guard_opening_pin_move at all.
      | "suggested_pin_x"
      | "suggested_pin_y"
      | "suggested_page_number"
      | "suggested_at"
      | "suggested_confidence"
    >
  >,
): Promise<void> {
  const { error } = await supabase
    .from("project_openings")
    .update(patch)
    .eq("id", id);
  if (!error) return;
  // Moving a mark is foreman+ in the database. Rethrown as a plain Error so the
  // sentence reaches the crew on its own, without PostgREST's trailing code.
  if (isPinMoveDenied(error)) throw new Error(PIN_MOVE_DENIED);
  throw error;
}

/**
 * Take a window or door off a job. It is HIDDEN, not destroyed: its install
 * history, assignment, measurements, QC checks and photos all stay where they
 * are, and `restoreOpening` puts the lot back.
 *
 * The RPC does the work rather than a PATCH, because hiding a mark is a thing
 * that needs a name and a reason against it, and because the database refuses
 * anyone below foreman either way.
 */
export async function removeOpening(id: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc("remove_opening", {
    p_opening_id: id,
    p_reason: reason?.trim() || null,
  });
  if (error) throw refusalOrError(error);
}

/** Put a hidden window or door back on the job, exactly as it was. */
export async function restoreOpening(id: string): Promise<void> {
  const { error } = await supabase.rpc("restore_opening", {
    p_opening_id: id,
  });
  if (error) throw refusalOrError(error);
}

/**
 * What has been taken off this job, newest first — the only way to see a hidden
 * row, and foreman+ in the database.
 *
 * Best-effort in the same way as the pin history: a database without the
 * migration answers [] so the review screen still renders, just without the
 * removed list.
 */
export async function listRemovedOpenings(
  projectId: string,
): Promise<RemovedOpening[]> {
  if (!projectId) return [];
  const { data, error } = await supabase.rpc("list_removed_openings", {
    p_project_id: projectId,
  });
  if (error) {
    // An installer never reaches this screen, but if one did, an empty list is
    // the honest answer rather than a red banner about a list they may not see.
    if (isMissingFunction(error) || error.message?.trim() === REMOVED_LIST_DENIED) {
      return [];
    }
    throw error;
  }
  return (data ?? []) as RemovedOpening[];
}

// --- Moving marks on the map, and walking those moves back ---

/**
 * Every recorded move of every mark on a job, newest first.
 *
 * Written by a database trigger, not by the app, so it captures a drag from
 * anywhere and cannot be forged from a browser. Best-effort: a database without
 * the migration answers [] so the map still renders, just without Undo.
 */
export async function listPinMoves(projectId: string): Promise<PinMove[]> {
  if (!projectId) return [];
  const { data, error } = await supabase
    .from("project_opening_pin_moves")
    .select("*")
    .eq("project_id", projectId)
    .order("moved_at", { ascending: false })
    .limit(200);
  if (error) {
    if (isMissingPinHistory(error)) return [];
    throw error;
  }
  return (data ?? []).map((row) => ({
    ...row,
    from_pin_x: Number(row.from_pin_x),
    from_pin_y: Number(row.from_pin_y),
    to_pin_x: Number(row.to_pin_x),
    to_pin_y: Number(row.to_pin_y),
  })) as PinMove[];
}

function isMissingPinHistory(error: unknown): boolean {
  // Also treats a missing RPC as "no history yet": the move log is read through
  // a function that ships in the same migration as the table.
  return isMissingTable(error, "project_opening_pin_moves") || isMissingFunction(error);
}

/**
 * Walk ONE move back. Takes the move's id rather than "the newest one" so an
 * undo queued in a dead zone still undoes the move the person was looking at,
 * and so replaying a queued undo twice is a no-op.
 */
export async function undoPinMove(moveId: string): Promise<void> {
  const { error } = await supabase.rpc("undo_opening_pin_move", {
    p_move_id: moveId,
  });
  if (error) throw error;
}

/** Put every mark on a job back where the plan put it. Returns how many moved. */
export async function resetProjectPins(projectId: string): Promise<number> {
  const { data, error } = await supabase.rpc(
    "reset_project_pins_to_extracted",
    { p_project_id: projectId },
  );
  if (error) throw error;
  return Number(data ?? 0);
}

/** Put ONE mark back where the plan put it. */
export async function resetOpeningPin(openingId: string): Promise<number> {
  const { data, error } = await supabase.rpc(
    "reset_opening_pin_to_extracted",
    { p_opening_id: openingId },
  );
  if (error) throw error;
  return Number(data ?? 0);
}

/**
 * Confirm ONE opening — "I checked this window's numbers against the plans."
 *
 * Any signed-in crew, deliberately. Readiness now requires a confirmed opening
 * (see lib/install/fit.ts), and the bulk review screen is foreman+. Without a
 * per-opening path an installer standing at an unreviewed window would have to
 * find a foreman before they could start — which is exactly the bottleneck
 * that would make the whole check get switched back off. The person at the
 * window is the one who can actually compare it to the drawing.
 */
export async function confirmOpening(openingId: string): Promise<void> {
  const { error } = await supabase
    .from("project_openings")
    .update({ confirmed: true })
    .eq("id", openingId);
  if (error) throw error;
}

export async function confirmOpenings(projectId: string): Promise<void> {
  const { error } = await supabase
    .from("project_openings")
    .update({ confirmed: true })
    .eq("project_id", projectId)
    .eq("confirmed", false);
  if (error) throw error;
}

// --- Elevation references (where a mark is DRAWN, not what exists) ---

/** True when the elevation-view table hasn't been migrated yet. */
function isMissingElevationTable(error: unknown): boolean {
  return isMissingTable(error, "project_mark_elevation_views");
}

/**
 * Every elevation reference on a project. Best-effort: returns [] when the
 * table isn't there yet, so no page can crash and nothing is shown.
 */
export async function listElevationViews(
  projectId: string,
): Promise<MarkElevationView[]> {
  if (!projectId) return [];
  const { data, error } = await supabase
    .from("project_mark_elevation_views")
    .select("*")
    .eq("project_id", projectId)
    .order("mark_code");
  if (error) {
    if (isMissingElevationTable(error)) return [];
    throw error;
  }
  return (data ?? []) as MarkElevationView[];
}

/**
 * Replace a building planset's elevation references with what a fresh read of
 * that planset found.
 *
 * Deletes the project's rows and re-inserts, so re-reading the same plans can
 * only ever restate the same rows — it cannot pile up duplicates, and it cannot
 * touch openings, which live in a different table entirely. Clearing the whole
 * project rather than just this planset is deliberate: a job has one building
 * plan, and rows measured against a superseded one describe a file the crew is
 * no longer working from.
 *
 * Best-effort by design. This is reference material; a project whose migration
 * hasn't been applied, or a crew member without write permission, simply sees
 * no pictures, and nothing upstream is failed because of it.
 */
export async function saveElevationViews(
  projectId: string,
  plansetId: string,
  appearances: ElevationAppearance[],
): Promise<{ saved: number }> {
  if (!projectId || !plansetId) return { saved: 0 };
  try {
    const { error: delErr } = await supabase
      .from("project_mark_elevation_views")
      .delete()
      .eq("project_id", projectId);
    if (delErr) throw delErr;

    if (appearances.length === 0) return { saved: 0 };
    const rows = appearances.map((a) => ({
      project_id: projectId,
      planset_id: plansetId,
      mark_code: a.mark,
      page_number: a.pageNumber,
      region_index: a.regionIndex,
      view_name: a.viewName,
      pin_x: a.pinX,
      pin_y: a.pinY,
      label_w: a.labelW,
      label_h: a.labelH,
      crop_bbox: a.cropBbox,
    }));
    const { error } = await supabase
      .from("project_mark_elevation_views")
      .insert(rows);
    if (error) throw error;
    return { saved: rows.length };
  } catch {
    return { saved: 0 };
  }
}

/**
 * Where every mark is drawn on an already-loaded building planset's elevation
 * sheets.
 *
 * Shares ONE decision with the opening count (`splitCalloutsByFloorPlan`):
 * openings come from the floor drawings, and only the callouts that decision
 * threw out can become references. Every caller goes through here, so that
 * cannot drift apart in one place and not another.
 */
export async function elevationAppearancesFromDoc(
  doc: PDFDocumentProxy,
): Promise<ElevationAppearance[]> {
  const { extractAllText, extractPlanMarkCallouts, extractSheetTextLines } =
    await import("./pdf");
  const callouts = await extractPlanMarkCallouts(doc);
  if (callouts.length === 0) return [];
  const { repeatViewCallouts } = splitCalloutsByFloorPlan(
    callouts,
    await extractAllText(doc),
  );
  if (repeatViewCallouts.length === 0) return [];
  return elevationAppearances({
    repeatViewCallouts,
    lines: await extractSheetTextLines(doc),
  });
}

// --- Per-mark specs (rich line-item, shared across a mark's openings) ---

/** True when the specs table hasn't been migrated yet — degrade to hidden. */
function isMissingSpecsTable(error: unknown): boolean {
  return isMissingTable(error, "project_mark_specs");
}

/**
 * All confirmed + draft specs on a project, keyed later by markBase. Best-effort:
 * returns [] when the table doesn't exist yet so no page can crash.
 */
export async function listMarkSpecs(
  projectId: string,
): Promise<ProjectMarkSpec[]> {
  if (!projectId) return [];
  const { data, error } = await supabase
    .from("project_mark_specs")
    .select("*")
    .eq("project_id", projectId)
    .order("mark_code");
  if (error) {
    if (isMissingSpecsTable(error)) return [];
    throw error;
  }
  return (data ?? [])
    .map(parseSpecRow)
    .filter((s): s is ProjectMarkSpec => s !== null);
}

/** Specs plus the per-page outcome of the extraction that produced them. */
export interface SpecExtractionResult {
  specs: MarkSpecDraft[];
  /** "vision" (page images) or "text" (schedule-table fallback). */
  mode: "vision" | "text";
  /** Per-page status; empty in text mode, which batches pages into one call. */
  pages: SpecPageStatus[];
}

/**
 * Invoke the edge function to pull rich per-mark specs from a planset.
 *
 * VISION is primary: when `images` (base64 page renders) are supplied, Claude
 * reads the drawn-in spec table off the image — the only way to recover
 * style/glass/color from a manufacturer shop drawing whose text layer is empty.
 * The function replies `mode: "vision"` with verbatim marks, which we normalize
 * client-side (strip project prefix, split size/operation, derive
 * tempered/egress) before merging. Text mode is the legacy schedule-table path.
 *
 * The reply also carries a per-page status, which the caller must keep: a page
 * whose vision call failed returns no marks, and without that status it looks
 * exactly like a page with no marks on it.
 */
export async function aiExtractSpecs(
  pages: { pageNumber: number; text: string }[],
  projectId?: string,
  images?: { pageNumber: number; dataUrl: string }[],
): Promise<SpecExtractionResult> {
  const { data, error } = await supabase.functions.invoke("extract-specs", {
    body: { pages, images, projectId },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  const raw = (data?.specs ?? []) as unknown[];
  const mode = data?.mode === "vision" ? "vision" : "text";
  return {
    specs:
      mode === "vision"
        ? visionMarksToDrafts(raw as RawVisionMark[])
        : mergeSpecsByMark(raw, "ai"),
    mode,
    pages: parseSpecPageStatuses(data?.pages),
  };
}

/** Outcome of saving an extraction: what landed, plus what went wrong where. */
export interface SpecSaveResult {
  saved: number;
  skipped: number;
  /** Per-page vision outcome; empty when vision didn't run or wasn't reported. */
  pages: SpecPageStatus[];
  /** True when page images were sent but the vision call itself failed outright. */
  visionFailed: boolean;
  /** Merged drafts this call produced, to carry into the next page of a run. */
  drafts: MarkSpecDraft[];
}

/** DB column set we persist for a mark spec draft (never writes confirmed). */
function specDraftColumns(
  projectId: string,
  spec: MarkSpecDraft,
  plansetId?: string | null,
): Record<string, unknown> {
  return {
    project_id: projectId,
    // Which specs planset the page/box below were measured against. Without it a
    // replaced planset silently repoints every saved box at a different drawing.
    planset_id: plansetId ?? spec.planset_id ?? null,
    mark_code: spec.mark_code,
    style: spec.style,
    glass: spec.glass,
    color: spec.color,
    size_code: spec.size_code,
    width_in: spec.width_in,
    height_in: spec.height_in,
    operation: spec.operation,
    tempered: spec.tempered,
    egress: spec.egress,
    u_factor: spec.u_factor,
    shgc: spec.shgc,
    grids: spec.grids,
    screen: spec.screen,
    product_line: spec.product_line,
    extra: spec.extra ?? {},
    image_page: spec.image_page,
    image_bbox: spec.image_bbox,
    source: spec.source,
    // Wave X: window or door, and which door, read off the words the extractor
    // just captured. Stored rather than worked out at read time so a job card
    // can count them in one grouped query instead of pulling every opening.
    ...specKindColumns(spec),
  };
}

/**
 * Spec columns that arrive with their own migration and may not exist yet:
 * `image_page`/`image_bbox` (20260727000000_mark_spec_drawings.sql),
 * `planset_id` (20260728000000_mark_spec_planset.sql) and `unit_kind`/
 * `door_kind` (20260980000000_scope_at_a_glance.sql). Losing the picture — or
 * the record of which file it came from, or what kind of unit it is — must never
 * cost us the spec TEXT, so a write PostgREST rejects for one of these is
 * retried without it.
 */
const OPTIONAL_SPEC_COLUMNS = [
  "image_page",
  "image_bbox",
  "planset_id",
  "unit_kind",
  "door_kind",
] as const;

/**
 * Columns that arrive together and so must be dropped together. PostgREST names
 * ONE column per complaint, and `unit_kind`/`door_kind` come from one migration:
 * a retry that dropped only the named half would be refused all over again —
 * for the other half, or (worse, on a half-migrated database) by the check
 * constraint that says a door kind only means something on a door.
 */
type OptionalSpecColumn = (typeof OPTIONAL_SPEC_COLUMNS)[number];

const SPEC_COLUMN_PAIRS: readonly (readonly OptionalSpecColumn[])[] = [
  ["unit_kind", "door_kind"],
];

/**
 * Which optional columns (if any) PostgREST is complaining about. Empty when the
 * error is something else entirely — those must still surface. PURE; exported
 * so the degrade path is tested without a database.
 */
export function missingOptionalSpecColumns(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const e = error as { code?: unknown; message?: unknown };
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  const named = new Set(OPTIONAL_SPEC_COLUMNS.filter((c) => message.includes(c)));
  if (named.size === 0) return [];
  const looksLikeColumnError =
    e.code === "PGRST204" || e.code === "42703" || message.includes("column");
  if (!looksLikeColumnError) return [];
  for (const pair of SPEC_COLUMN_PAIRS) {
    if (pair.some((c) => named.has(c))) for (const c of pair) named.add(c);
  }
  return OPTIONAL_SPEC_COLUMNS.filter((c) => named.has(c));
}

function withoutColumns(
  row: Record<string, unknown>,
  columns: Iterable<string>,
): Record<string, unknown> {
  const copy = { ...row };
  for (const c of columns) delete copy[c];
  return copy;
}

/**
 * Fill-missing-only law for `extra.pane_grid` (receipts precedent, wave G): a
 * mark that already has a pane_grid on file keeps it through every future
 * extraction run, confirmed row or not. `extractAndSaveMarkSpecs` upserts the
 * WHOLE `extra` column on every unconfirmed mark's re-extract (existing,
 * unchanged behavior for every other field in it) — without this, a second
 * vision pass reading the SAME drawing slightly differently would silently
 * replace a grid a foreman may already be relying on. `existingPaneGrid` is
 * whatever `extra.pane_grid` currently sits on that mark_code's row (from
 * `listMarkSpecs`), or undefined/null when there is none yet. PURE.
 */
export function preservePaneGrid(
  draftExtra: Record<string, unknown> | null,
  existingPaneGrid: unknown,
): Record<string, unknown> | null {
  if (existingPaneGrid == null) return draftExtra;
  return { ...(draftExtra ?? {}), pane_grid: existingPaneGrid };
}

/** The little the drawing-adoption rule needs off a stored spec row. */
export interface StoredDrawingCoords {
  id: string;
  mark_code: string;
  confirmed: boolean;
  image_page: number | null;
  image_bbox: unknown;
  planset_id: string | null;
}

/** One confirmed row's drawing coordinates, filled in as a set. */
export interface AdoptedDrawingCoords {
  id: string;
  image_page: number;
  image_bbox: Bbox;
  planset_id: string;
}

/**
 * Which CONFIRMED marks may take the drawing coordinates this extraction run
 * just found.
 *
 * A confirmed mark's TEXT is untouchable — a foreman read the sheet and said so,
 * and a re-read must never argue with that (unchanged law, and why confirmed
 * marks are skipped by the upsert entirely). But a confirmed row that has NO
 * drawing at all has nothing to protect: the foreman confirmed words, and the
 * picture was simply never located. Mad Moose, 2026-09-01 — the addendum sheet
 * carried three added units whose marks were already confirmed from the
 * schedule, so without this they would stay picture-less forever no matter how
 * many times the sheet is re-read.
 *
 * Fill-missing-only, and as a SET: page, box and planset are written together,
 * so provenance is never half from one sheet and half from another. "Has no
 * drawing" means no page and no box; a row holding either one is left alone,
 * because only the run that measured a box may argue with it.
 *
 * A LONE planset id is not a drawing. That is exactly what the old retire step
 * left behind on Mad Moose's marks 4–10 — it blanked page and box and kept the
 * pointer — and refusing those rows would strand them picture-less forever, the
 * permanent loss this whole change exists to undo. Nothing is adopted unless we
 * know which planset THIS run read, because a box saved with a null planset is
 * unplaceable. PURE.
 */
export function adoptableDrawingCoords(
  existing: StoredDrawingCoords[],
  drafts: { mark_code: string; image_page: number | null; image_bbox: unknown }[],
  plansetId: string | null | undefined,
): AdoptedDrawingCoords[] {
  if (!plansetId) return [];

  const key = (code: unknown) => String(code ?? "").trim().toUpperCase();
  const found = new Map<string, { page: number; bbox: Bbox }>();
  for (const draft of drafts ?? []) {
    const page = draft?.image_page;
    const bbox = validateBbox(draft?.image_bbox);
    if (page == null || !Number.isInteger(page) || page < 1 || bbox == null) continue;
    const mark = key(draft.mark_code);
    if (!mark || found.has(mark)) continue;
    found.set(mark, { page, bbox });
  }
  if (found.size === 0) return [];

  const adopted: AdoptedDrawingCoords[] = [];
  for (const row of existing ?? []) {
    if (!row?.confirmed || !row.id) continue;
    // A page or a box means the picture is already located, and this run has no
    // standing to move it. A pointer on its own crops nothing, so the row is
    // still picture-less and the write below replaces the pointer too.
    if (row.image_page != null || row.image_bbox != null) continue;
    const match = found.get(key(row.mark_code));
    if (!match) continue;
    adopted.push({
      id: row.id,
      image_page: match.page,
      image_bbox: match.bbox,
      planset_id: plansetId,
    });
  }
  return adopted;
}

/**
 * Write what {@link adoptableDrawingCoords} decided, one row at a time and
 * touching only the three drawing columns, so a confirmed mark's text is never
 * in the payload at all. Best-effort: an un-migrated column or a refused write
 * leaves the row exactly as it was and the extraction carries on.
 */
async function adoptDrawingCoords(
  adopted: AdoptedDrawingCoords[],
): Promise<number> {
  let filled = 0;
  try {
    for (const row of adopted) {
      const { error } = await supabase
        .from("project_mark_specs")
        .update({
          image_page: row.image_page,
          image_bbox: row.image_bbox,
          planset_id: row.planset_id,
        })
        .eq("id", row.id);
      // One refusal means every row will be refused the same way (a missing
      // column, no write permission) — stop rather than issue N doomed writes.
      if (error) break;
      filled += 1;
    }
  } catch {
    // Offline mid-run. The rows that landed keep their drawings; the rest are
    // still eligible next time the sheet is read.
  }
  return filled;
}

/**
 * Extract rich specs from the specs-planset page text and upsert them as
 * unconfirmed drafts keyed by (project_id, mark_code). Guardrail: a mark whose
 * spec is already CONFIRMED is never clobbered by a re-extract (same philosophy
 * as saveDraftOpenings), and `extra.pane_grid` specifically is never clobbered
 * even on an unconfirmed mark (see {@link preservePaneGrid}). Best-effort: a
 * missing table degrades to { saved: 0 } instead of blowing up the upload flow.
 *
 * Two extractors run and are MERGED (never one replacing the other):
 *   1. Claude VISION (`extract-specs`) reads the rich line-item — style, glass,
 *      color, size, operation — off the rendered page IMAGES. This is the
 *      primary source: manufacturer shop drawings draw the spec table as
 *      graphics, so it's the only way to recover glass/color/style.
 *   2. A deterministic text parser (`extractSpecsDeterministic`) is the OFFLINE
 *      / no-API fallback: it pulls size codes, decoded dims, operation,
 *      frosted/egress, and hardware from the scrambled text layer with no
 *      network call.
 * The vision result is the base so its richer fields win; the deterministic
 * result fills size/operation gaps and adds marks vision missed. If the vision
 * call fails or no images are supplied, we still save the deterministic result.
 *
 * The returned `pages` is the per-page vision outcome, so the caller can tell a
 * foreman that page 5 failed instead of quietly saving 5 pages' worth of marks
 * and calling it done. `visionFailed` covers the other silence: the whole call
 * blew up and only the deterministic parser's thin result was saved.
 */
export async function extractAndSaveMarkSpecs(
  projectId: string,
  pages: { pageNumber: number; text: string }[],
  images?: { pageNumber: number; dataUrl: string }[],
  /** The specs planset these pages/images came from, stored as provenance. */
  plansetId?: string | null,
  /**
   * Drafts already merged from EARLIER pages of the same sheet.
   *
   * A page-at-a-time run must not lose a mark that spans pages: the row is
   * upserted whole, so saving page 2's partial view of mark 14 on its own would
   * null out the size page 1 found. Passing the running total in as the merge
   * base keeps the reunited row that a whole-sheet call used to produce.
   */
  carryOver?: MarkSpecDraft[],
): Promise<SpecSaveResult> {
  const empty: SpecSaveResult = {
    saved: 0,
    skipped: 0,
    pages: [],
    visionFailed: false,
    drafts: [],
  };
  if (!projectId || pages.length === 0) return empty;

  let aiDrafts: MarkSpecDraft[] = [];
  let pageStatuses: SpecPageStatus[] = [];
  let visionFailed = false;
  try {
    const result = await aiExtractSpecs(pages, projectId, images);
    aiDrafts = result.specs;
    pageStatuses = result.pages;
  } catch {
    // Vision unavailable / errored — fall back to the deterministic parser.
    aiDrafts = [];
    visionFailed = Boolean(images && images.length > 0);
  }

  const deterministic = extractSpecsDeterministic(pages);

  // AI first so its richer, higher-confidence fields are the base that
  // deterministic size/operation data reinforces (fills gaps) rather than
  // overwrites. Distinct marks from either source both survive.
  const drafts = mergeSpecsByMark(
    [...(carryOver ?? []), ...aiDrafts, ...deterministic],
    "deterministic",
  );
  const status = { pages: pageStatuses, visionFailed, drafts };
  if (drafts.length === 0) return { saved: 0, skipped: 0, ...status };

  // Which marks are already confirmed? Never overwrite those. Separately —
  // pane_grid rescan law (receipts precedent, wave G): whatever pane_grid is
  // already on file for a mark_code is kept forever, confirmed row or not.
  // See preservePaneGrid above for why this needs its own map instead of
  // riding on confirmedMarks.
  let confirmedMarks = new Set<string>();
  const existingPaneGridByMark = new Map<string, unknown>();
  let existingRows: ProjectMarkSpec[] = [];
  try {
    existingRows = await listMarkSpecs(projectId);
    confirmedMarks = new Set(
      existingRows.filter((s) => s.confirmed).map((s) => s.mark_code.toUpperCase()),
    );
    for (const s of existingRows) {
      const grid = s.extra?.pane_grid;
      if (grid != null) {
        existingPaneGridByMark.set(s.mark_code.toUpperCase(), grid);
      }
    }
  } catch {
    // If we can't read existing rows we simply won't skip any, and there's
    // nothing on file to protect either — a fresh extraction proceeds
    // exactly as it always has.
  }

  // A confirmed mark with no picture at all can take the one this run located,
  // even though its text is untouchable — see adoptableDrawingCoords. Fire and
  // forget: a spec row that gains its drawing a second later is a bonus, and
  // failing the whole extraction over it would be a bad trade.
  await adoptDrawingCoords(
    adoptableDrawingCoords(existingRows, drafts, plansetId),
  );

  const toSave = drafts.filter(
    (d) => !confirmedMarks.has(d.mark_code.toUpperCase()),
  );
  const skipped = drafts.length - toSave.length;
  if (toSave.length === 0) return { saved: 0, skipped, ...status };

  const rows = toSave.map((d) =>
    specDraftColumns(
      projectId,
      {
        ...d,
        extra: preservePaneGrid(
          d.extra,
          existingPaneGridByMark.get(d.mark_code.toUpperCase()),
        ),
      },
      plansetId,
    ),
  );
  const upsert = (payload: Record<string, unknown>[]) =>
    supabase
      .from("project_mark_specs")
      .upsert(payload, { onConflict: "project_id,mark_code" });

  // Drop whichever optional column an un-migrated environment rejects and try
  // again, one complaint at a time, rather than losing the whole extraction. Two
  // retries covers both migrations being absent.
  let { error } = await upsert(rows);
  const dropped = new Set<string>();
  for (let attempt = 0; attempt < OPTIONAL_SPEC_COLUMNS.length && error; attempt++) {
    const missing = missingOptionalSpecColumns(error).filter((c) => !dropped.has(c));
    if (missing.length === 0) break;
    for (const c of missing) dropped.add(c);
    ({ error } = await upsert(rows.map((r) => withoutColumns(r, dropped))));
  }
  if (error) {
    if (isMissingSpecsTable(error)) return { saved: 0, skipped, ...status };
    throw error;
  }
  return { saved: toSave.length, skipped, ...status };
}

/**
 * Which plansets the project's spec rows still point at that the project NO
 * LONGER HAS — the whole decision {@link clearOrphanedDrawingCoords} acts on,
 * pulled out so it can be tested without a database.
 *
 * `currentSpecsPlansetIds` is every specs planset the project still holds, not
 * just the one we happened to read last. Until 2026-09-01 the query said "every
 * planset except the file I just read", which is how Mad Moose's one-page
 * ADDENDUM cut sheet erased the drawings for marks 4–10 off the original
 * four-page supplier sheet the moment it finished uploading. An addendum adds a
 * file; it does not take the first one away — so a sheet that is still on the
 * job is never orphaned, however many other sheets arrive after it.
 *
 * Rows with a null `planset_id` name no file and so can't be orphaned: that's
 * legacy data whose provenance we never recorded (all pre-migration rows,
 * including the live Smith job), and wiping working drawings to satisfy a
 * bookkeeping rule would be a downgrade for the crew. An empty current set
 * means we can't see what the project holds, so nothing is provably gone. PURE.
 */
export function orphanedPlansetIds(
  rows: readonly { planset_id?: string | null }[],
  currentSpecsPlansetIds: readonly string[],
): string[] {
  if (currentSpecsPlansetIds.length === 0) return [];
  const current = new Set(currentSpecsPlansetIds);
  const gone = new Set<string>();
  for (const row of rows ?? []) {
    const source = row?.planset_id;
    if (!source || current.has(source)) continue;
    gone.add(source);
  }
  return [...gone];
}

/**
 * Blank the drawing provenance on any spec row pointing at a specs planset the
 * project no longer has — a file that was deleted or genuinely replaced. Those
 * boxes can never be rendered again (nothing left to crop out of), so clearing
 * them makes the row honest instead of merely un-rendered.
 *
 * All THREE columns go, the pointer included. Leaving a dead planset id behind
 * is what stranded Mad Moose's marks: a row with no page and no box but a
 * pointer at a file that no longer exists is picture-less, and until the
 * adoption rule stopped refusing those rows it stayed that way forever. Once
 * the pointer is gone the row is plainly "no drawing yet", which is what it is,
 * and the next read of a re-uploaded sheet fills it back in.
 *
 * Which ids are gone is decided first, by {@link orphanedPlansetIds} — the
 * update can't report it, because clearing the pointer is exactly what the
 * returned rows would no longer carry. Those ids go back to the caller so it
 * can drop the cached crop pixels too. The clear runs only when something is
 * genuinely orphaned, and it can't repeat: afterwards those rows name no
 * planset at all. Best-effort — nothing here is worth failing an upload.
 */
export async function clearOrphanedDrawingCoords(
  projectId: string,
  currentSpecsPlansetIds: readonly string[],
): Promise<string[]> {
  if (!projectId || currentSpecsPlansetIds.length === 0) return [];
  try {
    const { data, error } = await supabase
      .from("project_mark_specs")
      .select("planset_id")
      .eq("project_id", projectId)
      .not("planset_id", "is", null);
    if (error) throw error;
    const gone = orphanedPlansetIds(
      (data ?? []) as { planset_id?: string | null }[],
      currentSpecsPlansetIds,
    );
    if (gone.length === 0) return [];
    const { error: clearError } = await supabase
      .from("project_mark_specs")
      .update({ image_page: null, image_bbox: null, planset_id: null })
      .eq("project_id", projectId)
      .in("planset_id", gone);
    if (clearError) throw clearError;
    return gone;
  } catch {
    // Table or columns not migrated yet, or no write permission — nothing to do.
    return [];
  }
}

/**
 * Re-run the spec extraction over a project's specs planset, optionally only
 * over `pageNumbers` — the retry affordance for the pages the vision pass
 * couldn't read. Downloads and renders client-side (pdf.js is imported lazily
 * so it stays out of the app shell), then goes through the same save path, so
 * confirmed marks are still never clobbered.
 *
 * Re-reading a page can only ADD to what's stored: a page that fails again
 * leaves the marks already saved from the good pages untouched.
 */
export async function reextractSpecPages(
  projectId: string,
  planset: Planset,
  pageNumbers?: number[],
): Promise<SpecSaveResult> {
  const { extractAllText, loadPdf } = await import("./pdf");
  const { renderSpecPageImages } = await import("./renderSpecImages");

  const doc = await loadPdf(await downloadPlanset(planset));
  const allPages = await extractAllText(doc);
  const wanted =
    pageNumbers && pageNumbers.length > 0 ? new Set(pageNumbers) : null;

  let images: { pageNumber: number; dataUrl: string }[] = [];
  try {
    images = await renderSpecPageImages(doc, wanted ? { pages: [...wanted] } : {});
  } catch {
    // Rendering failed (e.g. phone memory) — the text path still runs.
    images = [];
  }

  // The deterministic text parser is cheap and page-scoped, so when we're
  // retrying specific pages we hand it only those pages too. Its marks then
  // line up with the images instead of re-deriving the whole sheet.
  const textPages = wanted
    ? allPages.filter((p) => wanted.has(p.pageNumber))
    : allPages;

  const result = await extractAndSaveMarkSpecs(
    projectId,
    textPages.length > 0 ? textPages : allPages,
    images,
    planset.id,
  );
  await retireVanishedSpecsPlansets(projectId);
  return result;
}

// --- Durable per-page extraction progress (progress bar + resume) ---

/** True when the progress table hasn't been migrated yet — degrade to no-op. */
function isMissingProgressTable(error: unknown): boolean {
  return isMissingTable(error, "project_planset_pages");
}

/**
 * Stored per-page outcomes for a planset, oldest page first. Best-effort: an
 * environment without the migration returns [], which simply means every run
 * starts from page 1 and the bar shows live-only progress — the pre-existing
 * behaviour, never an error.
 */
export async function listPlansetPageProgress(
  plansetId: string,
): Promise<StoredPageProgress[]> {
  if (!plansetId) return [];
  const { data, error } = await supabase
    .from("project_planset_pages")
    .select("page_number, ok, attempts, mark_count, error, updated_at")
    .eq("planset_id", plansetId)
    .order("page_number");
  if (error) {
    if (isMissingProgressTable(error)) return [];
    throw error;
  }
  return (data ?? []).map((row) => ({
    pageNumber: Number(row.page_number),
    ok: Boolean(row.ok),
    attempts: Number(row.attempts ?? 0),
    markCount: Number(row.mark_count ?? 0),
    error: typeof row.error === "string" && row.error ? row.error : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  }));
}

/**
 * Record one page's outcome as soon as it finishes, so the bar reflects stored
 * state and an interrupted run knows where to pick up. Best-effort for the same
 * reason as the read: losing a progress row must never cost us the specs that
 * page just produced.
 */
export async function savePlansetPageProgress(
  plansetId: string,
  status: SpecPageStatus,
): Promise<void> {
  if (!plansetId) return;
  const { error } = await supabase.from("project_planset_pages").upsert(
    {
      planset_id: plansetId,
      page_number: status.pageNumber,
      ok: status.ok,
      attempts: status.attempts,
      mark_count: status.markCount,
      error: status.error,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "planset_id,page_number" },
  );
  if (error && !isMissingProgressTable(error)) throw error;
}

/** Forget a planset's progress so the next run re-reads every page. */
export async function clearPlansetPageProgress(plansetId: string): Promise<void> {
  if (!plansetId) return;
  const { error } = await supabase
    .from("project_planset_pages")
    .delete()
    .eq("planset_id", plansetId);
  if (error && !isMissingProgressTable(error)) throw error;
}

/**
 * The slice of a pdf.js document the runner needs. Structural so callers can
 * hand over a `PDFDocumentProxy` without this module importing pdf.js types
 * into the app shell.
 */
type PdfDocumentLike = Parameters<
  typeof import("./renderSpecImages").renderPageJpeg
>[0];

/** Live callback payload for the extraction progress bar. */
export interface SpecExtractionTick {
  /** Page just finished, or about to start when `status` is null. */
  pageNumber: number;
  /** Outcome, once the page completed. */
  status: SpecPageStatus | null;
  /** Everything stored for this planset so far, including `status`. */
  progress: StoredPageProgress[];
}

export interface SpecExtractionOptions {
  /** Only these pages (a targeted retry of the ones that failed). */
  pages?: number[];
  /** Already-loaded document, so an upload doesn't re-download its own file. */
  doc?: PdfDocumentLike;
  /** Polled between pages so the UI can stop a run. */
  isCancelled?: () => boolean;
  onTick?: (tick: SpecExtractionTick) => void;
}

export interface SpecExtractionRunResult {
  saved: number;
  pages: StoredPageProgress[];
  /** Pages read during THIS run (a resume skips the ones already done). */
  processed: number;
  /** True when the caller aborted part-way; the planset stays resumable. */
  stopped: boolean;
}

/**
 * Read a specs planset page by page, saving specs AND progress as each page
 * lands.
 *
 * This replaces the old all-at-once call for the interactive paths. The edge
 * function already made one vision call per page internally, so driving the
 * loop from here costs nothing in extraction quality but buys three things the
 * crew asked for: a progress bar that names the page being read, progress that
 * survives leaving the screen, and a resume that starts at the first page which
 * never completed instead of redoing the sheet.
 *
 * A page that throws is recorded as failed and the run CONTINUES — one bad page
 * must not cost the other thirteen. The planset only goes to `ready` when every
 * page has been attempted, so an interrupted run stays visibly resumable rather
 * than looking finished.
 */
export async function runSpecExtraction(
  projectId: string,
  planset: Planset,
  opts: SpecExtractionOptions = {},
): Promise<SpecExtractionRunResult> {
  const { extractAllText, loadPdf } = await import("./pdf");
  const { renderPageJpeg } = await import("./renderSpecImages");

  const doc = opts.doc ?? (await loadPdf(await downloadPlanset(planset)));
  const total = doc.numPages;
  if (planset.page_count !== total) {
    await updatePlanset(planset.id, { page_count: total }).catch(() => {});
  }

  let stored = await listPlansetPageProgress(planset.id);
  const queue = pendingPages(total, stored, opts.pages);

  if (queue.length === 0) {
    await finishSpecExtraction(projectId, planset, total, stored);
    return { saved: 0, pages: stored, processed: 0, stopped: false };
  }

  await updatePlanset(planset.id, { status: "extracting" }).catch(() => {});

  const allText = await extractAllText(doc);
  const textByPage = new Map(allText.map((p) => [p.pageNumber, p]));

  let saved = 0;
  let processed = 0;
  let stopped = false;
  // Running merge base so a mark drawn across two pages ends up as one whole
  // row, exactly as the old whole-sheet call produced.
  let carryOver: MarkSpecDraft[] = [];

  for (const pageNumber of queue) {
    if (opts.isCancelled?.()) {
      stopped = true;
      break;
    }
    opts.onTick?.({ pageNumber, status: null, progress: stored });

    let status: SpecPageStatus;
    try {
      let images: { pageNumber: number; dataUrl: string }[] = [];
      try {
        images = [{ pageNumber, dataUrl: await renderPageJpeg(doc, pageNumber) }];
      } catch {
        // Unrenderable page (phone memory) — the text parser still covers it.
        images = [];
      }
      const textPage = textByPage.get(pageNumber) ?? { pageNumber, text: "" };
      const before = carryOver.length;
      const result = await extractAndSaveMarkSpecs(
        projectId,
        [textPage],
        images,
        planset.id,
        carryOver,
      );
      carryOver = result.drafts;
      // Each page re-saves the running merge, so this is the total written so
      // far, not a sum of per-page counts.
      saved = result.saved;
      status = result.pages.find((p) => p.pageNumber === pageNumber) ?? {
        pageNumber,
        // No per-page status means the text path ran (it batches, so it reports
        // none). It completed, so the page is done — that's the whole point of
        // distinguishing "read and empty" from "never read".
        ok: true,
        attempts: 1,
        markCount: Math.max(0, carryOver.length - before),
        error: null,
      };
    } catch (e) {
      status = {
        pageNumber,
        ok: false,
        attempts: 1,
        markCount: 0,
        error: formatApiError(e),
      };
    }

    processed += 1;
    await savePlansetPageProgress(planset.id, status).catch(() => {});
    stored = [
      ...stored.filter((p) => p.pageNumber !== pageNumber),
      { ...status, updatedAt: new Date().toISOString() },
    ].sort((a, b) => a.pageNumber - b.pageNumber);
    opts.onTick?.({ pageNumber, status, progress: stored });
  }

  if (!stopped) await finishSpecExtraction(projectId, planset, total, stored);
  return { saved, pages: stored, processed, stopped };
}

/**
 * Close out a run: retire the superseded specs planset and take the row out of
 * `extracting`. Only called when every page has been attempted, so an
 * interrupted run keeps its resumable state instead of being marked done.
 */
async function finishSpecExtraction(
  projectId: string,
  planset: Planset,
  total: number,
  stored: StoredPageProgress[],
): Promise<void> {
  const attempted = new Set(
    stored.filter((p) => p.pageNumber <= total).map((p) => p.pageNumber),
  );
  if (total > 0 && attempted.size < total) return;
  await retireVanishedSpecsPlansets(projectId);
  await updatePlanset(planset.id, { status: "ready" }).catch(() => {});
}

/**
 * Called once a specs planset has been processed for a project: retire whatever
 * is left over from a specs planset the project no longer HAS, so a deleted or
 * genuinely replaced file can't leave drawings pointing into nothing.
 *
 * This used to be `retireReplacedSpecsPlansets(projectId, currentPlansetId)`,
 * and it treated the file just read as the only one that counts. Mad Moose,
 * 2026-09-01: the owner uploaded a one-page ADDENDUM cut sheet for three added
 * units alongside the four-page supplier sheet, and finishing that upload
 * blanked the drawing coordinates for marks 4–10 — the crew lost the page with
 * the markups on every spec card and on the Maps Interactive wall. Uploading a
 * specs planset ADDS one; the app has no "replace this file" action at all, so
 * the only thing worth retiring is provenance pointing at a planset that is
 * genuinely gone from the project.
 *
 * Two things retire: the row's whole drawing provenance — page, box and the
 * pointer at the vanished file (see {@link clearOrphanedDrawingCoords}) — and
 * any crop pixels cached from those plansets. The cache purge is best-effort
 * on purpose — the client's
 * staleness guard already refuses to render one of those crops, so this is
 * housekeeping, not the safety net.
 */
export async function retireVanishedSpecsPlansets(
  projectId: string,
): Promise<void> {
  if (!projectId) return;
  let current: string[];
  try {
    current = specsPlansetIds(await listPlansets(projectId));
  } catch {
    // Can't see what the project holds, so nothing is provably gone.
    return;
  }
  for (const plansetId of await clearOrphanedDrawingCoords(projectId, current)) {
    await dropCropsForPlanset(plansetId).catch(() => {});
  }
}

/** Foreman edit of one mark spec (marks it source='manual'). */
export async function updateMarkSpec(
  id: string,
  patch: Partial<
    Pick<
      ProjectMarkSpec,
      | "style"
      | "glass"
      | "color"
      | "size_code"
      | "width_in"
      | "height_in"
      | "operation"
      | "tempered"
      | "egress"
      | "u_factor"
      | "shgc"
      | "grids"
      | "screen"
      | "product_line"
      | "extra"
    >
  >,
): Promise<void> {
  const row: Record<string, unknown> = { ...patch, source: "manual" };

  // Wave X: the stored kind is a READING of the spec text, so when a foreman
  // corrects the text the kind has to move with it — a mark rewritten from
  // "Fixed Window" to "French Door" that stayed filed as a window would make
  // the job card quietly wrong, and nothing on screen would say why. Reading
  // the row first is what lets an edit that touches only `style` still be
  // classified with the operation the row already holds.
  if ("style" in patch || "operation" in patch) {
    const kinds = await markSpecKindsAfterEdit(id, patch);
    if (kinds) Object.assign(row, kinds);
  }

  let { error } = await supabase.from("project_mark_specs").update(row).eq("id", id);
  if (error) {
    // A database that has not had the kind columns yet still takes the edit —
    // the same drop-the-optional-column retry the extraction save does.
    const missing = missingOptionalSpecColumns(error);
    if (missing.length === 0) throw error;
    ({ error } = await supabase
      .from("project_mark_specs")
      .update(withoutColumns(row, missing))
      .eq("id", id));
    if (error) throw error;
  }
}

/**
 * The kind columns for a spec row AFTER `patch` is applied to it: whichever of
 * style/operation the edit is changing, plus whatever the row already says for
 * the other one. Best-effort — a read that fails leaves the kinds untouched
 * rather than failing the foreman's edit, and the backfill picks the row up.
 */
async function markSpecKindsAfterEdit(
  id: string,
  patch: { style?: string | null; operation?: string | null },
): Promise<SpecKindColumns | null> {
  const { data, error } = await supabase
    .from("project_mark_specs")
    .select("style, operation")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const current = data as { style: string | null; operation: string | null };
  return specKindColumns({
    style: "style" in patch ? (patch.style ?? null) : current.style,
    operation: "operation" in patch ? (patch.operation ?? null) : current.operation,
  });
}

/**
 * Merge keys into a mark spec's `extra` without touching the others.
 *
 * `updateMarkSpec` writes `extra` as a whole column, so two fields that share
 * the blob (the size code and Inset/Outset) could overwrite each other's work
 * — each built its copy from state that was fresh when its row drew, and the
 * later save silently won. Re-reading before saving narrowed that window but
 * could not close it: two saves still interleave between the read and the
 * write. This does the read, the merge and the write in one statement in the
 * database, so a field can only ever speak for its own keys.
 *
 * `drop` removes keys outright — a cleared Inset/Outset or a resolved size
 * mismatch must be ABSENT, not present-and-null, because the signature
 * builder and hasAnySpec both read a present key as a value.
 */
export async function mergeMarkSpecExtra(
  id: string,
  patch: Record<string, unknown>,
  drop: string[] = [],
): Promise<void> {
  const { error } = await supabase.rpc("merge_mark_spec_extra", {
    p_id: id,
    p_patch: patch,
    p_drop: drop,
  });
  if (error) throw error;
}

/** Confirm all draft specs on a project (foreman+). */
export async function confirmMarkSpecs(projectId: string): Promise<void> {
  const { error } = await supabase
    .from("project_mark_specs")
    .update({ confirmed: true })
    .eq("project_id", projectId)
    .eq("confirmed", false);
  if (error) throw error;
}

/** Confirm a single mark spec (foreman+). */
export async function confirmMarkSpec(id: string): Promise<void> {
  const { error } = await supabase
    .from("project_mark_specs")
    .update({ confirmed: true })
    .eq("id", id);
  if (error) throw error;
}

// --- Spec/plan reconciliation: labelling a discrepancy as a known gap ---
//
// The reconciliation itself is derived and never stored (see
// `specReconciliation.ts`). Only the human answer to it is persisted, so a
// re-extract can't wipe the office's judgement.

/** True when the discrepancies table hasn't been migrated yet. */
function isMissingDiscrepanciesTable(error: unknown): boolean {
  return isMissingTable(error, "project_spec_discrepancies");
}

/** A persisted "we know about this one" label. */
export interface SpecDiscrepancyAck {
  id: string;
  project_id: string;
  mark_code: string;
  kind: DiscrepancyKind;
  note: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string;
  /**
   * 'withdrawn' rows are kept rather than deleted so the issue link below
   * survives a change of mind — that is what stops a re-label raising a second
   * issue. Absent on rows written before the issues migration; treated as
   * acknowledged.
   */
  status?: "acknowledged" | "withdrawn" | null;
  /** The trackable issue this label raised, once it has raised one. */
  issue_id?: string | null;
}

/**
 * Every discrepancy a foreman is CURRENTLY chasing on this project.
 *
 * Withdrawn labels are filtered out here rather than in the query: a row
 * written before the issues migration has no `status` at all, and filtering
 * client-side keeps that case working without a second round-trip. Best-effort
 * overall — returns [] when the table doesn't exist yet, so the report still
 * computes and simply can't be labelled until the migration lands.
 */
export async function listSpecDiscrepancyAcks(
  projectId: string,
): Promise<SpecDiscrepancyAck[]> {
  if (!projectId) return [];
  const { data, error } = await supabase
    .from("project_spec_discrepancies")
    .select("*")
    .eq("project_id", projectId);
  if (error) {
    if (isMissingDiscrepanciesTable(error)) return [];
    throw error;
  }
  return ((data ?? []) as SpecDiscrepancyAck[]).filter(
    (row) => row.status !== "withdrawn",
  );
}

/**
 * Label one discrepancy as a known supplier gap being chased, and raise a
 * trackable issue the first time (foreman+).
 *
 * SEAM: this is the single funnel through which "a human labelled a
 * discrepancy" flows, and the issue tie-in hangs off exactly here.
 *
 * The work happens inside one RPC rather than as three client writes, because
 * the dedup guarantee depends on "check the link, insert the issue, store the
 * link" being atomic. A half-completed client sequence could leave an issue
 * with no link, and the next label would then raise a duplicate — which is the
 * one thing this whole design exists to prevent.
 */
export async function acknowledgeSpecDiscrepancy(params: {
  projectId: string;
  markCode: string;
  kind: DiscrepancyKind;
  /** What the foreman typed, stored on the label. */
  note?: string | null;
  /** What the issue should say; composed by `describeDiscrepancyForIssue`. */
  issueNote?: string | null;
}): Promise<SpecDiscrepancyAck> {
  const { data, error } = await supabase.rpc("acknowledge_spec_discrepancy", {
    p_project: params.projectId,
    p_mark: params.markCode,
    p_kind: params.kind,
    p_note: params.note ?? null,
    p_issue_note: params.issueNote ?? null,
  });
  if (error) throw error;
  return data as SpecDiscrepancyAck;
}

/**
 * Take the label back off (foreman+): the discrepancy returns to the open list
 * and its issue is RESOLVED rather than deleted, so the record of what was
 * chased survives. Idempotent — withdrawing twice is a no-op.
 */
export async function unacknowledgeSpecDiscrepancy(params: {
  projectId: string;
  markCode: string;
  kind: DiscrepancyKind;
}): Promise<void> {
  const { error } = await supabase.rpc("withdraw_spec_discrepancy", {
    p_project: params.projectId,
    p_mark: params.markCode,
    p_kind: params.kind,
  });
  if (error) throw error;
}

export async function addOpening(
  projectId: string,
  opening: {
    opening_code: string;
    window_type_id?: string | null;
    label?: string | null;
    page_number?: number;
    planset_id?: string | null;
    pin_x?: number | null;
    pin_y?: number | null;
    /** Manual map dots stay confirmed so re-extract will not wipe them. */
    confirmed?: boolean;
  },
): Promise<ProjectOpening> {
  const { confirmed = true, ...rest } = opening;
  const { data, error } = await supabase
    .from("project_openings")
    .insert({ project_id: projectId, confirmed, ...rest })
    .select(OPENING_SELECT)
    .single();
  if (error) throw refusalOrError(error);
  return data;
}

/**
 * Register ONE Studio-named custom mark (W4, w-walls-spec.md) as a real
 * project mark — reusing today's EXISTING creation paths rather than a new
 * one: the schedule row (the add_project_mark RPC — same one
 * warehouse/warehouseCards.ts's addProjectMark calls; inlined here rather
 * than imported, see below), an opening carrying no planset/pin (addOpening
 * — Studio-authored, never plan-placed, so those columns are simply absent,
 * which the schema already allows), and its size. No server path already
 * creates an opening WITH a size, but none was needed either:
 * project_mark_specs already has width_in/height_in and its RLS already
 * allows a foreman+ insert (mark_specs_insert_foreman), so this is a plain
 * insert, not a migration.
 *
 * The RPC call is inlined rather than importing addProjectMark: that would
 * pull warehouseCards.ts's own import of warehouse/containment.ts (and
 * transitively storage.ts) into install/api.ts's static graph — and
 * queryClient.ts imports THIS file at its own top level, which would make
 * storage.ts eager everywhere queryClient.ts loads. prefetchWarehousePack's
 * whole contract (queryClient.prefetch.test.ts) is that storage.ts loads
 * lazily, behind a guarded dynamic import, so a bad connection at sign-in
 * can never surface as an unhandled rejection; a static edge here would
 * quietly break that guarantee. Same RPC, same params — just not the same
 * import edge.
 *
 * Sequential on purpose: the mark row first, so a later step failing never
 * leaves a size or an opening pointing at a mark_code the schedule doesn't
 * know. Registered marks then glow/assign/QC exactly like extracted ones —
 * they're real openings from here on.
 */
export async function registerCustomMark(
  projectId: string,
  payload: CustomMarkRegistrationPayload,
): Promise<void> {
  const { error: markError } = await supabase.rpc("add_project_mark", {
    p_project: projectId,
    p_mark: payload.markCode,
  });
  if (markError) throw markError;
  await addOpening(projectId, payload.opening);
  let { error } = await supabase.from("project_mark_specs").insert(payload.spec);
  if (error) {
    // Wave X's kind columns may not be on this database yet. A mark the crew
    // just named must still land; the backfill fills the kinds in later.
    const missing = missingOptionalSpecColumns(error);
    if (missing.length === 0) throw refusalOrError(error);
    ({ error } = await supabase
      .from("project_mark_specs")
      .insert(withoutColumns(payload.spec, missing)));
    if (error) throw refusalOrError(error);
  }
}

// --- Assignment + install events (RPCs) ---

export async function assignWindowToOpening(
  openingId: string,
  windowUuid: string,
): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("assign_window_to_opening", {
    p_opening_id: openingId,
    p_window_id: windowUuid,
    p_actor: await actor(),
  });
  if (error) throw error;
  return data as ProjectOpening;
}

/** Save the rough-opening measurement (smallest width/height already chosen). */
export async function setRoughOpening(
  openingId: string,
  widthIn: number,
  heightIn: number,
  check?: NonNullable<ProjectOpening["ro_check"]>,
): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("set_opening_rough_opening", {
    p_opening_id: openingId,
    p_width_in: widthIn,
    p_height_in: heightIn,
    p_actor: await actor(),
    p_check: check ?? null,
  });
  // Older database (no p_check yet): save the dimensions the old way rather
  // than losing the crew's measurement to a signature mismatch.
  if (error && /p_check|function .* does not exist/i.test(error.message ?? "")) {
    const fallback = await supabase.rpc("set_opening_rough_opening", {
      p_opening_id: openingId,
      p_width_in: widthIn,
      p_height_in: heightIn,
      p_actor: await actor(),
    });
    if (fallback.error) throw fallback.error;
    return fallback.data as ProjectOpening;
  }
  if (error) throw error;
  return data as ProjectOpening;
}

/**
 * "Quick check: all good" — the fast path beside the tape measure.
 *
 * One tap saying somebody looked at the opening, held the unit to it, and it
 * goes in (owner, 2026-09-02). It records who and when, and nothing else: the
 * server never invents width and height numbers, and saving real ones later
 * clears this flag, so a quick check can never outrank a measurement.
 */
export async function quickCheckRoughOpening(
  openingId: string,
): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("quick_check_rough_opening", {
    p_opening_id: openingId,
    p_actor: await actor(),
  });
  // The app bundle can reach a phone before the migration reaches the server;
  // deploying the backend has silently failed on this project before. There is
  // no older call to fall back to, so say what happened in words an installer
  // can act on instead of letting PostgREST's "could not find the function"
  // through to the sheet.
  if (error && isMissingFunction(error)) {
    throw new Error(
      "Quick check needs an app update that has not reached the server yet. " +
        "Nothing was changed — measure the opening and save the numbers instead.",
    );
  }
  if (error) throw error;
  return data as ProjectOpening;
}

/** Record arrival condition of the unit at the opening. Damaged flags the unit. */
export async function setOpeningCondition(
  openingId: string,
  condition: "unknown" | "ok" | "damaged",
  note?: string | null,
): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("set_opening_condition", {
    p_opening_id: openingId,
    p_condition: condition,
    p_note: note ?? null,
    p_actor: await actor(),
  });
  if (error) throw error;
  return data as ProjectOpening;
}

export interface SubmitInstallParams extends Partial<MemoTopics> {
  openingId: string;
  /** Kept for outbox back-compat and the points estimate; the SERVER
   * derives the stored minutes from sessions now (spec .scratch/sessions). */
  minutes?: number | null;
  qualityGrade?: number | null;
  transcriptRaw?: string | null;
  startedAt?: string | null;
  estimateMinutes?: number | null;
  /** The chain: the unit the clock hands off to at finish. */
  nextOpeningId?: string | null;
  /**
   * Who actually installed it, when that is not the person filing (wave Y).
   * Null — the ordinary case — is left off the wire entirely, so an ordinary
   * finish keeps making the exact call it always has.
   */
  creditedTo?: string | null;
}

/**
 * Finish = submit + the session close + the CHAIN, one server transaction
 * (finish_unit composes over submit_install_event). Minutes and start are
 * session-derived server-side; the old client-sent figures are ignored by
 * design — the hand-typed era is over.
 */
export const CREDIT_NOT_LIVE_YET =
  "This phone is newer than the app's database, so an install cannot be filed " +
  "under someone else's name yet. Let the person who installed it file it, or " +
  "try again in a few minutes.";

export async function submitInstallEvent(
  params: SubmitInstallParams,
): Promise<InstallEvent> {
  const credited = params.creditedTo ?? null;
  const args = {
    p_opening_id: params.openingId,
    p_next_opening_id: params.nextOpeningId ?? null,
    p_installer: await actor(),
    p_installer_id: await actorId(),
    p_estimate_minutes: params.estimateMinutes ?? null,
    p_quality_grade: params.qualityGrade ?? null,
    p_difficulty: params.difficulty ?? null,
    p_went_well: params.went_well ?? null,
    p_went_poorly: params.went_poorly ?? null,
    p_obstacles: params.obstacles ?? null,
    p_tools_helped: params.tools_helped ?? null,
    p_time_vs_estimate: params.time_vs_estimate ?? null,
    p_safety_notes: params.safety_notes ?? null,
    p_do_again: params.do_again ?? null,
    p_transcript_raw: params.transcriptRaw ?? null,
  };
  // `p_credited_to` rides ONLY when there is a credit to name. A finish of your
  // own work therefore makes the same fifteen-argument call it always did, so a
  // phone running ahead of the migration still finishes units — which is the
  // rule for every feature here.
  const { data, error } = await supabase.rpc(
    "finish_unit",
    credited ? { ...args, p_credited_to: credited } : args,
  );
  if (error) {
    // A database without the wider form. We could file this under the person
    // holding the phone and say nothing, but that is the exact wrong record —
    // the one this whole wave exists to stop. Refuse, and say why in words.
    //
    // Marked permanent so the outbox treats it as a verdict rather than a bad
    // signal: retrying every thirty seconds would put a "saved on this device"
    // toast in front of somebody whose install is not going anywhere until the
    // migration lands.
    if (credited && isMissingSchemaFunction(error)) {
      const refusal = new Error(CREDIT_NOT_LIVE_YET) as Error & { permanent?: boolean };
      refusal.permanent = true;
      throw refusal;
    }
    throw error;
  }
  return data as InstallEvent;
}

/**
 * Undo/reclaim an install (foreman+). Voids the install event (keeps history —
 * memos, photos, grade and minutes all survive on the voided row), reverts the
 * opening to assigned/planned, returns the unit to the truck, voids points and
 * opens a failed-install issue. The REASON is required — it is the record's
 * whole value, and the server refuses without it.
 */
export async function undoInstall(
  openingId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc("undo_install", {
    p_opening_id: openingId,
    p_reason: reason,
  });
  if (error) throw error;
}

/** The voided installs on one opening — why it came back off the wall. */
export interface UndoneInstall {
  id: string;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
  minutes: number | null;
  quality_grade: number | null;
  installer: string | null;
  voider?: { display_name: string } | null;
}

export async function listUndoneInstalls(openingId: string): Promise<UndoneInstall[]> {
  const { data, error } = await supabase
    .from("install_events")
    .select(
      "id, created_at, voided_at, void_reason, minutes, quality_grade, installer, voider:voided_by(display_name)",
    )
    .eq("project_opening_id", openingId)
    .not("voided_at", "is", null)
    .order("voided_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as UndoneInstall[];
}

export interface FailedInstall {
  event_id: string;
  opening_id: string;
  opening_code: string;
  installer: string | null;
  voided_at: string;
  void_reason: string | null;
  voided_by_name: string | null;
  created_at: string;
}

export interface ProjectExceptions {
  /** Installs that were undone/reverted — data preserved for review. */
  failedInstalls: FailedInstall[];
  /** Openings a crew member flagged for the lead, or that arrived damaged. */
  flaggedOpenings: ProjectOpening[];
}

/**
 * Opening ids on a project that carry a voided (failed/undone) install event.
 * Failed-install visibility is foreman+ only, so callers pass `canSee` (their
 * foreman+ guard); a non-foreman caller short-circuits to an empty set and
 * never fetches the data. (Full RLS hardening is a later follow-up.)
 */
export async function listVoidedInstallOpeningIds(
  projectId: string,
  canSee = true,
): Promise<Set<string>> {
  if (!canSee) return new Set<string>();
  const { data, error } = await supabase
    .from("install_events")
    .select("project_opening_id, project_openings:project_opening_id!inner(project_id)")
    .not("voided_at", "is", null)
    .eq("project_openings.project_id", projectId);
  if (error) throw error;
  const rows = (data ?? []) as unknown as { project_opening_id: string }[];
  return new Set(rows.map((r) => r.project_opening_id));
}

/**
 * Exceptions view for foreman+: failed/undone installs (preserved), flagged
 * openings, and damaged-condition openings on this job.
 */
export async function listProjectExceptions(
  projectId: string,
  canSee = true,
): Promise<ProjectExceptions> {
  if (!canSee) return { failedInstalls: [], flaggedOpenings: [] };
  // A data-off flag can carry a reason and NO note (wave E) — a note is
  // optional on the card and the reason is the message. Asking only about
  // flag_note therefore missed the ordinary case the wave introduced: the
  // foreman's exceptions list stayed empty while the map went amber.
  const flaggedWhere = "flag_kind.not.is.null,flag_note.not.is.null,condition.eq.damaged";
  const flaggedWhereNoKind = "flag_note.not.is.null,condition.eq.damaged";
  const flaggedQuery = (where: string) =>
    supabase
      .from("project_openings")
      .select(OPENING_SELECT)
      .eq("project_id", projectId)
      .or(where)
      .order("opening_code");
  const [flaggedFirst, voidedRes] = await Promise.all([
    flaggedQuery(flaggedWhere),
    supabase
      .from("install_events")
      .select(
        "id, installer, voided_at, void_reason, created_at, project_opening_id, " +
          "project_openings:project_opening_id!inner(opening_code, project_id), " +
          "voided_by_profile:voided_by(display_name)",
      )
      .not("voided_at", "is", null)
      .eq("project_openings.project_id", projectId)
      .order("voided_at", { ascending: false }),
  ]);
  // A phone ahead of the migration asks about a column the server has not got.
  // Peel back to the question it can answer rather than throwing the whole
  // exceptions screen away: on that database every flag has a note anyway.
  const flaggedRes =
    flaggedFirst.error && isMissingColumn(flaggedFirst.error, "flag_kind")
      ? await flaggedQuery(flaggedWhereNoKind)
      : flaggedFirst;
  if (flaggedRes.error) throw flaggedRes.error;
  if (voidedRes.error) throw voidedRes.error;

  type VoidedRow = {
    id: string;
    installer: string | null;
    voided_at: string;
    void_reason: string | null;
    created_at: string;
    project_opening_id: string;
    project_openings: { opening_code: string } | null;
    voided_by_profile: { display_name: string } | null;
  };
  const voidedRows = (voidedRes.data ?? []) as unknown as VoidedRow[];

  const failedInstalls: FailedInstall[] = voidedRows.map((e) => ({
    event_id: e.id,
    opening_id: e.project_opening_id,
    opening_code: e.project_openings?.opening_code ?? "?",
    installer: e.installer ?? null,
    voided_at: e.voided_at,
    void_reason: e.void_reason ?? null,
    voided_by_name: e.voided_by_profile?.display_name ?? null,
    created_at: e.created_at,
  }));

  return {
    failedInstalls,
    flaggedOpenings: (flaggedRes.data ?? []) as ProjectOpening[],
  };
}

// --- Type brain ---

export interface TypeBrainStats {
  type: WindowType | null;
  installCount: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
  avgGrade: number | null;
  failRate: number | null;
  outcomeDifficulty: number | null;
  tips: string[];
  watchOuts: string[];
  recent: InstallEvent[];
  photos: { id: string; storage_path: string; signedUrl: string | null }[];
  voiceMemos: { id: string; storage_path: string; signedUrl: string | null; created_at: string }[];
  videos: { id: string; signedUrl: string | null }[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function signedMedia(
  storagePath: string,
): Promise<string | null> {
  const slash = storagePath.indexOf("/");
  const bucket = slash >= 0 ? storagePath.slice(0, slash) : "install-media";
  const path = slash >= 0 ? storagePath.slice(slash + 1) : storagePath;
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, 3600);
  if (error) return null;
  return data.signedUrl;
}

export async function getTypeBrainStats(
  typeId: string,
): Promise<TypeBrainStats> {
  const [typeRes, eventsRes] = await Promise.all([
    supabase.from("window_types").select("*").eq("id", typeId).maybeSingle(),
    supabase
      .from("install_events")
      .select("*")
      .eq("window_type_id", typeId)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);
  if (typeRes.error) throw typeRes.error;
  if (eventsRes.error) throw eventsRes.error;

  const events = eventsRes.data as InstallEvent[];
  const minutes = events
    .map((e) => e.minutes)
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);
  const grades = events
    .map((e) => e.quality_grade)
    .filter((g): g is number => g !== null);
  const fails = grades.filter((g) => g <= 2).length;

  const eventIds = events.map((e) => e.id);
  let photos: TypeBrainStats["photos"] = [];
  let voiceMemos: TypeBrainStats["voiceMemos"] = [];
  let videos: TypeBrainStats["videos"] = [];
  if (eventIds.length > 0) {
    const goldenId = (typeRes.data as WindowType | null)?.golden_install_event_id;
    const { data: media, error: mediaErr } = await supabase
      .from("attachments")
      .select("id, kind, storage_path, created_at, install_event_id")
      .in("install_event_id", eventIds.slice(0, 50))
      .in("kind", ["photo", "voice_memo", "video"])
      .order("created_at", { ascending: false })
      .limit(40);
    if (mediaErr) throw mediaErr;
    const photoRows = (media ?? []).filter((m) => m.kind === "photo").slice(0, 12);
    const voiceRows = (media ?? []).filter((m) => m.kind === "voice_memo").slice(0, 5);
    // Prefer the golden install's video first.
    const videoRows = (media ?? [])
      .filter((m) => m.kind === "video")
      .sort((a, b) =>
        (b.install_event_id === goldenId ? 1 : 0) -
        (a.install_event_id === goldenId ? 1 : 0),
      )
      .slice(0, 3);
    photos = await Promise.all(
      photoRows.map(async (m) => ({
        id: m.id,
        storage_path: m.storage_path,
        signedUrl: await signedMedia(m.storage_path),
      })),
    );
    voiceMemos = await Promise.all(
      voiceRows.map(async (m) => ({
        id: m.id,
        storage_path: m.storage_path,
        signedUrl: await signedMedia(m.storage_path),
        created_at: m.created_at,
      })),
    );
    videos = await Promise.all(
      videoRows.map(async (m) => ({
        id: m.id,
        signedUrl: await signedMedia(m.storage_path),
      })),
    );
  }

  const type = typeRes.data as WindowType | null;
  const tips = Array.isArray(type?.tips_json) ? type!.tips_json! : [];
  const watchOuts = Array.isArray(type?.watch_outs_json)
    ? type!.watch_outs_json!
    : [];

  // Prefer the persisted rollups (same numbers dispatch + estimates use);
  // fall back to live computation when the trigger hasn't populated them yet.
  const liveMedian = percentile(minutes, 0.5);
  const liveP90 = percentile(minutes, 0.9);
  const liveAvg =
    grades.length === 0
      ? null
      : Math.round((grades.reduce((s, g) => s + g, 0) / grades.length) * 10) / 10;
  const liveFail =
    grades.length === 0 ? null : Math.round((fails / grades.length) * 1000) / 10;

  return {
    type,
    installCount: type?.n_installs ?? events.length,
    medianMinutes: type?.median_minutes ?? liveMedian,
    p90Minutes: type?.p90_minutes ?? liveP90,
    avgGrade: type?.avg_grade ?? liveAvg,
    failRate: type?.fail_rate ?? liveFail,
    outcomeDifficulty:
      type?.learned_difficulty ??
      type?.outcome_difficulty ??
      type?.difficulty_rating ??
      null,
    tips: tips.slice(0, 5),
    watchOuts: watchOuts.slice(0, 5),
    recent: events.slice(0, 10),
    photos,
    voiceMemos,
    videos,
  };
}

/** Invoke Edge Function to extract schedule rows via GPT when deterministic parse finds nothing. */
export async function aiExtractSchedule(
  pages: { pageNumber: number; text: string }[],
  catalog: { type_code: string; name: string }[],
  // Page images flip the read to VISION (the RAC-OAK-5 lesson, 2026-08-20):
  // cut-sheet plansets carry their truth as pictured cells with a QTY field,
  // and only a vision read can honor "count exactly what is pictured".
  images?: { pageNumber: number; dataUrl: string }[],
): Promise<{ rows: ScheduleRowLike[]; failedPages: number[] }> {
  const { data, error } = await supabase.functions.invoke("extract-schedule", {
    body: { pages, catalog, images: images ?? [] },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return {
    rows: (data?.rows ?? []) as ScheduleRowLike[],
    failedPages: (data?.failed_pages ?? []) as number[],
  };
}

export interface ScheduleRowLike {
  openingCode: string;
  typeText: string;
  qty: number;
  label: string | null;
  pageNumber: number;
  widthIn?: number | null;
  heightIn?: number | null;
  color?: string | null;
  kind?: "window" | "door";
}

/** One mark's schedule identity, fed to extract-placement as the allowlist it
 * must match exactly — CAD-WINS: it places existing marks, it never invents one. */
export interface KnownMarkLike {
  code: string;
  type?: string | null;
}

/** Where extract-placement found (or didn't find) a known mark on the plan. */
export interface PlacementRowLike {
  mark: string;
  page: number;
  x: number;
  y: number;
  confidence: number;
}

/** A plan callout that matched no known mark — reported, never turned into an
 * opening (see supabase/functions/extract-placement). */
export interface UnknownMarkLike {
  mark: string;
  page: number;
}

/** Invoke the vision-placement Edge Function (wave V-A): find where each
 * still-unplaced schedule mark's callout sits on a floor-plan page. */
export async function aiExtractPlacement(
  images: { pageNumber: number; dataUrl: string }[],
  marks: KnownMarkLike[],
  projectId?: string,
  plansetId?: string,
): Promise<{
  placements: PlacementRowLike[];
  unknownMarks: UnknownMarkLike[];
  failedPages: number[];
  limited?: boolean;
  note?: string | null;
}> {
  const { data, error } = await supabase.functions.invoke("extract-placement", {
    body: { images, marks, projectId, plansetId },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return {
    placements: (data?.placements ?? []) as PlacementRowLike[],
    unknownMarks: (data?.unknownMarks ?? []) as UnknownMarkLike[],
    failedPages: (data?.failedPages ?? []) as number[],
    limited: Boolean(data?.limited),
    note: data?.note ?? null,
  };
}

/** True when 20260961000000 (suggested placements) hasn't reached this database
 * yet — the review tray degrades to "nothing to review" rather than crashing.
 * PGRST202/42883 is PostgREST's own "function not in schema cache" — the SAME
 * signal a genuinely-missing migration gives right after one that DID land,
 * because PostgREST caches the function list and only reloads it on its own
 * schema-reload notification. A deploy whose reload hook fires late (this
 * project's history: "Deploy backend" silently failing) leaves a window where
 * the function exists in Postgres but PostgREST still answers as if it
 * doesn't — the Mad Moose shape: extract-placement (a separate Edge Function
 * deploy) already found and matched every mark, but the very next call, to a
 * database RPC added by the SAME migration, still 404s. */
function isMissingPlacementFunction(error: unknown): boolean {
  return isMissingSchemaFunction(error);
}

/**
 * Write extract-placement's raw reading into suggested_pin_x/y/page/at/
 * confidence (foreman+; RESCAN LAW enforced atomically in SQL — see
 * apply_placement_suggestions). `saved` is how many suggestions actually
 * landed — smaller than the input whenever a mark already has a real pin.
 *
 * `unavailable` is kept SEPARATE from `saved` on purpose (the Mad Moose bug):
 * isMissingPlacementFunction's degrade-instead-of-crash guard means `saved`
 * is 0 for two very different reasons — "every mark already had a real pin"
 * (the rescan law; expected, nothing to do) and "the write path isn't live
 * on this database yet" (isMissingPlacementFunction; the marks still need
 * saving, and will, once the schema catches up). Collapsing both into a bare
 * saved-count is exactly what let a caller tell a foreman "already placed"
 * when the true story was "couldn't write yet" — the wrong instruction for
 * what to do next.
 */
export async function applyPlacementSuggestions(
  projectId: string,
  suggestions: {
    openingId: string;
    x: number;
    y: number;
    page: number;
    confidence: number;
  }[],
): Promise<{ saved: number; unavailable: boolean }> {
  if (suggestions.length === 0) return { saved: 0, unavailable: false };
  const { data, error } = await supabase.rpc("apply_placement_suggestions", {
    p_project_id: projectId,
    p_suggestions: suggestions.map((s) => ({
      opening_id: s.openingId,
      x: s.x,
      y: s.y,
      page: s.page,
      confidence: s.confidence,
    })),
  });
  if (error) {
    if (isMissingPlacementFunction(error)) return { saved: 0, unavailable: true };
    throw refusalOrError(error);
  }
  return { saved: Number(data) || 0, unavailable: false };
}

/**
 * Install events by this installer whose AI-filled memo still needs a glance.
 *
 * Deliberately NOT switched to coalesce(credited_to, installer_id) in wave Y:
 * the memo is a recording of what the person who FILED it dictated, and the
 * confirm step is "read back what the AI heard you say". Handing Sam somebody
 * else's dictation to approve would be asking him to vouch for words he never
 * spoke.
 */
export async function listMemosToConfirm(
  installerId: string,
): Promise<InstallEvent[]> {
  const { data, error } = await supabase
    .from("install_events")
    .select("*, window_types(type_code, name)")
    .eq("installer_id", installerId)
    .not("transcript_raw", "is", null)
    .eq("ai_confirmed", false)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as InstallEvent[];
}

export async function confirmInstallMemo(
  eventId: string,
  patch: Partial<MemoTopics> & { quality_grade?: number | null },
): Promise<void> {
  const { error } = await supabase
    .from("install_events")
    .update({ ...patch, ai_confirmed: true })
    .eq("id", eventId);
  if (error) throw error;
}

/** Invoke tip synthesis for one type (or all eligible types when typeId omitted). */
export async function synthesizeTypeTips(
  typeId?: string,
): Promise<{ results: { type_code: string; updated: boolean; installs: number }[] }> {
  const { data, error } = await supabase.functions.invoke("synthesize-type-tips", {
    body: typeId ? { type_id: typeId, min_installs: 3 } : { min_installs: 3 },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return data as {
    results: { type_code: string; updated: boolean; installs: number }[];
  };
}

/** Generate/refresh the AI how-to for a type from its golden install + tips. */
export async function generateHowto(typeId: string): Promise<void> {
  const { error } = await supabase.functions.invoke("generate-howto", {
    body: { type_id: typeId },
  });
  if (error) throw error;
}

/** Lead-editable knowledge on a type (tips, watch-outs, how-to steps). */
export async function updateTypeKnowledge(
  typeId: string,
  patch: {
    tips_json?: string[];
    watch_outs_json?: string[];
    howto_json?: import("../types").HowtoStep[];
  },
): Promise<void> {
  const { error } = await supabase.from("window_types").update(patch).eq("id", typeId);
  if (error) throw error;
}

export async function setGoldenInstall(
  typeId: string,
  eventId: string,
): Promise<void> {
  const { error } = await supabase.rpc("set_golden_install", {
    p_type_id: typeId,
    p_event_id: eventId,
  });
  if (error) throw error;
}

/** Fire-and-forget transcription after a voice attachment lands. */
export async function requestTranscription(attachmentId: string): Promise<void> {
  const { error } = await supabase.functions.invoke("transcribe-install-memo", {
    body: { attachment_id: attachmentId },
  });
  if (error) {
    console.warn("transcribe invoke failed", error);
  }
}
