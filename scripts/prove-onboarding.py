#!/usr/bin/env python3
"""Prove that an owner can still onboard a new crew member, end to end.

    export SUPABASE_ACCESS_TOKEN=sbp_...
    SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/prove-onboarding.py

Why this exists. Self-signup is switched off, so the ONLY way a new person gets
into this app is: they request access, a supervisor or the owner approves it on
the Admin screen, and that approval creates their login. If that path breaks,
nobody new can ever get in again — which is a worse outcome than the permissive
signup it replaced. It has already been broken once, silently: "Approve" used to
write `status = 'approved'` and create no account at all, and the owner's report
was "when I admin approve his login it still won't work".

Nothing here is a mock. It submits a real access request as a signed-out
visitor, approves it as the real owner, signs in as the person who was just
created, and then deletes everything it made. It asserts the ROSTER IS BACK TO
WHAT IT WAS before it exits, so a half-finished run is visible rather than
silent.

Every step asserts its own effect. "No error was raised" is not evidence: a
forbidden write under row-level security matches zero rows and returns success.

Safe to run against production, and meant to be. It leaves no user, no profile
and no access request behind, and it never changes an existing account: the
owner session is a one-time magic link minted with the admin API (which sends no
mail and does not touch his password).
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
        "  SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/prove-onboarding.py"
    )
TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
if not TOKEN:
    sys.exit("set SUPABASE_ACCESS_TOKEN to an sbp_ management token")

API = f"https://{REF}.supabase.co"
MGMT = "https://api.supabase.com/v1"

# The approver. Any owner or supervisor would do; this one is read from the
# roster rather than hard-coded, so the script does not rot when people change.
APPROVER_MIN_RANK = 2

# Throwaway identities. The domain is real so Supabase's address validation
# accepts it; no mail is ever sent, because the account is created pre-confirmed.
PROBE = "qa.onboarding.probe@horizonsolarusa.com"
PROBE2 = "qa.onboarding.probe2@horizonsolarusa.com"
STRANGER = "qa.stranger.selfsignup@horizonsolarusa.com"

RANK = {"owner": 3, "big_boss": 3, "supervisor": 2, "admin": 2, "foreman": 1, "lead": 1}


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
    anon = service = None
    if not isinstance(keys, list):
        sys.exit("could not read the project API keys")
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


def step(label: str, ok: bool, detail: str) -> None:
    print(f"  {label:<4} {'PASS' if ok else 'FAIL'}  {detail}")
    if not ok:
        failures.append(f"{label}: {detail}")


def rest(method: str, path: str, body=None, key: str | None = None, bearer: str | None = None):
    key = key or ANON
    args = ["-X", method, f"{API}{path}", "-H", f"apikey: {key}",
            "-H", f"Authorization: Bearer {bearer or key}",
            "-H", "Content-Type: application/json"]
    if body is not None:
        return parse(curl([*args, "--data-binary", "@-"], json.dumps(body)))
    return parse(curl(args))


def call_function(name: str, body: dict, bearer: str) -> tuple[str, dict]:
    """Invoke an edge function ONCE and return (http status, parsed body).

    Exactly once matters here: this endpoint creates accounts, so a helper that
    quietly retried would make two people and then report a conflict it caused
    itself. The status code is appended after a newline rather than fetched by a
    second request.
    """
    out = curl(["-w", "\n%{http_code}", "-X", "POST",
                f"{API}/functions/v1/{name}", "-H", f"apikey: {ANON}",
                "-H", f"Authorization: Bearer {bearer}",
                "-H", "Content-Type: application/json", "--data-binary", "@-"],
               json.dumps(body))
    payload, _, status = out.rpartition("\n")
    return status.strip(), parse(payload)


def admin_delete_user(user_id: str) -> None:
    curl(["-X", "DELETE", f"{API}/auth/v1/admin/users/{user_id}",
          "-H", f"apikey: {SERVICE}", "-H", f"Authorization: Bearer {SERVICE}"])


def cleanup(user_ids: list[str]) -> None:
    for uid in [u for u in user_ids if u]:
        admin_delete_user(uid)
        rest("DELETE", f"/rest/v1/profiles?id=eq.{uid}", key=SERVICE, bearer=SERVICE)
    for email in (PROBE, PROBE2):
        rest("DELETE", f"/rest/v1/access_requests?email=eq.{email}", key=SERVICE, bearer=SERVICE)


def roster() -> str:
    rows = rest("GET", "/rest/v1/profiles?select=display_name,role&order=display_name",
                key=SERVICE, bearer=SERVICE)
    if not isinstance(rows, list):
        return f"unreadable: {rows}"
    return ", ".join(f"{r['display_name']}={r['role']}" for r in rows)


def owner_session() -> tuple[str, str]:
    """A session for a real owner, without knowing or changing their password."""
    people = rest("GET", "/rest/v1/profiles?select=id,display_name,role",
                  key=SERVICE, bearer=SERVICE)
    approver = next(
        (p for p in people if RANK.get(p.get("role"), 0) >= APPROVER_MIN_RANK), None)
    if not approver:
        sys.exit("no supervisor or owner exists in this project, so nobody could approve")
    users = parse(curl([f"{API}/auth/v1/admin/users?per_page=200",
                        "-H", f"apikey: {SERVICE}", "-H", f"Authorization: Bearer {SERVICE}"]))
    email = next((u["email"] for u in users.get("users", []) if u["id"] == approver["id"]), None)
    if not email:
        sys.exit("the approver has a profile but no auth account")
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
        sys.exit(f"could not obtain an approver session: {json.dumps(session)[:300]}")
    return jwt, f"{approver['display_name']} ({approver['role']})"


def main() -> None:
    before = roster()
    print(f"=== onboarding proof against {REF}")
    print(f"  roster before: {before}")

    created: list[str] = []
    try:
        # A0 — can a stranger still make themselves an account? Measured, not
        # assumed, and the user it would create is deleted immediately.
        signup = parse(curl(["-X", "POST", f"{API}/auth/v1/signup", "-H", f"apikey: {ANON}",
                             "-H", "Content-Type: application/json", "--data-binary", "@-"],
                            json.dumps({"email": STRANGER, "password": "strangerpw123"})))
        stranger_id = (signup.get("user") or {}).get("id") or signup.get("id")
        if stranger_id:
            admin_delete_user(stranger_id)
            rest("DELETE", f"/rest/v1/profiles?id=eq.{stranger_id}", key=SERVICE, bearer=SERVICE)
        step("A0", not stranger_id,
             "a stranger self-signup is refused: " + (
                 "IT SUCCEEDED - self-signup is still open" if stranger_id
                 else json.dumps(signup)[:120]))

        # E1 — the request, exactly as SignIn.tsx submits it: an anon insert with
        # no read-back, because anon holds no SELECT policy on the queue.
        rest("POST", "/rest/v1/access_requests",
             {"name": "QA Onboarding Probe", "email": PROBE, "requested_role": "supervisor"})
        rest("POST", "/rest/v1/access_requests",
             {"name": "QA Onboarding Probe 2", "email": PROBE2, "requested_role": "installer"})

        def request_id(email: str):
            rows = rest("GET", f"/rest/v1/access_requests?email=eq.{email}&select=id",
                        key=SERVICE, bearer=SERVICE)
            return rows[0]["id"] if isinstance(rows, list) and rows else None

        req, req2 = request_id(PROBE), request_id(PROBE2)
        step("E1", bool(req and req2), f"a signed-out visitor submitted an access request ({req})")
        if not (req and req2):
            raise SystemExit("the request never landed; nothing else can be tested")

        jwt, who = owner_session()

        # E2 — the approval, which must create the account, not just a status.
        code, approved = call_function("approve-access-request", {"request_id": req}, jwt)
        ok = code == "200" and bool(approved.get("ok"))
        step("E2", ok, f"{who} approved it: HTTP {code} "
                       f"{json.dumps({k: v for k, v in approved.items() if k != 'temporary_password'})[:160]}")
        if not ok:
            raise SystemExit("approval did not create an account")
        created.append(approved["user_id"])

        # E3 — the whole point: can that person actually sign in?
        login = parse(curl(["-X", "POST", f"{API}/auth/v1/token?grant_type=password",
                            "-H", f"apikey: {ANON}", "-H", "Content-Type: application/json",
                            "--data-binary", "@-"],
                           json.dumps({"email": PROBE, "password": approved["temporary_password"]})))
        new_jwt = login.get("access_token")
        step("E3", bool(new_jwt) and (login.get("user") or {}).get("id") == approved["user_id"],
             "the new person signed in with the one-time password " + (
                 "- session issued" if new_jwt else json.dumps(login)[:160]))

        # E4 — and lands as an installer, on the crew list, not as anything else.
        prof = rest("GET",
                    f"/rest/v1/profiles?id=eq.{approved['user_id']}&select=display_name,role,active",
                    bearer=new_jwt) if new_jwt else []
        got = prof[0] if isinstance(prof, list) and prof else {}
        step("E4", got.get("role") == "installer" and got.get("active") is True,
             f"they land as an installer on the crew list: {json.dumps(got)}")

        # E5 — the gate: that new installer must not be able to approve anyone.
        if new_jwt:
            code5, denied = call_function("approve-access-request", {"request_id": req2}, new_jwt)
            step("E5", code5 == "403",
                 f"the new installer tried to approve someone else: HTTP {code5} {json.dumps(denied)[:120]}")

        # E6/E7 — a second approval works, and approving the same person twice is
        # refused rather than silently resetting an existing account's password.
        code6, second = call_function("approve-access-request", {"request_id": req2}, jwt)
        step("E6", code6 == "200" and bool(second.get("user_id")), f"a second approval works: HTTP {code6}")
        if second.get("user_id"):
            created.append(second["user_id"])
            code7, again = call_function("approve-access-request", {"request_id": req2}, jwt)
            step("E7", code7 == "409" and "already has an account" in json.dumps(again),
                 f"approving the same person twice is refused: HTTP {code7}")
    finally:
        cleanup(created)

    after = roster()
    step("C1", after == before, f"roster is back to what it was: {after}")
    left = rest("GET", f"/rest/v1/access_requests?or=(email.eq.{PROBE},email.eq.{PROBE2})&select=id",
                key=SERVICE, bearer=SERVICE)
    step("C2", isinstance(left, list) and not left, "no test access request left behind")

    print()
    if failures:
        print(f"FAIL: {len(failures)} step(s) failed")
        for f in failures:
            print(f"  {f}")
        raise SystemExit(1)
    print("ALL CHECKS PASSED: an owner can onboard a new crew member, and a stranger cannot.")


if __name__ == "__main__":
    main()
