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
        const { data: target } = await supabase
          .from("profiles")
          .select("id, display_name, role, access_revoked_at")
          .eq("id", userId)
          .maybeSingle();
        if (!target) {
          return jsonResponse({ error: "No such crew member." }, 404, cors);
        }
        const targetRow = target as {
          id: string;
          display_name: string;
          role: string;
          access_revoked_at: string | null;
        };
        const verdict = canManageMember(callerRole, targetRow.role);
        if (!verdict.ok) {
          return jsonResponse({ error: verdict.message }, 403, cors);
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
        const { data: target } = await supabase
          .from("profiles")
          .select("id, role")
          .eq("id", userId)
          .maybeSingle();
        if (!target) {
          return jsonResponse({ error: "No such crew member." }, 404, cors);
        }
        const verdict = canManageMember(
          callerRole,
          (target as { role: string }).role,
        );
        if (!verdict.ok) {
          return jsonResponse({ error: verdict.message }, 403, cors);
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

      default:
        return jsonResponse(
          {
            error:
              "Unknown action. Expected create_invite, resend_invite, revoke_invite, reissue_login, remove_access or restore_access.",
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
