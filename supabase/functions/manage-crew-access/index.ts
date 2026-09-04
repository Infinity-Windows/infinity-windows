/**
 * Who has access to Forge Windows, and who is being offered it.
 *
 * The owner needs to add his own crew. Creating a login requires the
 * service-role key, which must never reach a browser, so this is an edge
 * function. It is the only writer of `public.crew_invites` other than
 * redeem-crew-invite — no client role holds an INSERT, UPDATE or DELETE grant on
 * that table at all (see the migration).
 *
 * THE ONE RULE THIS FUNCTION EXISTS TO ENFORCE
 *
 * An invite says "create an account at role X". That is the same power as
 * promoting somebody, so it carries the same ladder: the caller must be a
 * supervisor or the owner, and may never name a role above their own rank.
 *
 * The caller's rank is read from `public.profiles` on the service-role key,
 * against the user id from a verified JWT. NOTHING about the caller is taken
 * from the request body — no role, no user id, no "I am an owner" flag. A
 * hostile caller who posts straight at this endpoint with a valid installer
 * session gets the installer's answer, which is no. Assume that caller exists;
 * greying out a button in the UI is not a control.
 *
 * Three independent layers say the same thing, so no single edit re-opens it:
 *   1. here, from profiles.role;
 *   2. a BEFORE INSERT trigger on crew_invites comparing the stored role of
 *      `invited_by` (which the client cannot set);
 *   3. the invite's role is copied onto the new profile by redeem-crew-invite,
 *      which reads it from the row, never from the redeemer.
 *
 * WHY REMOVING ACCESS IS A BAN AND NOT A DELETE. A crew member who leaves is
 * still the author of production history — shifts, installs, QC sign-offs, chat.
 * Deleting the auth user would cascade or orphan it. Banning ends the login and
 * keeps the record, which is the right trade for a company that may have to
 * answer "who installed this window".
 *
 * THE THIRD DOOR: `purge_login`. `remove_access` above closes a login and
 * leaves everything else exactly as it was — including the email address,
 * which auth.users holds unique forever, so the same person can never be
 * invited again. `purge_login` is the owner's "remove this login and start
 * fresh": it frees the address either way, and it chooses between deleting the
 * account outright and retiring it BY COUNTING THE ROWS, not by asking. The
 * cascade / set-null / restrict facts that force that split are written out in
 * _shared/purgeLogin.ts; read that before touching this.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";
import { verifyCaller } from "../_shared/auth.ts";
import { isTestAccount, TEST_ACCOUNT_REFUSED } from "../_shared/testAccounts.ts";
import {
  canInviteRole,
  canManageMember,
  crewLoginFromName,
  generateInviteCode,
  hashInviteCode,
  inviteExpiryFrom,
  isRedeemable,
  roleRank,
} from "../_shared/crewInvites.ts";
import {
  type HistoryCounts,
  probeKey,
  type PurgeShape,
  shapeFor,
  tombstoneEmail,
  WORK_HISTORY_PROBES,
} from "../_shared/purgeLogin.ts";

type ServiceClient = ReturnType<typeof createClient>;

/** Long enough that a "ban" is permanent in practice; reversible by unbanning. */
const FOREVER = "876000h"; // 100 years

interface InviteRecord {
  id: string;
  display_name: string;
  email: string;
  role: string;
  target_user_id: string | null;
  expires_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
}

async function profileRole(
  supabase: ServiceClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (error) return null;
  return (data?.role as string | undefined) ?? null;
}

/** listUsers is paginated; ask for the page holding this address. */
async function findUserByEmail(
  supabase: ServiceClient,
  email: string,
): Promise<{ id: string } | null> {
  const wanted = email.trim().toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw new Error(error.message);
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === wanted);
    if (hit) return { id: hit.id };
    if (data.users.length < 200) return null;
  }
  return null;
}

/**
 * Mint a code, store only its hash, and hand the plaintext back exactly once.
 * Any still-live invite for the same person is revoked in the same breath, so
 * "resend" cannot leave two working codes for one seat behind.
 */
async function issueInvite(
  supabase: ServiceClient,
  args: {
    displayName: string;
    email: string;
    role: string;
    invitedBy: string | null;
    targetUserId: string | null;
  },
): Promise<{ code: string; invite: InviteRecord }> {
  const { data: live } = await supabase
    .from("crew_invites")
    .select("id, expires_at, redeemed_at, revoked_at")
    .eq("email", args.email)
    .is("redeemed_at", null)
    .is("revoked_at", null);

  for (const row of (live ?? []) as InviteRecord[]) {
    if (isRedeemable(row)) {
      await supabase
        .from("crew_invites")
        .update({ revoked_at: new Date().toISOString(), revoked_by: args.invitedBy })
        .eq("id", row.id);
    }
  }

  const code = generateInviteCode();
  const { data, error } = await supabase
    .from("crew_invites")
    .insert({
      code_hash: await hashInviteCode(code),
      display_name: args.displayName,
      email: args.email,
      role: args.role,
      target_user_id: args.targetUserId,
      invited_by: args.invitedBy,
      expires_at: inviteExpiryFrom().toISOString(),
    })
    .select(
      "id, display_name, email, role, target_user_id, expires_at, redeemed_at, revoked_at",
    )
    .single();
  if (error) throw new Error(error.message);
  return { code, invite: data as unknown as InviteRecord };
}

interface PurgeTarget {
  id: string;
  display_name: string | null;
  role: string;
  is_partner: boolean;
}

interface MemberRow {
  id: string;
  display_name: string;
  role: string;
  access_revoked_at: string | null;
  /** Absent on a database that predates 20260987000000 — see below. */
  retired_at?: string | null;
}

/**
 * One crew member, with `retired_at` when the database has it.
 *
 * The backend deploys as its own workflow and has silently failed before, so
 * "the app is live and the migration is not" is a state that really happens.
 * Asking for a column that isn't there 400s the whole read, which would take
 * "New password code" and "Let them back in" down for everybody — so the wide
 * read is tried once and the narrow one answers if it fails.
 */
async function readMember(
  supabase: ServiceClient,
  userId: string,
): Promise<MemberRow | null> {
  const wide = await supabase
    .from("profiles")
    .select("id, display_name, role, access_revoked_at, retired_at")
    .eq("id", userId)
    .maybeSingle();
  if (!wide.error) return wide.data as unknown as MemberRow | null;
  const narrow = await supabase
    .from("profiles")
    .select("id, display_name, role, access_revoked_at")
    .eq("id", userId)
    .maybeSingle();
  return narrow.data as unknown as MemberRow | null;
}

/** The one sentence a removed login gets, wherever somebody tries to revive it. */
const ALREADY_REMOVED =
  'That login was removed for good, so there is nothing to switch back on. Add them again under "Add someone" and they\'ll get a fresh login.';

/**
 * One count per table, taken on the SERVICE-ROLE key so row-level security
 * cannot hide a row and make a person look emptier than they are — the whole
 * decision below hangs on these numbers being complete.
 *
 * `head: true, count: "exact"` asks Postgres for the number without shipping
 * the rows: nineteen counts on a phone, not nineteen table scans down the wire.
 *
 * A count that FAILS is recorded as 1, never 0. A table that does not exist yet
 * (this app ships features ahead of their migrations) genuinely has no rows and
 * is skipped; anything else — a permission error, a timeout — means "we do not
 * know", and the only safe answer to not knowing is "there is history here",
 * because that keeps the record instead of deleting it.
 */
async function countHistory(
  supabase: ServiceClient,
  userId: string,
): Promise<HistoryCounts> {
  const counts: HistoryCounts = {};
  for (const probe of WORK_HISTORY_PROBES) {
    const { count, error } = await supabase
      .from(probe.table)
      .select(probe.column, { count: "exact", head: true })
      .eq(probe.column, userId);
    if (error) {
      const message = `${error.message ?? ""} ${(error as { code?: string }).code ?? ""}`;
      // PGRST205 / 42P01: the table is not in this database yet. Really zero.
      const missing = /PGRST205|42P01|does not exist|could not find the table/i
        .test(message);
      counts[probeKey(probe)] = missing ? 0 : 1;
      continue;
    }
    counts[probeKey(probe)] = count ?? 0;
  }
  return counts;
}

/**
 * Everything that refuses a purge, in one place so the preview and the real
 * thing cannot drift: the preview must be able to say "this is not going to
 * work" before the owner commits to a sentence that promises it will.
 *
 * Returns null when the purge may go ahead.
 */
async function purgeRefusal(
  supabase: ServiceClient,
  args: {
    target: PurgeTarget;
    callerId: string | null;
    callerRole: string | null;
    callerIsService: boolean;
  },
): Promise<{ error: string; status: number } | null> {
  const { target, callerId, callerRole, callerIsService } = args;

  // Removing your own login would leave you signed in to an account that no
  // longer exists, with nobody able to let you back in.
  if (callerId && target.id === callerId) {
    return { error: "You can't remove your own login.", status: 400 };
  }

  // Owner-only, one rung above remove_access. Closing a login is reversible;
  // this one frees the email and may delete the account outright.
  if (!callerIsService && roleRank(callerRole) < 3) {
    return {
      error:
        "Only the owner can remove a login for good. A supervisor can switch someone's access off instead.",
      status: 403,
    };
  }
  const verdict = canManageMember(callerRole, target.role);
  if (!verdict.ok) return { error: verdict.message, status: 403 };

  // A builder's login is not a crew login and is not managed from this screen —
  // it is granted and taken away with the job grants, and deleting one here
  // would silently drop a builder off jobs nobody on this screen can see.
  if (target.is_partner) {
    return {
      error:
        "That's a builder's login, not a crew login. Take it away from the builder's own jobs instead.",
      status: 409,
    };
  }

  // Never lock the company out of its own app — the same rule remove_access
  // carries, and it matters more here because there is no undo.
  if (roleRank(target.role) >= 3) {
    const { data: owners } = await supabase
      .from("profiles")
      .select("id, role, access_revoked_at")
      .in("role", ["owner", "big_boss"])
      .is("access_revoked_at", null);
    const remaining = (owners ?? []).filter(
      (o) => (o as { id: string }).id !== target.id,
    ).length;
    if (remaining === 0) {
      return {
        error:
          "That is the last owner with access. Make someone else an owner first, or nobody could let anyone back in.",
        status: 409,
      };
    }
  }
  return null;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const auth = await verifyCaller(req);
  if (auth.status === "unauthorized") {
    return jsonResponse({ error: "unauthorized" }, 401, cors);
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase env not configured");
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const callerId = auth.status === "ok" ? auth.user.id : null;
    const callerIsService =
      auth.status === "ok" && auth.user.role === "service_role";

    // The caller's rank, from the database. A service-role caller (the
    // end-to-end verification script) is trusted at owner rank because it
    // already holds the key that could do all of this directly.
    let callerRole: string | null = "owner";
    if (!callerIsService) {
      if (!callerId) return jsonResponse({ error: "unauthorized" }, 401, cors);
      // An automation login must never become a way to create accounts, whatever
      // the role ladder says today. Checked before the rank so it stays true if
      // "let a foreman add his own crew" is ever shipped. The database refuses
      // the same thing underneath (guard_test_account_cannot_invite); this is
      // here so the answer is a clean 403 rather than a 500 from a trigger.
      if (await isTestAccount(supabase, callerId)) {
        return jsonResponse({ error: TEST_ACCOUNT_REFUSED }, 403, cors);
      }
      callerRole = await profileRole(supabase, callerId);
      if (roleRank(callerRole) < 2) {
        return jsonResponse(
          { error: "Only a supervisor or the owner can change who has access." },
          403,
          cors,
        );
      }
    }
    const invitedBy = callerIsService ? null : callerId;

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";

    // -----------------------------------------------------------------------
    switch (action) {
      case "create_invite": {
        const name = String(body.display_name ?? "").trim();
        const role = String(body.role ?? "installer");
        if (!name) {
          return jsonResponse({ error: "Enter their name." }, 400, cors);
        }

        // THE check. Re-derived here from the caller's stored role.
        const verdict = canInviteRole(callerRole, role);
        if (!verdict.ok) {
          return jsonResponse({ error: verdict.message }, 403, cors);
        }

        const supplied = String(body.email ?? "").trim().toLowerCase();
        if (supplied && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(supplied)) {
          return jsonResponse(
            { error: "That doesn't look like an email address." },
            400,
            cors,
          );
        }
        // No email given: mint a username that obviously cannot receive mail,
        // because nothing in this project sends any. The random suffix is
        // independent of the invite code — deriving it from the code would put
        // part of the secret in a readable column.
        const email = supplied ||
          crewLoginFromName(name, generateInviteCode(6));

        if (await findUserByEmail(supabase, email)) {
          return jsonResponse(
            {
              error:
                `${email} already has an account. Use "Send new login code" next to their name instead.`,
            },
            409,
            cors,
          );
        }

        const { code, invite } = await issueInvite(supabase, {
          displayName: name,
          email,
          role,
          invitedBy,
          targetUserId: null,
        });
        // The code is returned exactly once, over HTTPS, to the supervisor who
        // asked for it. It is never stored in plaintext, never logged, never
        // emailed.
        return jsonResponse({ ok: true, code, invite }, 200, cors);
      }

      // -----------------------------------------------------------------------
      case "resend_invite": {
        const inviteId = String(body.invite_id ?? "");
        if (!inviteId) {
          return jsonResponse({ error: "invite_id is required" }, 400, cors);
        }
        const { data: existing, error } = await supabase
          .from("crew_invites")
          .select(
            "id, display_name, email, role, target_user_id, expires_at, redeemed_at, revoked_at",
          )
          .eq("id", inviteId)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!existing) {
          return jsonResponse({ error: "That invite no longer exists." }, 404, cors);
        }
        const row = existing as unknown as InviteRecord;
        if (row.redeemed_at) {
          return jsonResponse(
            { error: "That invite was already used, so there is nothing to resend." },
            409,
            cors,
          );
        }
        // A fresh code for the same seat is still granting that role, so it is
        // re-authorised against the caller's rank rather than trusted because
        // the row already exists. Otherwise a demoted supervisor could keep
        // reissuing an owner invite somebody else created.
        const verdict = canInviteRole(callerRole, row.role);
        if (!verdict.ok) {
          return jsonResponse({ error: verdict.message }, 403, cors);
        }

        const { code, invite } = await issueInvite(supabase, {
          displayName: row.display_name,
          email: row.email,
          role: row.role,
          invitedBy,
          targetUserId: row.target_user_id,
        });
        return jsonResponse({ ok: true, code, invite }, 200, cors);
      }

      // -----------------------------------------------------------------------
      case "revoke_invite": {
        const inviteId = String(body.invite_id ?? "");
        if (!inviteId) {
          return jsonResponse({ error: "invite_id is required" }, 400, cors);
        }
        const { data: existing } = await supabase
          .from("crew_invites")
          .select("id, role, redeemed_at")
          .eq("id", inviteId)
          .maybeSingle();
        if (!existing) {
          return jsonResponse({ error: "That invite no longer exists." }, 404, cors);
        }
        const verdict = canManageMember(
          callerRole,
          (existing as { role: string }).role,
        );
        if (!verdict.ok) {
          return jsonResponse({ error: verdict.message }, 403, cors);
        }
        const { error } = await supabase
          .from("crew_invites")
          .update({ revoked_at: new Date().toISOString(), revoked_by: invitedBy })
          .eq("id", inviteId)
          .is("redeemed_at", null);
        if (error) throw new Error(error.message);
        return jsonResponse({ ok: true }, 200, cors);
      }

      // -----------------------------------------------------------------------
      // The no-email password reset. "Reset password" on the sign-in screen
      // sends mail, and this project has no sender, so for a crew member who
      // forgot their password this is the only way back in that does not need a
      // developer. It hands whoever holds the code the ability to set that
      // account's password, which is why it is gated exactly as hard as
      // inviting: never for someone who outranks the caller.
      case "reissue_login": {
        const userId = String(body.user_id ?? "");
        if (!userId) {
          return jsonResponse({ error: "user_id is required" }, 400, cors);
        }
        const targetRow = await readMember(supabase, userId);
        if (!targetRow) {
          return jsonResponse({ error: "No such crew member." }, 404, cors);
        }
        const verdict = canManageMember(callerRole, targetRow.role);
        if (!verdict.ok) {
          return jsonResponse({ error: verdict.message }, 403, cors);
        }
        // Checked BEFORE the ban message below, which would otherwise point at
        // a "Let them back in" button that refuses: a removed login has no
        // address left to sign in with, so a new code could never work.
        if (targetRow.retired_at) {
          return jsonResponse({ error: ALREADY_REMOVED }, 409, cors);
        }
        // A banned account cannot sign in whatever password it has, so a code
        // for one would look like a working invite and then fail at the door.
        // Say which button to press instead.
        if (targetRow.access_revoked_at) {
          return jsonResponse(
            {
              error:
                "Their access is switched off, so a new code could not get them in. Turn their access back on first.",
            },
            409,
            cors,
          );
        }

        const { data: userLookup, error: userErr } =
          await supabase.auth.admin.getUserById(userId);
        if (userErr || !userLookup?.user?.email) {
          return jsonResponse(
            { error: "That crew member has no login to reset." },
            404,
            cors,
          );
        }

        const { code, invite } = await issueInvite(supabase, {
          displayName: targetRow.display_name,
          email: userLookup.user.email,
          role: targetRow.role,
          invitedBy,
          targetUserId: userId,
        });
        return jsonResponse({ ok: true, code, invite }, 200, cors);
      }

      // -----------------------------------------------------------------------
      case "remove_access": {
        const userId = String(body.user_id ?? "");
        if (!userId) {
          return jsonResponse({ error: "user_id is required" }, 400, cors);
        }
        if (userId === callerId) {
          return jsonResponse(
            { error: "You can't remove your own access." },
            400,
            cors,
          );
        }
        const { data: target } = await supabase
          .from("profiles")
          .select("id, role")
          .eq("id", userId)
          .maybeSingle();
        if (!target) {
          return jsonResponse({ error: "No such crew member." }, 404, cors);
        }
        const targetRow = target as { id: string; role: string };
        const verdict = canManageMember(callerRole, targetRow.role);
        if (!verdict.ok) {
          return jsonResponse({ error: verdict.message }, 403, cors);
        }

        // Never lock the company out of its own app. If this is the last owner
        // whose access still works, refuse — there would be nobody left who
        // could restore anyone, including themselves.
        if (roleRank(targetRow.role) >= 3) {
          const { data: owners } = await supabase
            .from("profiles")
            .select("id, role, access_revoked_at")
            .in("role", ["owner", "big_boss"])
            .is("access_revoked_at", null);
          const remaining = (owners ?? []).filter(
            (o) => (o as { id: string }).id !== userId,
          ).length;
          if (remaining === 0) {
            return jsonResponse(
              {
                error:
                  "That is the last owner with access. Make someone else an owner first, or nobody could let anyone back in.",
              },
              409,
              cors,
            );
          }
        }

        const { error: banErr } = await supabase.auth.admin.updateUserById(
          userId,
          { ban_duration: FOREVER },
        );
        if (banErr) throw new Error(banErr.message);

        // Any code still outstanding for them dies with the access, or removing
        // someone would leave them a way back in.
        await supabase
          .from("crew_invites")
          .update({ revoked_at: new Date().toISOString(), revoked_by: invitedBy })
          .eq("target_user_id", userId)
          .is("redeemed_at", null)
          .is("revoked_at", null);

        const { error: profErr } = await supabase
          .from("profiles")
          .update({
            access_revoked_at: new Date().toISOString(),
            active: false,
            updated_at: new Date().toISOString(),
          })
          .eq("id", userId);
        if (profErr) throw new Error(profErr.message);

        return jsonResponse({ ok: true }, 200, cors);
      }

      // -----------------------------------------------------------------------
      case "restore_access": {
        const userId = String(body.user_id ?? "");
        if (!userId) {
          return jsonResponse({ error: "user_id is required" }, 400, cors);
        }
        const target = await readMember(supabase, userId);
        if (!target) {
          return jsonResponse({ error: "No such crew member." }, 404, cors);
        }
        const verdict = canManageMember(callerRole, target.role);
        if (!verdict.ok) {
          return jsonResponse({ error: verdict.message }, 403, cors);
        }
        // A removed login has had its email handed back, so un-banning it would
        // restore an account whose address is now a tombstone nobody can type.
        // Removing a login is deliberately a one-way door; the way back is a
        // fresh invite, which is the whole point of freeing the email.
        if (target.retired_at) {
          return jsonResponse({ error: ALREADY_REMOVED }, 409, cors);
        }

        const { error: banErr } = await supabase.auth.admin.updateUserById(
          userId,
          { ban_duration: "none" },
        );
        if (banErr) throw new Error(banErr.message);

        const { error: profErr } = await supabase
          .from("profiles")
          .update({ access_revoked_at: null, updated_at: new Date().toISOString() })
          .eq("id", userId);
        if (profErr) throw new Error(profErr.message);

        return jsonResponse({ ok: true }, 200, cors);
      }

      // -----------------------------------------------------------------------
      // What "Remove this login…" is about to do, WITHOUT doing any of it.
      //
      // The confirm sheet has to say which of the two shapes will happen —
      // "nothing on file, the account will be deleted" reads very differently
      // from "14 punches on file, everything is kept" — and a generic "are you
      // sure?" is what makes a destructive button dangerous. So the counts are
      // taken here and handed back for the sentence. Read-only: it writes
      // nothing, and it runs every refusal so the sheet can say "this won't
      // work" instead of promising something the next call would refuse.
      case "purge_login_preview": {
        const userId = String(body.user_id ?? "");
        if (!userId) {
          return jsonResponse({ error: "user_id is required" }, 400, cors);
        }
        const { data: target } = await supabase
          .from("profiles")
          .select("id, display_name, role, is_partner")
          .eq("id", userId)
          .maybeSingle();
        if (!target) {
          return jsonResponse({ error: "No such crew member." }, 404, cors);
        }
        const row = target as unknown as PurgeTarget;
        const refusal = await purgeRefusal(supabase, {
          target: row,
          callerId,
          callerRole,
          callerIsService,
        });
        if (refusal) {
          return jsonResponse({ error: refusal.error }, refusal.status, cors);
        }
        const counts = await countHistory(supabase, userId);
        return jsonResponse(
          {
            ok: true,
            user_id: userId,
            display_name: row.display_name,
            counts,
            shape: shapeFor(counts) satisfies PurgeShape,
          },
          200,
          cors,
        );
      }

      // -----------------------------------------------------------------------
      // The third, strongest door: remove a login and free its email.
      //
      // TWO SHAPES, CHOSEN BY THE DATA (see _shared/purgeLogin.ts):
      //
      //   NO HISTORY  → the auth user is deleted. profiles.id references
      //     auth.users ON DELETE CASCADE, so the profile goes with it, and
      //     there is nothing else to lose — that is what "no history" was
      //     counted to establish. The email is free because the row is gone.
      //
      //   HAS HISTORY → nothing is deleted, ever. The auth user is banned (the
      //     same primitive remove_access uses), profiles.access_revoked_at is
      //     stamped, the profile is marked retired, and the auth user's EMAIL
      //     is renamed to a tombstone so the real address comes free. Every
      //     record still points at the same profile id, so "who installed this
      //     window" still answers, and the roster shows the person as Removed
      //     under the name they always had.
      //
      // The counts are taken again here rather than trusted from the preview:
      // a punch clocked in between the two calls must move the answer, and a
      // caller posting straight at this endpoint never supplied them at all.
      case "purge_login": {
        const userId = String(body.user_id ?? "");
        if (!userId) {
          return jsonResponse({ error: "user_id is required" }, 400, cors);
        }
        const { data: target } = await supabase
          .from("profiles")
          .select("id, display_name, role, is_partner")
          .eq("id", userId)
          .maybeSingle();
        if (!target) {
          return jsonResponse({ error: "No such crew member." }, 404, cors);
        }
        const row = target as unknown as PurgeTarget;
        const refusal = await purgeRefusal(supabase, {
          target: row,
          callerId,
          callerRole,
          callerIsService,
        });
        if (refusal) {
          return jsonResponse({ error: refusal.error }, refusal.status, cors);
        }

        // Any code still outstanding for them dies first, whichever shape
        // follows — a live invite naming a deleted user is a code that fails at
        // the door, and one naming a retired user is a way back in.
        await supabase
          .from("crew_invites")
          .update({ revoked_at: new Date().toISOString(), revoked_by: invitedBy })
          .eq("target_user_id", userId)
          .is("redeemed_at", null)
          .is("revoked_at", null);

        const counts = await countHistory(supabase, userId);
        const shape = shapeFor(counts);

        if (shape === "deleted") {
          const { error: delErr } = await supabase.auth.admin.deleteUser(userId);
          if (delErr) throw new Error(delErr.message);
          // The profile went with the auth user (ON DELETE CASCADE). Deleting
          // it here as well would be a second statement that can only fail.
          return jsonResponse(
            {
              ok: true,
              shape,
              email_released: true,
              display_name: row.display_name,
            },
            200,
            cors,
          );
        }

        const { error: banErr } = await supabase.auth.admin.updateUserById(
          userId,
          { ban_duration: FOREVER },
        );
        if (banErr) throw new Error(banErr.message);

        // Free the address. Supabase Auth allows updating the email of a banned
        // user — the ban gates signing IN, not administrative writes — and this
        // is the whole point of the feature: without it the address stays taken
        // forever and the same person can never be given a fresh account.
        // `email_confirm: true` because a confirmation mail for an address that
        // cannot receive one would leave the row half-changed, and this project
        // has no mail sender anyway (docs/crew-invites.md).
        const { error: emailErr } = await supabase.auth.admin.updateUserById(
          userId,
          { email: tombstoneEmail(userId), email_confirm: true },
        );
        if (emailErr) throw new Error(emailErr.message);

        const now = new Date().toISOString();
        const { error: profErr } = await supabase
          .from("profiles")
          .update({
            access_revoked_at: now,
            retired_at: now,
            retired_by: invitedBy,
            active: false,
            updated_at: now,
          })
          .eq("id", userId);
        // A database that has not had 20260987000000 yet has no retired_at.
        // The login is already closed and the email already freed at this
        // point, so the honest thing is to finish the part that CAN be done
        // rather than fail after a ban that cannot be taken back.
        if (profErr) {
          const message = String(
            (profErr as { message?: string }).message ?? profErr,
          );
          if (!/retired_at|retired_by|PGRST204/i.test(message)) {
            throw new Error(message);
          }
          const { error: fallbackErr } = await supabase
            .from("profiles")
            .update({ access_revoked_at: now, active: false, updated_at: now })
            .eq("id", userId);
          if (fallbackErr) throw new Error(fallbackErr.message);
        }

        return jsonResponse(
          {
            ok: true,
            shape,
            email_released: true,
            display_name: row.display_name,
          },
          200,
          cors,
        );
      }

      default:
        return jsonResponse(
          {
            error:
              "Unknown action. Expected create_invite, resend_invite, revoke_invite, reissue_login, remove_access, restore_access, purge_login_preview or purge_login.",
          },
          400,
          cors,
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return jsonResponse({ error: message }, 500, cors);
  }
});
