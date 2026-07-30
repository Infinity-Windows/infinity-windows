/**
 * Exchange an invite code for a working login.
 *
 * This is the one function in the project a person with NO account can reach, so
 * it is worth being precise about what that does and does not mean.
 *
 * IT IS NOT PUBLIC SIGNUP. `disable_signup` stays true on the project and
 * nothing here changes it. There is exactly one way through: a code that a
 * supervisor or the owner minted, that has not expired, has not been revoked,
 * and has never been redeemed. A visitor without one gets a flat refusal and no
 * account is created. The role the new account lands on is read off the stored
 * invite row — never from the request — so a redeemer cannot ask to be an owner.
 *
 * WHY IT IS REACHABLE AT ALL. It is registered with `verify_jwt = true` like
 * every other function here, which is not a contradiction: the Supabase gateway
 * accepts the project's anon key as a valid JWT, so supabase-js reaches this
 * code with no user signed in, and `verifyCaller` simply reports no end user.
 * That was confirmed against production rather than assumed — with no
 * Authorization header the gateway refuses with
 * {"code":"UNAUTHORIZED_NO_AUTH_HEADER"} before any function runs, while the
 * anon key reaches function code. So the platform gate still keeps out
 * unauthenticated internet noise, and the invite code is the real credential.
 *
 * BRUTE FORCE. A code is 10 symbols from a 31-symbol alphabet, ~49.5 bits, and
 * is stored as PBKDF2-SHA256 at 100,000 iterations. Guessing costs a full
 * derivation per attempt with no shortcut, which is both a real cost to the
 * attacker and a natural throttle on this endpoint; badly-shaped codes are
 * rejected before any hashing so junk cannot be used to burn CPU. Codes also die
 * after 7 days, so there is no long window to grind against.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";
import {
  hashInviteCode,
  inviteStatus,
  looksLikeInviteCode,
  redemptionRefusal,
  validateInvitePassword,
} from "../_shared/crewInvites.ts";

interface InviteRow {
  id: string;
  display_name: string;
  email: string;
  role: string;
  target_user_id: string | null;
  expires_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // No verifyCaller gate on purpose: the person redeeming has no account yet,
  // by definition. The gateway's verify_jwt still requires the anon key, and the
  // invite code is what actually authorises this call.

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase env not configured");
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const rawCode = typeof body.code === "string" ? body.code : "";
    const password = typeof body.password === "string" ? body.password : "";
    /**
     * "peek" reads the name and role off the invite without consuming it, so the
     * join screen can open with "Hi Mike — you're being set up as an Installer"
     * rather than asking a new hire to invent a password on faith and only then
     * discovering he mistyped the code.
     *
     * It reveals nothing that redeeming would not: whoever holds the code can
     * already have the account. It does let someone confirm a guessed code
     * without spending it, which is why the code is ~49.5 bits behind a 100,000
     * iteration derivation — guessing is not the cheap part.
     */
    const peekOnly = body.action === "peek";

    // Shape check first: refuses junk without paying for a key derivation.
    if (!looksLikeInviteCode(rawCode)) {
      return jsonResponse(
        { error: "That code isn't right. Check it and try again." },
        400,
        cors,
      );
    }
    if (!peekOnly) {
      const pw = validateInvitePassword(password);
      if (!pw.ok) return jsonResponse({ error: pw.error }, 400, cors);
    }

    const codeHash = await hashInviteCode(rawCode);
    const { data: found, error: lookupErr } = await supabase
      .from("crew_invites")
      .select(
        "id, display_name, email, role, target_user_id, expires_at, redeemed_at, revoked_at",
      )
      .eq("code_hash", codeHash)
      .maybeSingle();
    if (lookupErr) throw new Error(lookupErr.message);

    // Deliberately the same wording as a badly-shaped code: a wrong code and a
    // code that never existed are the same thing to the person typing, and
    // telling them apart would confirm which guesses landed on a real row.
    if (!found) {
      return jsonResponse(
        { error: "That code isn't right. Check it and try again." },
        400,
        cors,
      );
    }
    const invite = found as unknown as InviteRow;

    const status = inviteStatus(invite);
    if (status !== "pending") {
      return jsonResponse({ error: redemptionRefusal(status) }, 409, cors);
    }

    if (peekOnly) {
      // Deliberately narrow: the name they were invited under, the role, and
      // when it runs out. Not the email, not who invited them, not the row id.
      return jsonResponse(
        {
          ok: true,
          display_name: invite.display_name,
          role: invite.role,
          expires_at: invite.expires_at,
          existing_account: Boolean(invite.target_user_id),
        },
        200,
        cors,
      );
    }

    // ---------------------------------------------------------------------
    // Single use, enforced by the database and not by the check above.
    // ---------------------------------------------------------------------
    // The status check is a courtesy that produces a good error message. THIS is
    // the control. One UPDATE, with "not yet redeemed" in its WHERE clause, so
    // two people racing the same forwarded code both run it and exactly one
    // matches a row — Postgres serialises them on the row lock. Checking first
    // and updating second would let both pass the check before either wrote.
    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .from("crew_invites")
      .update({ redeemed_at: claimedAt })
      .eq("id", invite.id)
      .is("redeemed_at", null)
      .is("revoked_at", null)
      .gt("expires_at", claimedAt)
      .select("id");
    if (claimErr) throw new Error(claimErr.message);
    if (!claimed || claimed.length === 0) {
      return jsonResponse(
        { error: "That code has already been used. Ask for a new one." },
        409,
        cors,
      );
    }

    /**
     * Put the code back if we could not finish. Without this, any transient
     * failure after the claim — a hiccup creating the user — would burn the one
     * code this person was ever sent and leave them locked out with a valid
     * slip of paper in their hand.
     */
    const releaseClaim = async () => {
      await supabase
        .from("crew_invites")
        .update({ redeemed_at: null })
        .eq("id", invite.id)
        .eq("redeemed_at", claimedAt);
    };

    try {
      let userId: string;

      if (invite.target_user_id) {
        // Re-issuing a login for an account that already exists: set the
        // password the person just chose. The role is NOT touched — this path
        // restores access to an existing account, it does not re-grade it.
        const { data: updated, error } = await supabase.auth.admin
          .updateUserById(invite.target_user_id, { password });
        if (error || !updated?.user) {
          throw new Error(error?.message ?? "could not update that login");
        }
        userId = updated.user.id;
      } else {
        const { data: created, error } = await supabase.auth.admin.createUser({
          email: invite.email,
          password,
          // Pre-confirmed, because a confirmation email would never arrive:
          // this project has no SMTP sender. The invite IS the verification —
          // a supervisor or the owner vouched for this person by name before
          // the code existed.
          email_confirm: true,
          user_metadata: { display_name: invite.display_name },
        });
        if (error || !created?.user) {
          throw new Error(error?.message ?? "could not create that login");
        }
        userId = created.user.id;

        // The role comes off the invite row, which was authorised against the
        // inviter's own rank when it was created. Written here on the
        // service-role key because `profiles.role` is revoked from every client
        // role at the column level.
        const { error: profErr } = await supabase.from("profiles").upsert(
          {
            id: userId,
            display_name: invite.display_name,
            role: invite.role,
            active: true,
            access_revoked_at: null,
          },
          { onConflict: "id" },
        );
        if (profErr) {
          // An auth user with no profile is a half-made account the Crew screen
          // cannot see and nobody can grade. Undo it.
          await supabase.auth.admin.deleteUser(userId);
          throw new Error(profErr.message);
        }
      }

      await supabase
        .from("crew_invites")
        .update({ redeemed_user_id: userId })
        .eq("id", invite.id);

      // The password is never returned: the caller already has it, because they
      // just chose it. The client signs in with it directly.
      return jsonResponse(
        {
          ok: true,
          email: invite.email,
          display_name: invite.display_name,
          role: invite.role,
          existing_account: Boolean(invite.target_user_id),
        },
        200,
        cors,
      );
    } catch (inner) {
      await releaseClaim();
      throw inner;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return jsonResponse({ error: message }, 500, cors);
  }
});
