#!/usr/bin/env python3
"""Prove the crew-invite flow works, and that it cannot be used to climb.

    export SUPABASE_ACCESS_TOKEN=sbp_...
    SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/prove-crew-invites.py

WHY THIS EXISTS. Self-signup is off, so "an owner adds a crew member" is the only
way anyone new ever gets into this app. It is also, by construction, a way to
create an account at a chosen ROLE — which is the exact shape of the
privilege-escalation hole that was closed on profiles.role on 2026-07-29. Unit
tests cover the rules as functions; this covers them as an HTTP endpoint on the
live project, which is where a hostile caller would actually knock.

Nothing here is a mock. It mints a real invite as the real owner, redeems it as a
signed-out stranger, signs in as the account that appears, then tries to abuse
the endpoint from that account and asserts it is refused. It deletes everything
it made and asserts the roster is byte-identical to what it found, so a
half-finished run is visible rather than silent.

Every step asserts its own EFFECT. "No error was raised" is not evidence: a write
forbidden by row-level security matches zero rows and returns success.

Safe to run against production, and meant to be. It leaves no user, no profile
and no invite behind, and it never changes an existing account: the owner session
is a one-time magic link minted with the admin API, which sends no mail and does
not touch his password.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

REF = os.environ.get("SUPABASE_PROJECT_REF", "").strip()
if not REF:
    sys.exit(
        "SUPABASE_PROJECT_REF is not set, and there is no default.\n"
        "Name the project you mean, e.g. for production:\n\n"
        "  SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/prove-crew-invites.py"
    )
TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
if not TOKEN:
    sys.exit("set SUPABASE_ACCESS_TOKEN to an sbp_ management token")

API = f"https://{REF}.supabase.co"
MGMT = "https://api.supabase.com/v1"

RANK = {"owner": 3, "big_boss": 3, "supervisor": 2, "admin": 2, "foreman": 1, "lead": 1}

# Throwaway identities, obviously marked so a human who finds one mid-run knows
# what it is. The password is only ever held in this process.
PROBE_EMAIL = "qa.invite.probe@horizonsolarusa.com"
PROBE_NAME = "QA Invite Probe"
PROBE_NAME_NOEMAIL = "QA Invite Nomail"
PROBE_PASSWORD = "probe-invite-password-2026"


def curl(args: list[str], data: str | None = None) -> str:
    return subprocess.run(
        ["curl", "-sS", *args], input=data, capture_output=True, text=True
    ).stdout


def parse(text: str):
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"_raw": text[:400]}


def project_keys() -> tuple[str, str]:
    """anon and service keys, held in memory only and never printed."""
    keys = parse(curl([f"{MGMT}/projects/{REF}/api-keys?reveal=true",
                       "-H", f"Authorization: Bearer {TOKEN}"]))
    if not isinstance(keys, list):
        sys.exit("could not read the project API keys")
    anon = service = None
    for k in keys:
        if k.get("name") == "anon" or k.get("type") == "anon":
            anon = k.get("api_key")
        if k.get("name") in ("service_role", "secret") or k.get("type") in ("service_role", "secret"):
            service = service or k.get("api_key")
    if not anon or not service:
        sys.exit("could not read the project API keys")
    return anon, service


ANON, SERVICE = project_keys()

failures: list[str] = []
step_no = 0


def step(ok: bool, detail: str) -> None:
    global step_no
    step_no += 1
    print(f"  {step_no:>2}  {'PASS' if ok else 'FAIL'}  {detail}", flush=True)
    if not ok:
        failures.append(detail)


def rest(method: str, path: str, body=None, key: str | None = None, bearer: str | None = None):
    key = key or ANON
    args = ["-X", method, f"{API}{path}", "-H", f"apikey: {key}",
            "-H", f"Authorization: Bearer {bearer or key}",
            "-H", "Content-Type: application/json"]
    if body is not None:
        return parse(curl([*args, "--data-binary", "@-"], json.dumps(body)))
    return parse(curl(args))


def call_function(name: str, body: dict, bearer: str) -> tuple[str, dict]:
    """Invoke an edge function ONCE, returning (http status, parsed body).

    Exactly once matters: these endpoints create accounts, so a helper that
    quietly retried would make two people and then report a conflict it caused
    itself.
    """
    out = curl(["-w", "\n%{http_code}", "-X", "POST",
                f"{API}/functions/v1/{name}", "-H", f"apikey: {ANON}",
                "-H", f"Authorization: Bearer {bearer}",
                "-H", "Content-Type: application/json", "--data-binary", "@-"],
               json.dumps(body))
    payload, _, status = out.rpartition("\n")
    return status.strip(), parse(payload)


def password_session(email: str, password: str) -> str | None:
    got = parse(curl(["-X", "POST", f"{API}/auth/v1/token?grant_type=password",
                      "-H", f"apikey: {ANON}", "-H", "Content-Type: application/json",
                      "--data-binary", "@-"],
                     json.dumps({"email": email, "password": password})))
    return got.get("access_token")


def owner_session() -> tuple[str, str, str]:
    """A session for a real owner, without knowing or changing their password."""
    people = rest("GET", "/rest/v1/profiles?select=id,display_name,role",
                  key=SERVICE, bearer=SERVICE)
    if not isinstance(people, list):
        sys.exit(f"could not read the roster: {people}")
    owner = next((p for p in people if RANK.get(p.get("role"), 0) >= 3), None)
    if not owner:
        sys.exit("no owner exists in this project, so nobody could invite anyone")
    users = parse(curl([f"{API}/auth/v1/admin/users?per_page=200",
                        "-H", f"apikey: {SERVICE}", "-H", f"Authorization: Bearer {SERVICE}"]))
    email = next((u["email"] for u in users.get("users", []) if u["id"] == owner["id"]), None)
    if not email:
        sys.exit("the owner has a profile but no auth account")
    link = parse(curl(["-X", "POST", f"{API}/auth/v1/admin/generate_link",
                       "-H", f"apikey: {SERVICE}", "-H", f"Authorization: Bearer {SERVICE}",
                       "-H", "Content-Type: application/json", "--data-binary", "@-"],
                      json.dumps({"type": "magiclink", "email": email})))
    hashed = link.get("hashed_token") or (link.get("properties") or {}).get("hashed_token")
    session = parse(curl(["-X", "POST", f"{API}/auth/v1/verify", "-H", f"apikey: {ANON}",
                          "-H", "Content-Type: application/json", "--data-binary", "@-"],
                         json.dumps({"type": "magiclink", "token_hash": hashed})))
    jwt = session.get("access_token")
    if not jwt:
        sys.exit(f"could not mint an owner session: {session}")
    return jwt, owner["id"], owner.get("display_name") or "owner"


def roster() -> str:
    rows = rest("GET", "/rest/v1/profiles?select=display_name,role&order=display_name",
                key=SERVICE, bearer=SERVICE)
    if not isinstance(rows, list):
        return f"unreadable: {rows}"
    return ", ".join(f"{r['display_name']}={r['role']}" for r in rows)


def find_user(email: str) -> str | None:
    users = parse(curl([f"{API}/auth/v1/admin/users?per_page=200",
                        "-H", f"apikey: {SERVICE}", "-H", f"Authorization: Bearer {SERVICE}"]))
    for u in users.get("users", []):
        if (u.get("email") or "").lower() == email.lower():
            return u["id"]
    return None


def cleanup(user_ids: list[str], emails: list[str]) -> None:
    for uid in [u for u in dict.fromkeys(user_ids) if u]:
        curl(["-X", "DELETE", f"{API}/auth/v1/admin/users/{uid}",
              "-H", f"apikey: {SERVICE}", "-H", f"Authorization: Bearer {SERVICE}"])
        rest("DELETE", f"/rest/v1/profiles?id=eq.{uid}", key=SERVICE, bearer=SERVICE)
    for name in (PROBE_NAME, PROBE_NAME_NOEMAIL):
        rest("DELETE", f"/rest/v1/crew_invites?display_name=eq.{name.replace(' ', '%20')}",
             key=SERVICE, bearer=SERVICE)
    for email in emails:
        if email:
            rest("DELETE", f"/rest/v1/crew_invites?email=eq.{email}", key=SERVICE, bearer=SERVICE)


def main() -> int:
    before = roster()
    print(f"\nRoster before: {before}\n")

    owner_jwt, owner_id, owner_name = owner_session()
    print(f"Acting as owner: {owner_name}\n")

    created_users: list[str] = []
    created_emails: list[str] = []

    # Anything left over from an interrupted earlier run.
    stale = find_user(PROBE_EMAIL)
    if stale:
        cleanup([stale], [PROBE_EMAIL])

    try:
        # ---------------------------------------------------------------
        # 1. An owner can mint an invite, and gets a code back exactly once.
        # ---------------------------------------------------------------
        status, made = call_function("manage-crew-access", {
            "action": "create_invite",
            "display_name": PROBE_NAME,
            "role": "installer",
            "email": PROBE_EMAIL,
        }, owner_jwt)
        code = made.get("code") or ""
        invite_id = (made.get("invite") or {}).get("id")
        step(status == "200" and len(code) == 10 and bool(invite_id),
             f"owner mints an invite -> {status}, 10-char code returned: {bool(code)}")
        if not code:
            print(f"      cannot continue: {made}")
            return 1
        created_emails.append(PROBE_EMAIL)

        # ---------------------------------------------------------------
        # 2. The code is NOT recoverable from the database.
        # ---------------------------------------------------------------
        rows = rest("GET", f"/rest/v1/crew_invites?id=eq.{invite_id}&select=*",
                    key=SERVICE, bearer=SERVICE)
        row = rows[0] if isinstance(rows, list) and rows else {}
        stored = json.dumps(row)
        step(bool(row) and code not in stored and row.get("code_hash") not in (None, "", code),
             "the plaintext code appears nowhere in the stored row (only a hash)")
        step(row.get("role") == "installer" and row.get("redeemed_at") is None,
             f"stored role is installer, unredeemed: role={row.get('role')}")

        # ---------------------------------------------------------------
        # 3. An installer cannot even see that invites exist (RLS).
        #    Checked later from the probe's own session; here, anon cannot.
        # ---------------------------------------------------------------
        anon_read = rest("GET", "/rest/v1/crew_invites?select=id")
        step(not (isinstance(anon_read, list) and anon_read),
             "a signed-out caller cannot read the invite table")

        # ---------------------------------------------------------------
        # 4. Peek tells the new hire who they are without spending the code.
        # ---------------------------------------------------------------
        status, peek = call_function("redeem-crew-invite",
                                    {"action": "peek", "code": code}, ANON)
        step(status == "200" and peek.get("display_name") == PROBE_NAME
             and peek.get("role") == "installer",
             f"peek names the person and role without redeeming -> {status}")
        after_peek = rest("GET", f"/rest/v1/crew_invites?id=eq.{invite_id}&select=redeemed_at",
                          key=SERVICE, bearer=SERVICE)
        step(isinstance(after_peek, list) and after_peek
             and after_peek[0].get("redeemed_at") is None,
             "peek did not consume the invite")

        # ---------------------------------------------------------------
        # 5. A signed-out stranger redeems it and an account appears.
        # ---------------------------------------------------------------
        status, redeemed = call_function("redeem-crew-invite",
                                        {"code": code, "password": PROBE_PASSWORD}, ANON)
        step(status == "200" and redeemed.get("email") == PROBE_EMAIL,
             f"a signed-out caller redeems the code -> {status}")
        probe_id = find_user(PROBE_EMAIL)
        step(bool(probe_id), "an auth account now exists for that address")
        if probe_id:
            created_users.append(probe_id)

        # ---------------------------------------------------------------
        # 6. It lands at the invited role — not a role the redeemer chose.
        # ---------------------------------------------------------------
        prof = rest("GET", f"/rest/v1/profiles?id=eq.{probe_id}&select=display_name,role,active",
                    key=SERVICE, bearer=SERVICE)
        got = prof[0] if isinstance(prof, list) and prof else {}
        step(got.get("role") == "installer" and got.get("display_name") == PROBE_NAME,
             f"profile lands as the invited role: {got.get('display_name')}={got.get('role')}")

        # ---------------------------------------------------------------
        # 7. They can actually sign in with the password they chose.
        # ---------------------------------------------------------------
        probe_jwt = password_session(PROBE_EMAIL, PROBE_PASSWORD)
        step(bool(probe_jwt), "the new crew member can sign in with their own password")

        # ---------------------------------------------------------------
        # 8. SINGLE USE. The same code, a second time, is refused.
        # ---------------------------------------------------------------
        status, again = call_function("redeem-crew-invite",
                                     {"code": code, "password": "a-different-password-99"}, ANON)
        step(status == "409" and "already been used" in str(again.get("error", "")),
             f"the same code a second time is refused -> {status}: {again.get('error')}")

        # ---------------------------------------------------------------
        # 9. THE ESCALATION CHECKS, from a real session that is not the owner's.
        # ---------------------------------------------------------------
        if probe_jwt:
            inv_read = rest("GET", "/rest/v1/crew_invites?select=id",
                            key=ANON, bearer=probe_jwt)
            step(not (isinstance(inv_read, list) and inv_read),
                 "an installer cannot read the invite table")

            status, denied = call_function("manage-crew-access", {
                "action": "create_invite", "display_name": "Should Not Exist",
                "role": "installer",
            }, probe_jwt)
            step(status == "403",
                 f"an installer cannot invite anyone at all -> {status}: {denied.get('error')}")

            status, denied = call_function("manage-crew-access", {
                "action": "create_invite", "display_name": "Should Not Exist",
                "role": "owner",
            }, probe_jwt)
            step(status == "403",
                 f"an installer certainly cannot invite an owner -> {status}")

            status, denied = call_function("manage-crew-access", {
                "action": "remove_access", "user_id": owner_id,
            }, probe_jwt)
            step(status == "403",
                 f"an installer cannot remove the owner's access -> {status}")

            # Promote the PROBE only (never a real account) to supervisor, so the
            # "may not invite above your own rank" rule is tested by a caller who
            # really holds that rank rather than by a unit test.
            rest("PATCH", f"/rest/v1/profiles?id=eq.{probe_id}", {"role": "supervisor"},
                 key=SERVICE, bearer=SERVICE)
            sup = rest("GET", f"/rest/v1/profiles?id=eq.{probe_id}&select=role",
                       key=SERVICE, bearer=SERVICE)
            is_sup = isinstance(sup, list) and sup and sup[0].get("role") == "supervisor"
            step(bool(is_sup), "probe temporarily promoted to supervisor for the next checks")

            if is_sup:
                status, denied = call_function("manage-crew-access", {
                    "action": "create_invite", "display_name": "Should Not Exist",
                    "role": "owner",
                }, probe_jwt)
                step(status == "403" and "above your own role" in str(denied.get("error", "")),
                     f"a SUPERVISOR cannot invite an OWNER -> {status}: {denied.get('error')}")

                status, denied = call_function("manage-crew-access", {
                    "action": "remove_access", "user_id": owner_id,
                }, probe_jwt)
                step(status == "403",
                     f"a supervisor cannot remove the owner's access -> {status}")

                status, denied = call_function("manage-crew-access", {
                    "action": "reissue_login", "user_id": owner_id,
                }, probe_jwt)
                step(status == "403",
                     f"a supervisor cannot re-issue the OWNER's login -> {status}: "
                     f"{denied.get('error')}")

                # And the legitimate case still works, so the rule is a ladder
                # and not a wall.
                status, ok_invite = call_function("manage-crew-access", {
                    "action": "create_invite", "display_name": PROBE_NAME_NOEMAIL,
                    "role": "foreman",
                }, probe_jwt)
                minted = (ok_invite.get("invite") or {}).get("email", "")
                step(status == "200" and bool(ok_invite.get("code")),
                     f"a supervisor CAN invite a foreman -> {status}")
                # The no-email path: does Supabase accept an address on our own
                # minted domain? If not, the whole "they have no email" story is
                # broken, so assert it rather than hope.
                step(minted.endswith("@crew.infinitywindows.app"),
                     f"an invite with no email mints an internal username: {minted}")
                if ok_invite.get("code"):
                    created_emails.append(minted)
                    status, redeemed2 = call_function(
                        "redeem-crew-invite",
                        {"code": ok_invite["code"], "password": PROBE_PASSWORD + "x"}, ANON)
                    step(status == "200",
                         f"a minted-username account really can be created -> {status}: "
                         f"{redeemed2.get('error', '')}")
                    nomail_id = find_user(minted)
                    if nomail_id:
                        created_users.append(nomail_id)
                        p2 = rest("GET", f"/rest/v1/profiles?id=eq.{nomail_id}&select=role",
                                  key=SERVICE, bearer=SERVICE)
                        step(isinstance(p2, list) and p2 and p2[0].get("role") == "foreman",
                             f"that account lands as foreman: "
                             f"{p2[0].get('role') if isinstance(p2, list) and p2 else p2}")
                        step(bool(password_session(minted, PROBE_PASSWORD + "x")),
                             "and they can sign in with no real email address")

        # ---------------------------------------------------------------
        # 10. EXPIRY. A code past its date is refused, even though unused.
        # ---------------------------------------------------------------
        status, expiring = call_function("manage-crew-access", {
            "action": "create_invite", "display_name": PROBE_NAME,
            "role": "installer", "email": f"expired.{PROBE_EMAIL}",
        }, owner_jwt)
        exp_code = expiring.get("code")
        exp_id = (expiring.get("invite") or {}).get("id")
        if exp_code and exp_id:
            created_emails.append(f"expired.{PROBE_EMAIL}")
            rest("PATCH", f"/rest/v1/crew_invites?id=eq.{exp_id}",
                 {"expires_at": "2020-01-01T00:00:00Z"}, key=SERVICE, bearer=SERVICE)
            status, refused = call_function("redeem-crew-invite",
                                            {"code": exp_code, "password": PROBE_PASSWORD}, ANON)
            step(status == "409" and "expired" in str(refused.get("error", "")).lower(),
                 f"an out-of-date code is refused -> {status}: {refused.get('error')}")
            step(find_user(f"expired.{PROBE_EMAIL}") is None,
                 "and no account was created by the refused redemption")
        else:
            step(False, f"could not mint the expiry probe: {expiring}")

        # ---------------------------------------------------------------
        # 11. REVOKE. A cancelled code is refused.
        # ---------------------------------------------------------------
        status, revoking = call_function("manage-crew-access", {
            "action": "create_invite", "display_name": PROBE_NAME,
            "role": "installer", "email": f"revoked.{PROBE_EMAIL}",
        }, owner_jwt)
        rev_code = revoking.get("code")
        rev_id = (revoking.get("invite") or {}).get("id")
        if rev_code and rev_id:
            created_emails.append(f"revoked.{PROBE_EMAIL}")
            status, _ = call_function("manage-crew-access",
                                      {"action": "revoke_invite", "invite_id": rev_id}, owner_jwt)
            step(status == "200", f"the owner cancels a code -> {status}")
            status, refused = call_function("redeem-crew-invite",
                                            {"code": rev_code, "password": PROBE_PASSWORD}, ANON)
            step(status == "409" and "cancelled" in str(refused.get("error", "")).lower(),
                 f"a cancelled code is refused -> {status}: {refused.get('error')}")
            step(find_user(f"revoked.{PROBE_EMAIL}") is None,
                 "and no account was created by the cancelled code")
        else:
            step(False, f"could not mint the revoke probe: {revoking}")

        # ---------------------------------------------------------------
        # 12. A garbage code creates nothing and says nothing useful.
        # ---------------------------------------------------------------
        status, junk = call_function("redeem-crew-invite",
                                     {"code": "ZZZZZZZZZZ", "password": PROBE_PASSWORD}, ANON)
        step(status == "400" and "isn't right" in str(junk.get("error", "")),
             f"a made-up code is refused -> {status}: {junk.get('error')}")

        # ---------------------------------------------------------------
        # 13. REMOVING ACCESS really stops a sign-in.
        # ---------------------------------------------------------------
        if probe_id:
            # Put the probe back to installer first so the owner is acting on a
            # junior, which is the normal case.
            rest("PATCH", f"/rest/v1/profiles?id=eq.{probe_id}", {"role": "installer"},
                 key=SERVICE, bearer=SERVICE)
            status, removed = call_function("manage-crew-access",
                                            {"action": "remove_access", "user_id": probe_id},
                                            owner_jwt)
            step(status == "200", f"the owner removes their access -> {status}")
            step(password_session(PROBE_EMAIL, PROBE_PASSWORD) is None,
                 "the removed crew member can no longer sign in")
            gone = rest("GET", f"/rest/v1/profiles?id=eq.{probe_id}&select=access_revoked_at",
                        key=SERVICE, bearer=SERVICE)
            step(isinstance(gone, list) and gone and gone[0].get("access_revoked_at"),
                 "and the app records that their access was switched off")

            status, restored = call_function("manage-crew-access",
                                             {"action": "restore_access", "user_id": probe_id},
                                             owner_jwt)
            step(status == "200" and password_session(PROBE_EMAIL, PROBE_PASSWORD) is not None,
                 f"letting them back in works too -> {status}")

        # ---------------------------------------------------------------
        # 14. The owner cannot lock themselves out.
        # ---------------------------------------------------------------
        status, self_remove = call_function("manage-crew-access",
                                            {"action": "remove_access", "user_id": owner_id},
                                            owner_jwt)
        step(status == "400" and "your own" in str(self_remove.get("error", "")).lower(),
             f"the owner cannot remove their own access -> {status}: {self_remove.get('error')}")

    finally:
        cleanup(created_users, created_emails)

    after = roster()
    print(f"\nRoster after:  {after}")
    step(after == before, "the roster is exactly what it was before this ran")

    print()
    if failures:
        print(f"FAILED ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"All {step_no} checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
