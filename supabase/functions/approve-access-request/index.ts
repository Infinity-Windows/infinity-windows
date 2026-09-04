/**
 * Turn an approved access request into a login that actually works.
 *
 * The problem this fixes. Until now "Approve" on the Admin screen wrote
 * `status = 'approved'` to a row in `access_requests` and stopped. It created
 * no account. The person it approved could not sign in, because there was no
 * `auth.users` record for them and nothing in the app could make one — the
 * screen said, in small grey text, "Once approved, create their login in
 * Supabase Auth, then set their role on the Crew screen", i.e. an owner had to
 * open the Supabase dashboard and do it by hand. The owner's report was blunt:
 * "when I admin approve his login it still won't work." One collaborator only
 * got in because somebody set a password for him by hand.
 *
 * Only the service role can create a user, and the service key must never reach
 * a browser, so this has to be an edge function.
 *
 * Why a temporary password rather than an emailed invitation. This project has
 * no SMTP sender configured (`smtp_admin_email` is null), Supabase's built-in
 * sender is capped at 2 emails an hour, and `site_url` is still
 * `http://localhost:3000` with an empty redirect allow-list — so an invitation
 * link would either not arrive or land on a dead address. A generated password,
 * shown once to the approver, needs no mail at all and is the same thing that
 * was already being done by hand, minus the hand. The account is created
 * pre-confirmed for the same reason: a confirmation email nobody receives is a
 * locked-out crew member.
 *
 * What it deliberately does NOT do:
 *   - It never grants the role the person asked for. Everyone lands as
 *     `installer` (the `profiles.role` column default) and an owner or
 *     supervisor lifts them from there on the Crew screen. A request form is
 *     filled in by the person who wants access, so it is not evidence.
 *   - It refuses if the email already has an account, rather than resetting
 *     that account's password. Otherwise this endpoint would be a way for a
 *     supervisor to take over the owner's login.
 *
 * WHAT HAPPENS AFTER THAT REFUSAL (2026-09-04). "They already have a login" is
 * the commonest thing that goes wrong in this queue — somebody asks twice, or
 * asks after being invited by text — and until now the request just sat in
 * Pending forever, because the only way to clear it was Deny, which is a lie
 * about a person who does in fact work here. The refusal now carries
 * `code: 'already_has_login'` so the Admin screen can recognise it rather than
 * pattern-match an English sentence, and offer one tap that files the request
 * as approved with a note saying so. That tap comes back here as
 * `action: 'mark_already_linked'` and not as a client-side UPDATE, because
 * 'approved' means "an account exists" and this function is the only thing
 * allowed to say that (decide_access_request refuses the word outright).
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

type ServiceClient = ReturnType<typeof createClient>;

/**
 * Mirrors roleRank() in app/src/lib/install/types.ts, legacy aliases included,
 * so this function and the UI can never disagree about who may approve.
 */
function roleRank(role: string | null | undefined): number {
  switch (role) {
    case "owner":
    case "big_boss":
      return 3;
    case "supervisor":
    case "admin":
      return 2;
    case "foreman":
    case "lead":
      return 1;
    default:
      return 0;
  }
}

/**
 * A password a person can read down a phone line and type on a site, that is
 * still far beyond guessing. 14 characters from a 32-symbol alphabet with no
 * 0/O/1/l/I is ~70 bits. Drawn from the platform CSPRNG, and rejection-sampled
 * so the modulo does not bias the alphabet.
 */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
function temporaryPassword(length = 14): string {
  const out: string[] = [];
  const buf = new Uint8Array(1);
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    if (buf[0] >= limit) continue;
    out.push(ALPHABET[buf[0] % ALPHABET.length]);
  }
  return out.join("");
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

/**
 * Is this email already an account? listUsers is paginated, so ask for the page
 * containing this address rather than walking every user.
 */
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
    const hit = data.users.find(
      (u) => (u.email ?? "").toLowerCase() === wanted,
    );
    if (hit) return { id: hit.id };
    if (data.users.length < 200) return null;
  }
  return null;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

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

    // Same gate as the Admin screen: supervisor or owner. Read from
    // `profiles.role`, which is the source of truth the rest of the app uses,
    // not from anything the caller sent.
    if (!callerIsService) {
      if (!callerId) {
        return jsonResponse({ error: "unauthorized" }, 401, cors);
      }
      // This endpoint creates an auth user directly, so it is the other way an
      // account can come into existence. A test login is refused here for the
      // same reason it is refused by manage-crew-access.
      if (await isTestAccount(supabase, callerId)) {
        return jsonResponse({ error: TEST_ACCOUNT_REFUSED }, 403, cors);
      }
      const role = await profileRole(supabase, callerId);
      if (roleRank(role) < 2) {
        return jsonResponse(
          { error: "only a supervisor or the owner can approve access" },
          403,
          cors,
        );
      }
    }

    const body = (await req.json().catch(() => ({}))) as {
      request_id?: unknown;
      action?: unknown;
    };
    const requestId = typeof body.request_id === "string" ? body.request_id : "";
    const action = typeof body.action === "string" ? body.action : "";
    if (!requestId) {
      return jsonResponse({ error: "request_id is required" }, 400, cors);
    }

    const { data: request, error: reqErr } = await supabase
      .from("access_requests")
      .select("id, name, email, requested_role, status")
      .eq("id", requestId)
      .maybeSingle();
    if (reqErr) throw new Error(reqErr.message);
    if (!request) {
      return jsonResponse({ error: "that request no longer exists" }, 404, cors);
    }

    // "They already have a login." Files the request as dealt with, creates
    // nothing, and touches no account — the person already has one, which is
    // the whole reason this exists. It writes 'approved' because that is the
    // truth from the asker's point of view (they can sign in), and the note is
    // what stops the row reading as though this queue made the account.
    if (action === "mark_already_linked") {
      const now = new Date().toISOString();
      const { error: linkErr } = await supabase
        .from("access_requests")
        .update({
          status: "approved",
          decided_at: now,
          decided_by: callerId && !callerIsService ? callerId : null,
          decision_note: "Already had a login",
        })
        .eq("id", requestId);
      // A database without decision_note yet (this ships with
      // 20260987000000) must still be able to clear the row — the note is the
      // nicety, the decision is the point.
      if (linkErr) {
        if (!/decision_note|PGRST204/i.test(linkErr.message ?? "")) {
          throw new Error(linkErr.message);
        }
        const { error: retryErr } = await supabase
          .from("access_requests")
          .update({
            status: "approved",
            decided_at: now,
            decided_by: callerId && !callerIsService ? callerId : null,
          })
          .eq("id", requestId);
        if (retryErr) throw new Error(retryErr.message);
      }
      return jsonResponse(
        { ok: true, marked: "already_has_login", request_id: requestId },
        200,
        cors,
      );
    }

    if (request.status === "denied") {
      return jsonResponse(
        { error: "that request was denied; ask them to request access again" },
        409,
        cors,
      );
    }

    const email = String(request.email ?? "").trim().toLowerCase();
    if (!email) {
      return jsonResponse(
        {
          error:
            "this request has no email address, and an account needs one — ask them for it and have them request access again",
        },
        400,
        cors,
      );
    }

    if (await findUserByEmail(supabase, email)) {
      // `code` is the machine-readable half, so the Admin screen can offer
      // "Mark as already has a login" instead of leaving the row in Pending
      // forever. The sentence stays the sentence; nothing reads it to decide.
      return jsonResponse(
        {
          code: "already_has_login",
          email,
          error:
            `${email} already has an account. They should sign in, or use "Reset password" on the sign-in screen.`,
        },
        409,
        cors,
      );
    }

    const password = temporaryPassword();
    const { data: created, error: createErr } =
      await supabase.auth.admin.createUser({
        email,
        password,
        // No mail server is configured, so a confirmation email would never
        // arrive and the account would be unusable. The approval IS the
        // verification here: a supervisor is vouching for this person.
        email_confirm: true,
        user_metadata: { display_name: request.name ?? email.split("@")[0] },
      });
    if (createErr || !created?.user) {
      throw new Error(createErr?.message ?? "could not create the account");
    }
    const userId = created.user.id;

    // Create the profile here rather than leaving it to ensureMyProfile() on
    // first sign-in, so the crew list shows the name the approver saw rather
    // than the local part of an email address. `role` is deliberately not sent:
    // the column default is `installer`.
    const { error: profErr } = await supabase.from("profiles").upsert(
      {
        id: userId,
        display_name: request.name ?? email.split("@")[0],
        active: true,
      },
      { onConflict: "id" },
    );
    if (profErr) {
      // Leaving an auth user with no profile behind would be a half-made
      // account that the Crew screen cannot see, so undo it.
      await supabase.auth.admin.deleteUser(userId);
      throw new Error(`account rolled back: ${profErr.message}`);
    }

    const { error: updErr } = await supabase
      .from("access_requests")
      .update({
        status: "approved",
        decided_at: new Date().toISOString(),
        decided_by: callerId && !callerIsService ? callerId : null,
      })
      .eq("id", requestId);
    if (updErr) throw new Error(updErr.message);

    // The password is returned exactly once, over HTTPS, to the supervisor who
    // asked for it. It is never stored, never logged and never emailed.
    return jsonResponse(
      {
        ok: true,
        user_id: userId,
        email,
        display_name: request.name ?? email.split("@")[0],
        role: "installer",
        temporary_password: password,
        requested_role: request.requested_role ?? "installer",
      },
      200,
      cors,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return jsonResponse({ error: message }, 500, cors);
  }
});
