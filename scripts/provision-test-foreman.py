#!/usr/bin/env python3
"""Create (or repair) the test FOREMAN login, and prove it cannot reach a real job.

    export SUPABASE_ACCESS_TOKEN=sbp_...
    export TEST_FOREMAN_PASSWORD=...              # never printed, never stored here
    SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/provision-test-foreman.py

    # and to take it away again:
    SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/provision-test-foreman.py --remove

WHY A SECOND TEST LOGIN. The first one (docs/test-account.md) is an installer, so
the foreman half of the app has never been opened by anything but a real person.
Three fixes in a row shipped that way: dragging a mark on the plan, the Undo bar,
the reset-to-original buttons, and since #211 re-reading a plan set and deleting
an opening, are all foreman-or-above, and none of them had been seen working.
The alternative was manufacturing changes on Taylor's real jobs, which is not an
alternative.

WHY THAT IS DANGEROUS, AND WHAT IS DONE ABOUT IT. Foreman is the most powerful
role short of supervisor here. Re-extraction is the highest-consequence action in
the app: a bug in that path earlier this week could have destroyed measurements,
assignments and QC checks through cascading deletes (fixed in PR #132). An
unattended automation account holding that on production is not acceptable, so
Taylor's instruction was that this account be kept pointed at the test sandbox
job. That is a CONTROL, not a convention:

  migration 20260730220000 refuses any INSERT, UPDATE or DELETE by a profile
  flagged `is_test` unless the row belongs to a project listed in
  `public.sandbox_projects`.

It is a BEFORE trigger on every project-scoped table plus three restrictive
storage policies, so it also covers the SECURITY DEFINER undo/reset RPCs, which
run past row-level security entirely. Nothing about a real foreman changes: every
guard returns immediately unless the caller is a test account.

HOW THIS RUN PROVES IT, WITHOUT AIMING A DESTRUCTIVE PROBE AT A CUSTOMER. The
genuinely destructive attempts — delete an opening, delete a job, move a mark,
undo somebody's move, overwrite a plan set — are aimed at a THROWAWAY job this
run creates and deletes again (`ZZTEST-DECOY`). To the guard it is an ordinary
non-sandbox project, so the proof transfers exactly; if the guard were broken,
the damage would land on a job created ninety seconds earlier that nothing
depends on. Against the real jobs the only probe is an update that writes a
column back to the value it already holds: refused if the guard is armed, and
literally nothing if it were not. Black Desert's mark #37 is never touched.

Safe to run against production, and meant to be.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.supabase_rest import Client, Steps, one  # noqa: E402
from lib.tiny_pdf import HEIGHT, MARK_PINS, WIDTH, sandbox_plan_pdf  # noqa: E402

REMOVE = "--remove" in sys.argv[1:]
CHECK_MIGRATION = "--check-migration" in sys.argv[1:]

PASSWORD = os.environ.get("TEST_FOREMAN_PASSWORD", "")
if not REMOVE and not CHECK_MIGRATION and len(PASSWORD) < 8:
    sys.exit(
        "set TEST_FOREMAN_PASSWORD to the password this account should have\n"
        "(at least 8 characters). It is never printed, logged or stored by this\n"
        "script. See docs/test-account.md for where the value lives."
    )

# An address on the domain the app mints for crew with no email, so it is obvious
# nothing is ever sent to it and nobody is waiting on mail.
TEST_EMAIL = "qa.foreman@crew.infinitywindows.app"

# Unmistakable in a crew list, an assignment picker and a dispatch board, and it
# says which of the two robots it is. Same spirit as the installer's
# "TEST — automation, do not assign".
TEST_NAME = "TEST — automation FOREMAN, do not assign"

# The sandbox, shared with the installer test account.
SANDBOX_CODE = "ZZTEST"
SANDBOX_NAME = "TEST — automation sandbox, not a real job"
TYPE_CODE = "ZZTEST-TYPE"
TYPE_NAME = "TEST — automation window type, not a real product"

# The throwaway. Created for the refusal probes and deleted again in the same
# run, so Taylor never sees it in his jobs list.
DECOY_CODE = "ZZTEST-DECOY"
DECOY_NAME = "TEST — decoy job, the robot must be refused here"

# Black Desert door #37, repaired by 20260730130000 after Taylor moved it by
# accident. Excluded from every probe by id as well as by code.
DO_NOT_TOUCH = "b1a6266b-87a0-42fa-a56a-2f9de83793f1"

sb = Client()
steps = Steps()

# The migrations that build the cage, and keep it built. Named here rather than
# discovered so a renamed file is a loud failure instead of a silent skip.
GUARD_MIGRATIONS = (
    "supabase/migrations/20260730220000_test_accounts_sandbox_only.sql",
    "supabase/migrations/20260965000000_sandbox_guard_rearm.sql",
)


def guard_is_installed() -> tuple[bool, str]:
    """Is the sandbox cage actually on this database?

    Asked before anything is created. A foreman test login on a database where
    the guard failed to deploy is precisely the thing this whole change exists
    to avoid, and "the migration is in the repo" is not the same claim as "the
    migration is on the server" — that gap is how production ended up 26 tables
    short of the migrations in July.

    This used to ask whether ANY table carried the guard trigger. That answer
    stayed yes the whole time the fence was rotting: the attach loop in
    20260730220000 ran once, fourteen project-scoped tables were created after
    it, and on 2026-09-02 the QA foreman login wrote to a live job while this
    check happily reported the cage installed. It now counts the tables that
    are project-scoped and NOT guarded, and any of those is a no.
    """
    got = sb.sql(
        "select "
        "  (to_regclass('public.sandbox_projects') is not null) as table_there, "
        "  (select count(*) from public.test_account_write_scope() "
        "     where link_column is not null) as scoped, "
        "  (select count(*) from public.test_account_write_scope() "
        "     where link_column is not null and not guarded) as unguarded, "
        "  (select count(*) from pg_policies where schemaname = 'storage' "
        "     and tablename = 'objects' "
        "     and policyname like 'test logins write only their sandbox%') as policies"
    )
    row = got[0] if isinstance(got, list) and got else {}
    if not row:
        return False, f"could not ask the database: {got}"
    ok = (row.get("table_there") is True
          and int(row.get("scoped") or 0) > 0
          and int(row.get("unguarded") or 0) == 0
          and int(row.get("policies") or 0) == 3)
    return ok, (f"sandbox_projects={row.get('table_there')}, "
                f"guarded tables="
                f"{int(row.get('scoped') or 0) - int(row.get('unguarded') or 0)}"
                f"/{row.get('scoped')}, "
                f"storage policies={row.get('policies')}/3")


def check_migration() -> int:
    """Apply the guard migrations inside a transaction and roll them back.

    So the SQL can be proved to parse and run against the real database BEFORE
    the merge that deploys it. `supabase db push` applies each file in its own
    transaction and stops at the first failure, so a migration with a typo in it
    does not just fail to ship itself — it blocks everybody else's deploy until
    somebody notices.

    Both files, in order: 20260965000000 rebuilds the attach loop as a callable
    function and then asks the census whether the fence is complete, so running
    it is the only way to see that half of the cage work without merging first.
    """
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for relative in GUARD_MIGRATIONS:
        path = os.path.join(repo, relative)
        if not os.path.exists(path):
            print(f"FAIL  {relative} is not in this checkout")
            return 1
        with open(path, encoding="utf-8") as fh:
            body = fh.read()

        print(f"\nDry run: applying {relative} and rolling it back.\n")
        got = sb.sql(f"begin;\n{body}\nrollback;")
        if isinstance(got, dict) and got.get("message"):
            print(f"  FAIL  the migration would not apply: {got.get('message')}")
            return 1
        print("  PASS  the migration applies cleanly, and was rolled back")

    print("\nNothing was changed. Merge the PR to apply it for real.")
    return 0


def same(a, b) -> bool:
    """Two normalised pin coordinates, compared as the database stores them."""
    if a is None or b is None:
        return a is None and b is None
    return round(float(a), 9) == round(float(b), 9)


def refused(status: str, body) -> bool:
    """Was this attempt turned away, rather than quietly matching zero rows?

    A 2xx here is a failure of the guard even when nothing appears to have
    changed, because "no rows matched" and "you may not do that" look identical
    from the outside. Every negative check pairs this with a re-read of the row.
    """
    if not status.startswith("4") and not status.startswith("5"):
        return False
    text = str(body)
    return "test login" in text or "42501" in text or "permission" in text.lower()


# ---------------------------------------------------------------------------
# The sandbox: a job with a plan sheet and four pinned marks
# ---------------------------------------------------------------------------
# The installer script creates the job, the window type and one unpinned
# opening. The foreman needs more than that: the project map only offers a
# draggable mark when the job has a building PDF, and the Undo bar lives inside
# that view, so without a plan sheet none of the controls this account exists to
# check are even on the screen.


def ensure_sandbox() -> tuple[str, str, list[dict]]:
    project = one(sb.svc("GET", f"/rest/v1/projects?job_code=eq.{SANDBOX_CODE}&select=id"))
    if not project:
        project = one(sb.svc("POST", "/rest/v1/projects",
                             {"job_code": SANDBOX_CODE, "name": SANDBOX_NAME,
                              "address": "TEST — no such address", "status": "active"},
                             prefer="return=representation"))
    project_id = project.get("id", "")
    if not project_id:
        return "", "", []

    # Register it as the one project a test login may write. The migration seeds
    # this row too; this is here for a database where the job was created after
    # the migration ran.
    if not one(sb.svc("GET", f"/rest/v1/sandbox_projects?project_id=eq.{project_id}"
                             "&select=project_id")):
        sb.svc("POST", "/rest/v1/sandbox_projects",
               {"project_id": project_id,
                "note": "TEST — automation sandbox. The only job a test login may write."})

    wtype = one(sb.svc("GET", f"/rest/v1/window_types?type_code=eq.{TYPE_CODE}&select=id"))
    if not wtype:
        wtype = one(sb.svc("POST", "/rest/v1/window_types",
                           {"type_code": TYPE_CODE, "name": TYPE_NAME,
                            "category": "test",
                            "notes": "Automation only. Never ordered, never installed."},
                           prefer="return=representation"))
    type_id = wtype.get("id", "")

    # The plan sheet. Upserted at a fixed path so re-running does not pile up
    # documents, and re-uploaded every time so a corrupted object repairs itself.
    path = f"{project_id}/zztest-sandbox-plan.pdf"
    status, _ = sb.upload("plansets", path, sandbox_plan_pdf(), "application/pdf")
    steps.check(status.startswith("2"), f"the sandbox plan sheet is in storage -> {status}")

    planset = one(sb.svc(
        "GET",
        f"/rest/v1/project_plansets?project_id=eq.{project_id}"
        f"&storage_path=eq.{path}&select=id"))
    if not planset:
        planset = one(sb.svc("POST", "/rest/v1/project_plansets",
                             {"project_id": project_id, "storage_path": path,
                              "source_format": "pdf", "kind": "building",
                              "status": "ready", "page_count": 1},
                             prefer="return=representation"))
    planset_id = planset.get("id", "")

    # One mark per callout the sheet prints. Enough that the Undo bar has a stack
    # to walk back and "put every mark back" has something to count.
    #
    # Coded `1-1` … `6-1` rather than `TEST-1` … `TEST-4`, because the app prints
    # the code with any trailing `-n` stripped (openingMarkCode). Under the old
    # names every dot read "TEST" and the Undo button said "Undo moving mark
    # TEST", which is the wrong shape for the one sentence this whole account
    # exists to check. Now they read 1–6, matching the numbers printed on the
    # sheet, and the button says "Undo moving mark 5 — you, just now".
    openings: list[dict] = []
    for code, nx, ny in MARK_PINS:
        opening_code = f"{code}-1"
        # Rename in place rather than leaving the old row behind and adding a
        # new one, which would double the marks on the sandbox every run.
        stale = one(sb.svc(
            "GET",
            f"/rest/v1/project_openings?project_id=eq.{project_id}"
            f"&opening_code=eq.TEST-{code}&select=id"))
        if stale.get("id"):
            sb.svc("PATCH", f"/rest/v1/project_openings?id=eq.{stale['id']}",
                   {"opening_code": opening_code})
        row = one(sb.svc(
            "GET",
            f"/rest/v1/project_openings?project_id=eq.{project_id}"
            f"&opening_code=eq.{opening_code}"
            "&select=id,opening_code,pin_x,pin_y,origin_pin_x,origin_pin_y"))
        if not row:
            row = one(sb.svc("POST", "/rest/v1/project_openings",
                             {"project_id": project_id, "opening_code": opening_code,
                              "window_type_id": type_id, "planset_id": planset_id,
                              "label": f"TEST — sandbox mark {code}",
                              "page_number": 1, "pin_x": nx, "pin_y": ny},
                             prefer="return=representation"))
        else:
            # An opening the installer script left with no pin at all, a mark a
            # previous run or a browser check left dragged, or a row older than
            # the migration that started remembering where the plan put a mark.
            # All three are repaired, so every run starts from the same picture
            # and every mark has an origin to be put back to — without one the
            # app cannot ring it as moved, whatever it does.
            fix: dict[str, object] = {"page_number": 1, "planset_id": planset_id}
            if row.get("origin_pin_x") is None or row.get("origin_pin_y") is None:
                fix["origin_pin_x"] = nx
                fix["origin_pin_y"] = ny
                fix["pin_x"] = nx
                fix["pin_y"] = ny
            elif row.get("pin_x") is None or not same(row.get("pin_x"), row.get("origin_pin_x")):
                fix["pin_x"] = row.get("origin_pin_x")
                fix["pin_y"] = row.get("origin_pin_y")
            row = one(sb.svc("PATCH", f"/rest/v1/project_openings?id=eq.{row['id']}",
                             fix, prefer="return=representation"))
        openings.append(row)

    ensure_hand_drawn_outline(project_id, planset_id)

    # Nothing outstanding on the undo stack either, for the same reason.
    sb.svc("PATCH", f"/rest/v1/project_opening_pin_moves?project_id=eq.{project_id}"
                    "&undone_at=is.null",
           {"undone_at": datetime.now(timezone.utc).isoformat(),
            "note": "Cleared by a provisioning run."})

    return project_id, type_id, [o for o in openings if o.get("id")]


def ensure_hand_drawn_outline(project_id: str, planset_id: str) -> None:
    """Give the sandbox a traced building, so every mark is a draggable dot.

    WHY. When a job has no traced shape the app invents one and then draws any
    mark near a wall of it AS that wall's opening — a gap in a line, not a dot.
    On a job with six marks every one of them ends up on a wall of a shape
    derived from those same six marks, so the sandbox had no dot to drag at all:
    the plan view showed the drawing with nothing on it, and the moved-mark ring
    (a class on the dot) could never appear.

    A hand-traced shape turns wall snapping off — the app treats a shape a person
    drew as a statement about the building, not a guess to decorate. So this
    stores the rectangle of the shell the sheet prints, marked as hand-drawn by
    carrying no `derived_from`, and the sandbox then behaves like any job whose
    foreman has traced the building: every mark is a free dot, on both views.
    """
    if not (project_id and planset_id):
        return

    rows = sb.svc("GET", f"/rest/v1/project_plan_outlines?project_id=eq.{project_id}"
                         f"&planset_id=eq.{planset_id}&page_number=eq.1"
                         "&select=id,features")
    if isinstance(rows, list):
        for row in rows:
            features = row.get("features") or {}
            derived = features.get("derived_from") if isinstance(features, dict) else None
            if derived in ("pins", "traced"):
                # An auto-saved guess. It is what puts the marks in the walls, and
                # the app re-derives one whenever it is missing, so it is replaced
                # rather than left beside the traced shape.
                sb.svc("DELETE", f"/rest/v1/project_plan_outlines?id=eq.{row['id']}")
            else:
                return  # A traced shape is already there.

    # The shell tiny_pdf.py draws, in the same 0..1 space pins use.
    sb.svc("POST", "/rest/v1/project_plan_outlines",
           {"project_id": project_id, "planset_id": planset_id, "page_number": 1,
            "points": [{"x": 0.114, "y": 0.192}, {"x": 0.886, "y": 0.192},
                       {"x": 0.886, "y": 0.823}, {"x": 0.114, "y": 0.823}],
            "page_aspect": round(HEIGHT / WIDTH, 4),
            "features": {"dividers": [], "wallOpenings": []}})


def ensure_decoy() -> dict:
    """A non-sandbox project with one MOVED mark, for the refusal probes."""
    project = one(sb.svc("GET", f"/rest/v1/projects?job_code=eq.{DECOY_CODE}&select=id"))
    if not project:
        project = one(sb.svc("POST", "/rest/v1/projects",
                             {"job_code": DECOY_CODE, "name": DECOY_NAME,
                              "address": "TEST — no such address", "status": "active"},
                             prefer="return=representation"))
    project_id = project.get("id", "")
    if not project_id:
        return {}

    opening = one(sb.svc(
        "GET",
        f"/rest/v1/project_openings?project_id=eq.{project_id}"
        "&opening_code=eq.DECOY-1&select=id,pin_x,pin_y"))
    if not opening:
        opening = one(sb.svc("POST", "/rest/v1/project_openings",
                             {"project_id": project_id, "opening_code": "DECOY-1",
                              "label": "TEST — decoy mark, must not move",
                              "page_number": 1, "pin_x": 0.4, "pin_y": 0.4},
                             prefer="return=representation"))

    # Move it once, as the service role, so there is an outstanding entry on the
    # undo stack. Without one, an undo or reset aimed here would match zero rows
    # and "succeed" while changing nothing, which proves nothing either way.
    if opening.get("id"):
        sb.svc("PATCH", f"/rest/v1/project_openings?id=eq.{opening['id']}",
               {"pin_x": 0.61, "pin_y": 0.62})
        opening = one(sb.svc(
            "GET", f"/rest/v1/project_openings?id=eq.{opening['id']}"
                   "&select=id,project_id,pin_x,pin_y,origin_pin_x,origin_pin_y"))
    return {"project_id": project_id, "opening": opening}


def remove_decoy() -> None:
    project = one(sb.svc("GET", f"/rest/v1/projects?job_code=eq.{DECOY_CODE}&select=id"))
    if project.get("id"):
        sb.svc("DELETE", f"/rest/v1/projects?id=eq.{project['id']}")
    # Staging bays come from a trigger on projects and do not cascade.
    sb.svc("DELETE", f"/rest/v1/locations?rack=eq.{DECOY_CODE}")


def remove() -> int:
    """Take the login away. The shared sandbox belongs to the installer script."""
    uid = sb.find_user(TEST_EMAIL)
    if uid:
        sb.admin("DELETE", f"/auth/v1/admin/users/{uid}")
        sb.svc("DELETE", f"/rest/v1/profiles?id=eq.{uid}")
    sb.svc("DELETE", f"/rest/v1/crew_invites?email=eq.{TEST_EMAIL}")
    remove_decoy()

    steps.check(sb.find_user(TEST_EMAIL) is None, "the test foreman login no longer exists")
    steps.check(not one(sb.svc("GET", f"/rest/v1/projects?job_code=eq.{DECOY_CODE}&select=id")),
                "the decoy job is gone")
    print("\nThe shared sandbox job ZZTEST is left in place; it belongs to the")
    print("installer test account. Remove it with provision-test-installer.py --remove.")
    return steps.report()


def main() -> int:  # noqa: C901 — a checklist reads better in one place
    if CHECK_MIGRATION:
        return check_migration()

    if REMOVE:
        print("\nRemoving the test foreman login and its decoy job.\n")
        return remove()

    print("\nTest FOREMAN login: create or repair, then prove its limits.\n")

    # Before anything is created. An account with foreman powers and no cage is
    # worse than no account at all, so this refuses rather than warns.
    armed, detail = guard_is_installed()
    steps.check(armed, f"the sandbox guard is installed on this database ({detail})")
    if not armed:
        print("\nRefusing to create a foreman test login on a database where the")
        print("guard is not in place. Deploy the backend first (deploy-backend.yml")
        print(f"applies {' and '.join(GUARD_MIGRATIONS)}), then run this again.")
        return steps.report()

    project_id, type_id, openings = ensure_sandbox()
    steps.check(bool(project_id and type_id and len(openings) == len(MARK_PINS)),
                f"the sandbox job {SANDBOX_CODE} has a plan sheet and "
                f"{len(openings)} pinned mark(s)")
    if not project_id or not openings:
        return steps.report()

    sandbox_registered = sb.svc(
        "GET", f"/rest/v1/sandbox_projects?project_id=eq.{project_id}&select=project_id")
    steps.check(bool(one(sandbox_registered)),
                "it is the one project registered as writable by a test login")

    # -------------------------------------------------------------------
    # 1. The account, through the invite flow and nothing else.
    # -------------------------------------------------------------------
    existing = sb.find_user(TEST_EMAIL)
    if existing:
        status, made = sb.call_function("manage-crew-access", {
            "action": "reissue_login", "user_id": existing,
        }, sb.service)
        steps.check(status == "200" and bool(made.get("code")),
                    f"account exists, so a fresh login code was minted for it -> {status}"
                    f"{'' if status == '200' else ': ' + str(made.get('error'))}")
    else:
        status, made = sb.call_function("manage-crew-access", {
            "action": "create_invite",
            "display_name": TEST_NAME,
            "role": "foreman",
            "email": TEST_EMAIL,
        }, sb.service)
        steps.check(status == "200" and bool(made.get("code")),
                    f"a foreman invite was minted -> {status}"
                    f"{'' if status == '200' else ': ' + str(made.get('error'))}")

    code = made.get("code") or ""
    if not code:
        print(f"      cannot continue: {made}")
        return 1

    status, redeemed = sb.call_function(
        "redeem-crew-invite", {"code": code, "password": PASSWORD}, sb.anon)
    steps.check(status == "200",
                f"the code was redeemed, which is what sets the password -> {status}"
                f"{'' if status == '200' else ': ' + str(redeemed.get('error'))}")

    uid = sb.find_user(TEST_EMAIL)
    steps.check(bool(uid), "a login exists for the test foreman address")
    if not uid:
        return steps.report()

    # -------------------------------------------------------------------
    # 2. Foreman, flagged as a test account, and not offered any work.
    # -------------------------------------------------------------------
    sb.svc("PATCH", f"/rest/v1/profiles?id=eq.{uid}",
           {"is_test": True, "active": False, "display_name": TEST_NAME,
            "role": "foreman"})

    profile = one(sb.svc("GET", f"/rest/v1/profiles?id=eq.{uid}"
                                "&select=display_name,role,active,is_test,access_revoked_at"))
    steps.check(profile.get("role") == "foreman",
                f"the role is foreman and nothing higher: {profile.get('role')}")
    steps.check(profile.get("is_test") is True,
                f"it is flagged as a test account: is_test={profile.get('is_test')}")
    steps.check(profile.get("active") is False,
                "it is not marked on-site, so it is not offered up for assignment")
    steps.check(profile.get("display_name") == TEST_NAME,
                f"the name says what it is: {profile.get('display_name')}")
    steps.check(profile.get("access_revoked_at") is None, "its access is switched on")

    jwt = sb.password_session(TEST_EMAIL, PASSWORD)
    steps.check(bool(jwt), "it can sign in with the password this run was given")
    if not jwt:
        return steps.report()

    steps.check(sb.as_user(jwt, "POST", "/rest/v1/rpc/is_foreman_plus", {"p_uid": uid}) is True,
                "the database treats it as foreman or above, which is the point of it")

    # -------------------------------------------------------------------
    # 3. It can do the foreman job — on the sandbox.
    # -------------------------------------------------------------------
    # If any of this fails the login is useless for the thing it was made for,
    # which is why it is asserted rather than assumed.
    mark = openings[1]
    original = (mark.get("pin_x"), mark.get("pin_y"))

    status, moved = sb.status_as_user(
        jwt, "PATCH", f"/rest/v1/project_openings?id=eq.{mark['id']}",
        {"pin_x": 0.505, "pin_y": 0.415})
    steps.check(status.startswith("2"),
                f"it can drag a mark on the sandbox plan -> {status}"
                f"{'' if status.startswith('2') else ': ' + str(moved)}")

    after = one(sb.svc("GET", f"/rest/v1/project_openings?id=eq.{mark['id']}"
                              "&select=pin_x,pin_y,origin_pin_x,origin_pin_y"))
    steps.check(same(after.get("pin_x"), 0.505), "the drag was really saved")
    steps.check(same(after.get("origin_pin_x"), original[0]),
                "and where the plan put it was remembered, so it has somewhere to go back to")

    stack = sb.as_user(
        jwt, "GET",
        f"/rest/v1/project_opening_pin_moves?opening_id=eq.{mark['id']}"
        "&undone_at=is.null&select=id,moved_by,from_pin_x,to_pin_x&order=moved_at.desc")
    head = one(stack)
    steps.check(bool(head.get("id")), "the move landed on the undo stack")
    steps.check(head.get("moved_by") == uid,
                "attributed to this account, so the Undo button can name who moved it")

    if head.get("id"):
        status, undone = sb.status_as_user(
            jwt, "POST", "/rest/v1/rpc/undo_opening_pin_move", {"p_move_id": head["id"]})
        steps.check(status.startswith("2"), f"it can press Undo -> {status}")
        back = one(sb.svc("GET", f"/rest/v1/project_openings?id=eq.{mark['id']}"
                                 "&select=pin_x,pin_y"))
        steps.check(same(back.get("pin_x"), original[0]),
                    "and the mark went back where it was")

    # Reset-to-original, the "put every mark back" button.
    sb.as_user(jwt, "PATCH", f"/rest/v1/project_openings?id=eq.{mark['id']}",
               {"pin_x": 0.311, "pin_y": 0.222})
    status, count = sb.status_as_user(
        jwt, "POST", "/rest/v1/rpc/reset_project_pins_to_extracted",
        {"p_project_id": project_id})
    steps.check(status.startswith("2") and count == 1,
                f"it can put every mark back where the plan put it -> {status}, {count} moved")
    back = one(sb.svc("GET", f"/rest/v1/project_openings?id=eq.{mark['id']}"
                             "&select=pin_x,pin_y"))
    steps.check(same(back.get("pin_x"), original[0]),
                "and the sandbox is back exactly as it started")

    steps.check(bool(one(sb.as_user(
        jwt, "GET", f"/rest/v1/project_plansets?project_id=eq.{project_id}&select=id"))),
        "it can see the sandbox plan sheet, so the map has something to draw on")

    probe = f"{project_id}/foreman-write-probe.txt"
    status, _ = sb.upload("plansets", probe, b"written by the test foreman",
                          "text/plain", bearer=jwt)
    steps.check(status.startswith("2"),
                f"it can write into the sandbox job's own folder -> {status}")
    sb.status_as_user(jwt, "DELETE", f"/storage/v1/object/plansets/{probe}")

    # -------------------------------------------------------------------
    # 4. It cannot touch a real job. Proved on a throwaway, and on a real
    #    job with a probe that changes nothing even if it were allowed.
    # -------------------------------------------------------------------
    decoy = ensure_decoy()
    decoy_id = decoy.get("project_id", "")
    decoy_mark = decoy.get("opening") or {}
    steps.check(bool(decoy_id and decoy_mark.get("id")),
                "a throwaway non-sandbox job exists to aim the dangerous probes at")

    if decoy_id and decoy_mark.get("id"):
        pin_before = (decoy_mark.get("pin_x"), decoy_mark.get("pin_y"))

        status, body = sb.status_as_user(
            jwt, "PATCH", f"/rest/v1/project_openings?id=eq.{decoy_mark['id']}",
            {"pin_x": 0.1, "pin_y": 0.1})
        steps.check(refused(status, body),
                    f"it cannot move a mark on a job that is not the sandbox -> {status}")

        status, body = sb.status_as_user(
            jwt, "DELETE", f"/rest/v1/project_openings?id=eq.{decoy_mark['id']}")
        steps.check(refused(status, body),
                    f"it cannot delete an opening on a job that is not the sandbox -> {status}")

        status, body = sb.status_as_user(
            jwt, "POST", "/rest/v1/project_openings",
            {"project_id": decoy_id, "opening_code": "DECOY-INJECTED",
             "page_number": 1, "pin_x": 0.5, "pin_y": 0.5})
        steps.check(refused(status, body),
                    f"it cannot add an opening to a job that is not the sandbox, "
                    f"which is the shape a re-extract writes -> {status}")

        status, body = sb.status_as_user(
            jwt, "DELETE", f"/rest/v1/projects?id=eq.{decoy_id}")
        steps.check(refused(status, body),
                    f"it cannot delete a job that is not the sandbox -> {status}")

        outstanding = one(sb.svc(
            "GET", f"/rest/v1/project_opening_pin_moves?opening_id=eq.{decoy_mark['id']}"
                   "&undone_at=is.null&select=id"))
        if outstanding.get("id"):
            status, body = sb.status_as_user(
                jwt, "POST", "/rest/v1/rpc/undo_opening_pin_move",
                {"p_move_id": outstanding["id"]})
            steps.check(refused(status, body),
                        f"it cannot undo somebody else's move on a job that is not "
                        f"the sandbox -> {status}")

        status, body = sb.status_as_user(
            jwt, "POST", "/rest/v1/rpc/reset_project_pins_to_extracted",
            {"p_project_id": decoy_id})
        steps.check(refused(status, body),
                    f"it cannot reset the marks on a job that is not the sandbox -> {status}")

        # Storage: overwrite and delete, both aimed at the throwaway's folder.
        sb.upload("plansets", f"{decoy_id}/decoy-plan.pdf",
                  sandbox_plan_pdf(), "application/pdf")
        status, body = sb.upload("plansets", f"{decoy_id}/decoy-plan.pdf",
                                 b"overwritten by the robot", "text/plain", bearer=jwt)
        steps.check(not status.startswith("2"),
                    f"it cannot overwrite another job's plan set -> {status}")

        status, body = sb.status_as_user(
            jwt, "DELETE", f"/storage/v1/object/plansets/{decoy_id}/decoy-plan.pdf")
        steps.check(not status.startswith("2"),
                    f"it cannot delete another job's plan set -> {status}")

        still = one(sb.svc(
            "GET", f"/rest/v1/project_openings?id=eq.{decoy_mark['id']}"
                   "&select=id,pin_x,pin_y"))
        steps.check(bool(still.get("id")), "the throwaway's opening is still there")
        steps.check(same(still.get("pin_x"), pin_before[0])
                    and same(still.get("pin_y"), pin_before[1]),
                    "and its mark has not moved a millimetre")
        steps.check(bool(one(sb.svc(
            "GET", f"/rest/v1/projects?id=eq.{decoy_id}&select=id"))),
            "and the job itself still exists")

    # The real jobs, with a probe that is inert whatever the answer: write a
    # column back to the value it already holds.
    real_job = one(sb.svc(
        "GET", "/rest/v1/projects?job_code=not.like.ZZTEST*&select=id,job_code,name&limit=1"))
    real_mark = {}
    if real_job.get("id"):
        rows = sb.svc(
            "GET", f"/rest/v1/project_openings?project_id=eq.{real_job['id']}"
                   f"&opening_code=neq.37&id=neq.{DO_NOT_TOUCH}"
                   "&select=id,opening_code,label&order=opening_code&limit=1")
        real_mark = one(rows)
    if real_mark.get("id"):
        status, body = sb.status_as_user(
            jwt, "PATCH", f"/rest/v1/project_openings?id=eq.{real_mark['id']}",
            {"label": real_mark.get("label")})
        steps.check(refused(status, body),
                    f"the guard is armed on the real job {real_job.get('job_code')} too: "
                    f"even a no-op write to mark {real_mark.get('opening_code')} "
                    f"is refused -> {status}")
    else:
        steps.check(False, "could not find a real job to check the guard against")

    # -------------------------------------------------------------------
    # 5. It cannot widen its own cage.
    # -------------------------------------------------------------------
    status, body = sb.status_as_user(
        jwt, "POST", "/rest/v1/sandbox_projects", {"project_id": real_job.get("id")})
    steps.check(not status.startswith("2"),
                f"it cannot add a real job to the list of jobs it may write -> {status}")
    steps.check(not one(sb.svc(
        "GET", f"/rest/v1/sandbox_projects?project_id=eq.{real_job.get('id')}"
               "&select=project_id")),
        "and no real job is on that list")

    status, body = sb.status_as_user(
        jwt, "PATCH", f"/rest/v1/profiles?id=eq.{uid}", {"is_test": False})
    steps.check(not status.startswith("2"),
                f"it cannot clear its own test flag -> {status}")
    steps.check(one(sb.svc("GET", f"/rest/v1/profiles?id=eq.{uid}&select=is_test"))
                .get("is_test") is True,
                "and it is still flagged as a test account")

    # -------------------------------------------------------------------
    # 6. It cannot give anybody access, and it cannot change a role.
    # -------------------------------------------------------------------
    invites = sb.as_user(jwt, "GET", "/rest/v1/crew_invites?select=id")
    steps.check(not (isinstance(invites, list) and invites),
                "it cannot see who has been offered access")

    for role in ("installer", "owner"):
        status, denied = sb.call_function("manage-crew-access", {
            "action": "create_invite", "display_name": "Should Not Exist",
            "role": role,
        }, jwt)
        steps.check(status == "403",
                    f"it cannot hand out a {role} login -> {status}")

    status, denied = sb.call_function("approve-access-request",
                                      {"request_id": "00000000-0000-0000-0000-000000000000"},
                                      jwt)
    steps.check(status == "403",
                f"it cannot approve somebody's request for access either -> {status}")

    status, body = sb.status_as_user(
        jwt, "POST", "/rest/v1/rpc/set_profile_role", {"p_target": uid, "p_role": "owner"})
    steps.check(refused(status, body), f"it cannot promote itself -> {status}")
    steps.check(one(sb.svc("GET", f"/rest/v1/profiles?id=eq.{uid}&select=role"))
                .get("role") == "foreman",
                "and it is still only a foreman")

    status, body = sb.status_as_user(
        jwt, "PATCH", f"/rest/v1/profiles?id=eq.{uid}", {"role": "owner"})
    steps.check(not status.startswith("2"),
                f"nor by writing the role column directly -> {status}")

    # A real crew member's row. The profiles policy lets any foreman rename
    # anyone (that is the Roster screen); a test login must not inherit it.
    other = one(sb.svc(
        "GET", f"/rest/v1/profiles?id=neq.{uid}&is_test=eq.false"
               "&select=id,display_name&limit=1"))
    if other.get("id"):
        status, body = sb.status_as_user(
            jwt, "PATCH", f"/rest/v1/profiles?id=eq.{other['id']}",
            {"display_name": "RENAMED BY THE ROBOT"})
        steps.check(refused(status, body),
                    f"it cannot rename a real crew member -> {status}")
        steps.check(one(sb.svc("GET", f"/rest/v1/profiles?id=eq.{other['id']}"
                                      "&select=display_name"))
                    .get("display_name") == other.get("display_name"),
                    "and that person's name is untouched")

    # -------------------------------------------------------------------
    # 7. Its work cannot move the company's figures.
    # -------------------------------------------------------------------
    # Same proof the installer account gets, for the same reason:
    # install_events is empty, so the first rows ever written set the target
    # time, the slow case and the learned difficulty for a window type forever.
    # Against the TEST window type, so an exclusion that had broken could only
    # ever mark up a type nobody installs.
    event = one(sb.svc("POST", "/rest/v1/install_events",
                       {"project_opening_id": openings[0]["id"],
                        "window_type_id": type_id,
                        "installer_id": uid,
                        "installer": TEST_EMAIL,
                        "minutes": 9,
                        "quality_grade": 5},
                       prefer="return=representation"))
    steps.check(bool(event.get("id")), "an install event was recorded as the test foreman")

    rolled = one(sb.svc("GET", f"/rest/v1/window_types?id=eq.{type_id}"
                               "&select=n_installs,median_minutes,p90_minutes,"
                               "learned_difficulty,golden_install_event_id"))
    steps.check(rolled.get("n_installs") == 0,
                f"it was not counted: n_installs={rolled.get('n_installs')}")
    steps.check(rolled.get("median_minutes") is None and rolled.get("p90_minutes") is None,
                "it set no target time and no slow-case time")
    steps.check(rolled.get("learned_difficulty") is None, "it taught the app no difficulty")
    steps.check(rolled.get("golden_install_event_id") is None,
                "it was not held up to the crew as the worked example")
    mine = sb.svc("GET", f"/rest/v1/installer_type_stats?installer_id=eq.{uid}&select=n")
    steps.check(isinstance(mine, list) and not mine,
                "it appears in no per-installer stats, so dispatch cannot rank on it")

    if event.get("id"):
        sb.svc("DELETE", f"/rest/v1/install_events?id=eq.{event['id']}")
    total = sb.svc("GET", "/rest/v1/install_events?select=id")
    steps.check(isinstance(total, list) and len(total) == 0,
                f"install_events is still empty, so nothing has set a baseline: "
                f"{len(total) if isinstance(total, list) else '?'} row(s)")

    # -------------------------------------------------------------------
    # 8. Say out loud what is NOT covered.
    # -------------------------------------------------------------------
    # Measured on the live database rather than asserted in a document that
    # ages. A table with no way to tie it to a project cannot be scoped to the
    # sandbox, so if a client role can write it, this account can too.
    scope = sb.sql(
        "select table_name, link_column, guarded, client_writable "
        "from public.test_account_write_scope()")
    if isinstance(scope, list):
        linked = [r for r in scope if r.get("link_column")]
        unguarded = [r for r in linked if not r.get("guarded")]
        steps.check(not unguarded,
                    f"every project-scoped table carries the guard "
                    f"({len(linked)} table(s)); unguarded: "
                    f"{[r['table_name'] for r in unguarded] or 'none'}")
        residual = sorted(r["table_name"] for r in scope
                          if not r.get("link_column") and r.get("client_writable"))
        print(f"\n  Residual reach ({len(residual)} table(s) that cannot be tied to a job,")
        print("  so the sandbox rule cannot apply to them). None of these is a")
        print("  customer's job; see docs/test-account.md.")
        for name in residual:
            print(f"    - {name}")
    else:
        steps.check(False, f"could not audit the guard's coverage: {scope}")

    remove_decoy()
    steps.check(not one(sb.svc("GET", f"/rest/v1/projects?job_code=eq.{DECOY_CODE}&select=id")),
                "the throwaway job was cleaned up again")

    result = steps.report()
    if result == 0:
        print(f"\nSign in at the app with {TEST_EMAIL}.")
        print("The password is the value of TEST_FOREMAN_PASSWORD, which this run")
        print("never printed. See docs/test-account.md for where to find it.")
    return result


if __name__ == "__main__":
    sys.exit(main())
