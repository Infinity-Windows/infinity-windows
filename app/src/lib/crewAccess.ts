/**
 * Reading and changing who has access to the app.
 *
 * Every write here is a thin wrapper over the `manage-crew-access` edge
 * function, because creating a login needs the service-role key and that key
 * must never reach a browser. Nothing in this file is a security control: the
 * function re-derives the caller's role from the database and re-checks every
 * rule. The role checks the UI does (via canInviteRole) are only there to grey
 * out a button before the server has to say no.
 *
 * The two reads go straight to Postgres under row-level security — the invites
 * policy is supervisor-or-above, and `code_hash` is revoked from every client
 * role at the column level, so a code cannot be read back out even by the owner.
 */
import { supabase } from "./supabase";
import type {
  CrewInviteRow,
  CrewRoleName,
} from "../../../supabase/functions/_shared/crewInvites";
import type {
  HistoryCounts,
  PurgeShape,
} from "../../../supabase/functions/_shared/purgeLogin";
import { isMissingColumn } from "./schemaErrors";

/** One person who has (or had) a login. */
export interface CrewAccessMember {
  id: string;
  display_name: string | null;
  role: string | null;
  active: boolean | null;
  /** Non-null means their login has been switched off. */
  access_revoked_at: string | null;
  /**
   * Non-null means the login was removed for good and its email handed back —
   * there is nothing to switch back on. Absent (rather than null) on a database
   * that predates 20260987000000.
   */
  retired_at?: string | null;
  retired_by?: string | null;
  created_at: string | null;
}

/** What `manage-crew-access` hands back after minting a code. */
export interface IssuedInvite {
  /** Shown once. Never stored, never fetched again — the server keeps only a hash. */
  code: string;
  invite: CrewInviteRow;
}

/**
 * A non-2xx from an edge function arrives as a FunctionsHttpError whose message
 * is the useless "Edge Function returned a non-2xx status code". The sentence
 * the user needs — "You can't invite someone as Owner" — is in the response
 * body, so dig it out. Matches the handling in lib/install/api.ts, and is the
 * reason this never surfaces as `[object Object]`.
 */
async function invokeCrewAccess<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("manage-crew-access", {
    body,
  });
  if (error) {
    const context = (error as { context?: Response }).context;
    if (context && typeof context.json === "function") {
      const parsed = await context.json().catch(() => null);
      if (parsed?.error) throw new Error(String(parsed.error));
    }
    throw error;
  }
  if (data?.error) throw new Error(String(data.error));
  return data as T;
}

const ACCESS_COLS =
  "id, display_name, role, active, access_revoked_at, retired_at, retired_by, created_at";
/** The same list before 20260987000000 widened the view. */
const ACCESS_COLS_WITHOUT_RETIRED = ACCESS_COLS.replace(
  ", retired_at, retired_by",
  "",
);

/**
 * Everyone with a profile, by name.
 *
 * The retired columns are asked for and dropped on a database that has not had
 * 20260987000000 yet: the frontend and the backend deploy as separate
 * workflows and the backend one has silently failed before, so "the app is live
 * and the migration is not" is a state that really happens. Failing the read
 * would take the whole Crew access screen — including Add someone — down with
 * it, which is a worse answer than a screen with no Remove-for-good button.
 */
export async function listCrewAccess(): Promise<CrewAccessMember[]> {
  const read = (cols: string) =>
    supabase.from("crew_access_directory").select(cols).order("display_name");
  const first = await read(ACCESS_COLS);
  if (first.error && isMissingColumn(first.error, "retired_at")) {
    const second = await read(ACCESS_COLS_WITHOUT_RETIRED);
    if (second.error) throw second.error;
    return (second.data ?? []) as unknown as CrewAccessMember[];
  }
  if (first.error) throw first.error;
  return (first.data ?? []) as unknown as CrewAccessMember[];
}

/**
 * Every invite, newest first. Redeemed and revoked ones are kept and shown as
 * history rather than hidden: "did I already send Mike a code?" is the question
 * this screen exists to answer.
 */
export async function listCrewInvites(): Promise<CrewInviteRow[]> {
  const { data, error } = await supabase
    .from("crew_invites")
    .select(
      "id, display_name, email, role, target_user_id, invited_by, created_at, expires_at, redeemed_at, redeemed_user_id, revoked_at, revoked_by",
    )
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as CrewInviteRow[];
}

export async function createCrewInvite(args: {
  display_name: string;
  role: CrewRoleName;
  /** Optional. Left blank, the server mints a login that cannot receive mail. */
  email?: string;
}): Promise<IssuedInvite> {
  return await invokeCrewAccess<IssuedInvite>({
    action: "create_invite",
    display_name: args.display_name,
    role: args.role,
    email: args.email?.trim() || undefined,
  });
}

/** Kill the old code and mint a new one for the same person and role. */
export async function resendCrewInvite(inviteId: string): Promise<IssuedInvite> {
  return await invokeCrewAccess<IssuedInvite>({
    action: "resend_invite",
    invite_id: inviteId,
  });
}

export async function revokeCrewInvite(inviteId: string): Promise<void> {
  await invokeCrewAccess({ action: "revoke_invite", invite_id: inviteId });
}

/**
 * The way back in for someone who forgot their password. "Reset password" on the
 * sign-in screen sends an email and this project has no mail sender, so without
 * this a forgotten password needs a developer.
 */
export async function reissueCrewLogin(userId: string): Promise<IssuedInvite> {
  return await invokeCrewAccess<IssuedInvite>({
    action: "reissue_login",
    user_id: userId,
  });
}

/** Switch a login off. Their history is kept — see the migration on why. */
export async function removeCrewAccess(userId: string): Promise<void> {
  await invokeCrewAccess({ action: "remove_access", user_id: userId });
}

export async function restoreCrewAccess(userId: string): Promise<void> {
  await invokeCrewAccess({ action: "restore_access", user_id: userId });
}

/** What "Remove this login…" is about to do, before it does any of it. */
export interface PurgePreview {
  user_id: string;
  display_name: string | null;
  counts: HistoryCounts;
  shape: PurgeShape;
}

/**
 * Count what this person has on file and say which of the two things would
 * happen. Read-only — it writes nothing, and it runs every refusal the real
 * call would, so the confirm sheet never promises something the next tap
 * refuses.
 */
export async function previewPurgeLogin(userId: string): Promise<PurgePreview> {
  return await invokeCrewAccess<PurgePreview>({
    action: "purge_login_preview",
    user_id: userId,
  });
}

export interface PurgeResult {
  shape: PurgeShape;
  email_released: boolean;
  display_name: string | null;
}

/**
 * Remove a login for good.
 *
 * Nothing on file → the account is deleted and the email is free. Anything on
 * file → nothing is deleted: the login is closed, the email is handed back, and
 * every record stays under the same profile. The server decides which, by
 * counting — see supabase/functions/_shared/purgeLogin.ts — and says which it
 * did, so the screen reports what happened rather than what it expected.
 */
export async function purgeCrewLogin(userId: string): Promise<PurgeResult> {
  return await invokeCrewAccess<PurgeResult>({
    action: "purge_login",
    user_id: userId,
  });
}

export interface InvitePreview {
  display_name: string;
  role: string;
  expires_at: string;
  existing_account: boolean;
}

/**
 * What this code is for, without spending it. Lets the join screen greet the
 * person by name and show the role, so a mistyped code fails before they have
 * invented a password rather than after.
 */
export async function peekCrewInvite(code: string): Promise<InvitePreview> {
  const { data, error } = await supabase.functions.invoke(
    "redeem-crew-invite",
    { body: { action: "peek", code } },
  );
  if (error) {
    const context = (error as { context?: Response }).context;
    if (context && typeof context.json === "function") {
      const parsed = await context.json().catch(() => null);
      if (parsed?.error) throw new Error(String(parsed.error));
    }
    throw error;
  }
  if (data?.error) throw new Error(String(data.error));
  return data as InvitePreview;
}

/**
 * Redeem a code. Called with no session — the person doing it has no account
 * yet — and then signs them straight in with the password they just chose, so
 * they land inside the app rather than on a sign-in form.
 */
export async function redeemCrewInvite(
  code: string,
  password: string,
): Promise<{ email: string; display_name: string; role: string }> {
  const { data, error } = await supabase.functions.invoke(
    "redeem-crew-invite",
    { body: { code, password } },
  );
  if (error) {
    const context = (error as { context?: Response }).context;
    if (context && typeof context.json === "function") {
      const parsed = await context.json().catch(() => null);
      if (parsed?.error) throw new Error(String(parsed.error));
    }
    throw error;
  }
  if (data?.error) throw new Error(String(data.error));

  const result = data as { email: string; display_name: string; role: string };
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: result.email,
    password,
  });
  // The account exists at this point, so failing here is a bad session rather
  // than a bad invite; say so instead of implying the code was wrong.
  if (signInError) {
    throw new Error(
      `Your login was created, but signing in failed: ${signInError.message}. Try signing in with ${result.email}.`,
    );
  }
  return result;
}
