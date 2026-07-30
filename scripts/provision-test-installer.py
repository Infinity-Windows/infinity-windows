#!/usr/bin/env python3
"""Create (or repair) the one test login, through the real crew-invite flow.

    export SUPABASE_ACCESS_TOKEN=sbp_...
    export TEST_INSTALLER_PASSWORD=...            # never printed, never stored here
    SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/provision-test-installer.py

    # and to take the whole thing away again:
    SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/provision-test-installer.py --remove

WHY THIS EXISTS. Almost every screen in this app needs a login, and until now
the only logins that existed belonged to real people. So a fix could be shipped
and never actually seen on the screen it fixed — which is how "plans do not
render on iPhones" survived: nobody could open the screen to check. This makes
one durable installer-role account whose credentials are written down, so the
next agent spends no time on it. See docs/test-account.md.

IT INVENTS NOTHING. Public signup is off and stays off. The account is created
by minting a real invite through manage-crew-access and redeeming it through
redeem-crew-invite, exactly as an owner adding a new hire would — so this also
road-tests that flow every time it runs. It authenticates as the service role,
which those functions already trust at owner rank because it holds the key that
could do all of this directly; no real person's session is used and no real
account is touched.

RUN IT AGAIN WHENEVER YOU LIKE. If the account already exists it is repaired
rather than duplicated: `reissue_login` mints a fresh code, redeeming it sets the
password to whatever TEST_INSTALLER_PASSWORD now holds, and the role is left
alone. That is how a lost password is recovered — the same no-email reset path a
real installer would get.

WHAT IT IS ALLOWED TO BE. `installer`, and nothing above it. Every check at the
end asserts the EFFECT rather than the absence of an error, because a write
forbidden by row-level security matches zero rows and returns success.

WHY IT CANNOT SPOIL THE COMPANY'S NUMBERS. install_events is empty on
production, so the first rows ever written set the target time, the slow-case
time and the learned difficulty for a window type forever. Migration
20260730120000 excludes any profile flagged `is_test` from those rollups, from
the per-installer stats dispatch ranks on, and from golden-install nomination.
This script sets that flag, and then PROVES the exclusion holds by writing a
real install event and asserting the rollups did not move — against a window
type it created for the purpose, so a filter that failed could not reach a type
the crew install. It deletes the event afterwards.

Safe to run against production, and meant to be.
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
        "  SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/provision-test-installer.py"
    )
TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
if not TOKEN:
    sys.exit("set SUPABASE_ACCESS_TOKEN to an sbp_ management token")

REMOVE = "--remove" in sys.argv[1:]

PASSWORD = os.environ.get("TEST_INSTALLER_PASSWORD", "")
if not REMOVE and len(PASSWORD) < 8:
    sys.exit(
        "set TEST_INSTALLER_PASSWORD to the password this account should have\n"
        "(at least 8 characters). It is never printed, logged or stored by this\n"
        "script. See docs/test-account.md for where the value lives."
    )

API = f"https://{REF}.supabase.co"
MGMT = "https://api.supabase.com/v1"

# The login. An address on the domain the app mints for crew with no email, so
# it is obvious that nothing is ever sent to it and nobody is waiting on mail.
TEST_EMAIL = "qa.installer@crew.infinitywindows.app"

# Unmistakable in a crew list, a leaderboard, a timecard and an assignment
# picker. A foreman who sees this cannot mistake it for a person.
TEST_NAME = "TEST — automation, do not assign"

# The sandbox. ZZ so it sorts last in every job list, and every label says TEST.
TEST_JOB_CODE = "ZZTEST"
TEST_JOB_NAME = "TEST — automation sandbox, not a real job"
TEST_TYPE_CODE = "ZZTEST-TYPE"
TEST_TYPE_NAME = "TEST — automation window type, not a real product"
TEST_OPENING_CODE = "TEST-1"


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
        if k.get("name") in ("service_role", "secret") or \
           k.get("type") in ("service_role", "secret"):
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


def rest(method: str, path: str, body=None, *, key: str | None = None,
         bearer: str | None = None, prefer: str | None = None):
    key = key or ANON
    args = ["-X", method, f"{API}{path}", "-H", f"apikey: {key}",
            "-H", f"Authorization: Bearer {bearer or key}",
            "-H", "Content-Type: application/json"]
    if prefer:
        args += ["-H", f"Prefer: {prefer}"]
    if body is not None:
        return parse(curl([*args, "--data-binary", "@-"], json.dumps(body)))
    return parse(curl(args))


def admin(method: str, path: str, body=None):
    args = ["-X", method, f"{API}{path}", "-H", f"apikey: {SERVICE}",
            "-H", f"Authorization: Bearer {SERVICE}",
            "-H", "Content-Type: application/json"]
    if body is not None:
        return parse(curl([*args, "--data-binary", "@-"], json.dumps(body)))
    return parse(curl(args))


def call_function(name: str, body: dict, bearer: str) -> tuple[str, dict]:
    """Invoke an edge function ONCE, returning (http status, parsed body).

    Exactly once matters: these endpoints create accounts, so a helper that
    quietly retried could make two.
    """
    out = curl(["-w", "\n%{http_code}", "-X", "POST",
                f"{API}/functions/v1/{name}", "-H", f"apikey: {ANON}",
                "-H", f"Authorization: Bearer {bearer}",
                "-H", "Content-Type: application/json", "--data-binary", "@-"],
               json.dumps(body))
    payload, _, status = out.rpartition("\n")
    return status.strip(), parse(payload)


def find_user(email: str) -> str | None:
    users = admin("GET", "/auth/v1/admin/users?per_page=200")
    for u in users.get("users", []):
        if (u.get("email") or "").lower() == email.lower():
            return u["id"]
    return None


def password_session(email: str, password: str) -> str | None:
    got = parse(curl(["-X", "POST", f"{API}/auth/v1/token?grant_type=password",
                      "-H", f"apikey: {ANON}", "-H", "Content-Type: application/json",
                      "--data-binary", "@-"],
                     json.dumps({"email": email, "password": password})))
    return got.get("access_token")


def one(rows) -> dict:
    return rows[0] if isinstance(rows, list) and rows else {}


def svc(method: str, path: str, body=None, *, prefer: str | None = None):
    return rest(method, path, body, key=SERVICE, bearer=SERVICE, prefer=prefer)


# ---------------------------------------------------------------------------
# The sandbox: a job, a window type and one opening, all obviously not real.
# ---------------------------------------------------------------------------
# WHY a sandbox at all. Black Desert (42 openings) and Smith Residence are live
# jobs with real assignments and real field work on them. A test account that
# clocks into one, or marks one of its openings installed, is editing the
# company's record of a job it is being paid for. So anything this account is
# asked to DO happens here instead. It can still READ the real jobs — every
# installer can, and the plan screens are the whole reason this login exists.


def ensure_sandbox() -> tuple[str, str, str]:
    """Job, window type and opening ids, created if absent. Idempotent."""
    proj = one(svc("GET", f"/rest/v1/projects?job_code=eq.{TEST_JOB_CODE}&select=id"))
    if not proj:
        proj = one(svc("POST", "/rest/v1/projects",
                       {"job_code": TEST_JOB_CODE, "name": TEST_JOB_NAME,
                        "address": "TEST — no such address", "status": "active"},
                       prefer="return=representation"))
    wtype = one(svc("GET", f"/rest/v1/window_types?type_code=eq.{TEST_TYPE_CODE}&select=id"))
    if not wtype:
        wtype = one(svc("POST", "/rest/v1/window_types",
                        {"type_code": TEST_TYPE_CODE, "name": TEST_TYPE_NAME,
                         "category": "test",
                         "notes": "Automation only. Never ordered, never installed. "
                                  "Exists so a test login has something to tap that "
                                  "is not a real product."},
                        prefer="return=representation"))
    if not proj.get("id") or not wtype.get("id"):
        return "", "", ""

    opening = one(svc(
        "GET",
        f"/rest/v1/project_openings?project_id=eq.{proj['id']}"
        f"&opening_code=eq.{TEST_OPENING_CODE}&select=id"))
    if not opening:
        opening = one(svc("POST", "/rest/v1/project_openings",
                          {"project_id": proj["id"],
                           "opening_code": TEST_OPENING_CODE,
                           "window_type_id": wtype["id"],
                           "label": "TEST — automation opening",
                           "page_number": 1},
                          prefer="return=representation"))
    return proj.get("id", ""), wtype.get("id", ""), opening.get("id", "")


def remove_sandbox() -> None:
    proj = one(svc("GET", f"/rest/v1/projects?job_code=eq.{TEST_JOB_CODE}&select=id"))
    if proj.get("id"):
        # project_openings and their install_events cascade from the project.
        svc("DELETE", f"/rest/v1/projects?id=eq.{proj['id']}")
        # Staging bays are created by a trigger on projects and do not cascade.
        svc("DELETE", f"/rest/v1/locations?rack=eq.{TEST_JOB_CODE}")
    svc("DELETE", f"/rest/v1/window_types?type_code=eq.{TEST_TYPE_CODE}")


def remove() -> int:
    """Take the whole thing away, so nothing here is a one-way door."""
    uid = find_user(TEST_EMAIL)
    if uid:
        admin("DELETE", f"/auth/v1/admin/users/{uid}")
        svc("DELETE", f"/rest/v1/profiles?id=eq.{uid}")
    svc("DELETE", f"/rest/v1/crew_invites?email=eq.{TEST_EMAIL}")
    remove_sandbox()

    step(find_user(TEST_EMAIL) is None, "the test login no longer exists")
    step(not one(svc("GET", f"/rest/v1/projects?job_code=eq.{TEST_JOB_CODE}&select=id")),
         "the test job is gone")
    step(not one(svc("GET", f"/rest/v1/window_types?type_code=eq.{TEST_TYPE_CODE}&select=id")),
         "the test window type is gone")
    return 0


def main() -> int:
    if REMOVE:
        print("\nRemoving the test account and its sandbox.\n")
        return remove()

    # -------------------------------------------------------------------
    # 1. The account, through the invite flow and nothing else.
    # -------------------------------------------------------------------
    existing = find_user(TEST_EMAIL)

    if existing:
        status, made = call_function("manage-crew-access", {
            "action": "reissue_login", "user_id": existing,
        }, SERVICE)
        step(status == "200" and bool(made.get("code")),
             f"account exists, so a fresh login code was minted for it -> {status}"
             f"{'' if status == '200' else ': ' + str(made.get('error'))}")
    else:
        status, made = call_function("manage-crew-access", {
            "action": "create_invite",
            "display_name": TEST_NAME,
            "role": "installer",
            "email": TEST_EMAIL,
        }, SERVICE)
        step(status == "200" and bool(made.get("code")),
             f"an installer invite was minted -> {status}"
             f"{'' if status == '200' else ': ' + str(made.get('error'))}")

    code = made.get("code") or ""
    if not code:
        print(f"      cannot continue: {made}")
        return 1

    status, redeemed = call_function(
        "redeem-crew-invite", {"code": code, "password": PASSWORD}, ANON)
    step(status == "200",
         f"the code was redeemed, which is what sets the password -> {status}"
         f"{'' if status == '200' else ': ' + str(redeemed.get('error'))}")

    uid = find_user(TEST_EMAIL)
    step(bool(uid), "a login exists for the test address")
    if not uid:
        return 1

    # -------------------------------------------------------------------
    # 2. Least privilege, and the flag that keeps it out of the numbers.
    # -------------------------------------------------------------------
    # active=false is "not on site today", which is how the Roster and the
    # assignment pickers decide who is available. It does not affect signing in
    # or which screens the account can reach — those go by role.
    svc("PATCH", f"/rest/v1/profiles?id=eq.{uid}",
        {"is_test": True, "active": False, "display_name": TEST_NAME})

    prof = one(svc("GET", f"/rest/v1/profiles?id=eq.{uid}"
                          "&select=display_name,role,active,is_test,access_revoked_at"))
    step(prof.get("role") == "installer",
         f"the role is installer and nothing higher: {prof.get('role')}")
    step(prof.get("is_test") is True,
         f"it is flagged as a test account: is_test={prof.get('is_test')}")
    step(prof.get("active") is False,
         "it is not marked on-site, so it is not offered up for assignment")
    step(prof.get("display_name") == TEST_NAME,
         f"the name says what it is: {prof.get('display_name')}")
    step(prof.get("access_revoked_at") is None, "its access is switched on")

    jwt = password_session(TEST_EMAIL, PASSWORD)
    step(bool(jwt), "it can sign in with the password this run was given")

    # -------------------------------------------------------------------
    # 3. It really is only an installer. Asserted from its own session.
    # -------------------------------------------------------------------
    if jwt:
        foreman_plus = rest("POST", "/rest/v1/rpc/is_foreman_plus", {"p_uid": uid},
                            key=ANON, bearer=jwt)
        step(foreman_plus is False,
             f"the database does not treat it as foreman or above: {foreman_plus}")

        invites = rest("GET", "/rest/v1/crew_invites?select=id", key=ANON, bearer=jwt)
        step(not (isinstance(invites, list) and invites),
             "it cannot see who has been offered access")

        status, denied = call_function("manage-crew-access", {
            "action": "create_invite", "display_name": "Should Not Exist",
            "role": "owner",
        }, jwt)
        step(status == "403", f"it cannot hand out any login, least of all an owner's -> {status}")

        # The reason this account exists: an installer must reach the jobs list
        # and a plan set. If this ever fails, the login is useless for the thing
        # it was made for.
        jobs = rest("GET", "/rest/v1/projects?select=id,job_code,name&limit=50",
                    key=ANON, bearer=jwt)
        step(isinstance(jobs, list) and len(jobs) > 0,
             f"it can open the jobs list: {len(jobs) if isinstance(jobs, list) else 0} job(s) visible")

        plansets = rest("GET", "/rest/v1/project_plansets?select=id,project_id&limit=10",
                        key=ANON, bearer=jwt)
        step(isinstance(plansets, list),
             f"it can read plan sets: {len(plansets) if isinstance(plansets, list) else 'unreadable'} visible")

    # -------------------------------------------------------------------
    # 4. PROVE its work cannot move the company's figures.
    # -------------------------------------------------------------------
    # Not "we added a filter". A real install event, written as this account,
    # and then the assertion that target time, the slow case and learned
    # difficulty did not budge. Deliberately against the TEST window type, so a
    # filter that failed could only mark up a type nobody installs — and the
    # correct state of that type is knowable exactly (no installs, no numbers).
    project_id, type_id, opening_id = ensure_sandbox()
    step(bool(project_id and type_id and opening_id),
         f"the sandbox job {TEST_JOB_CODE} exists, with one opening to tap")

    if type_id and opening_id:
        event = one(svc("POST", "/rest/v1/install_events",
                        {"project_opening_id": opening_id,
                         "window_type_id": type_id,
                         "installer_id": uid,
                         "installer": TEST_EMAIL,
                         "minutes": 7,
                         "quality_grade": 5},
                        prefer="return=representation"))
        step(bool(event.get("id")), "an install event was recorded as the test account")

        rolled = one(svc("GET", f"/rest/v1/window_types?id=eq.{type_id}"
                                "&select=n_installs,median_minutes,p90_minutes,"
                                "avg_grade,learned_difficulty,golden_install_event_id"))
        step(rolled.get("n_installs") == 0,
             f"it was not counted: n_installs={rolled.get('n_installs')}")
        step(rolled.get("median_minutes") is None and rolled.get("p90_minutes") is None,
             f"it set no target time and no slow-case time: "
             f"median={rolled.get('median_minutes')}, p90={rolled.get('p90_minutes')}")
        step(rolled.get("learned_difficulty") is None,
             f"it taught the app no difficulty: {rolled.get('learned_difficulty')}")
        step(rolled.get("golden_install_event_id") is None,
             "it was not held up to the crew as the worked example")

        mine = svc("GET", f"/rest/v1/installer_type_stats?installer_id=eq.{uid}&select=n")
        step(isinstance(mine, list) and not mine,
             "it appears in no per-installer stats, so dispatch cannot rank on it")

        if event.get("id"):
            svc("DELETE", f"/rest/v1/install_events?id=eq.{event['id']}")
            step(not one(svc("GET", f"/rest/v1/install_events?id=eq.{event['id']}&select=id")),
                 "and the event was cleaned up again")

    total = svc("GET", "/rest/v1/install_events?select=id")
    step(isinstance(total, list) and len(total) == 0,
         f"install_events is still empty, so no baseline has been set by anything: "
         f"{len(total) if isinstance(total, list) else '?'} row(s)")

    print()
    if failures:
        print(f"FAILED ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"All {step_no} checks passed.")
    print(f"\nSign in at the app with {TEST_EMAIL}.")
    print("The password is the value of TEST_INSTALLER_PASSWORD, which this run")
    print("never printed. See docs/test-account.md for where to find it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
