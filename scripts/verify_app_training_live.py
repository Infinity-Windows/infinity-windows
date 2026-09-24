#!/usr/bin/env python3
"""Judge who can open the "Using Forge" walkthrough videos, on the live database.

    scripts/verify-app-training-live.sh asks every real, non-removed login,
    one at a time inside a read-only transaction through the Management API,
    which catalog rows (public.app_training_videos) and which private
    storage objects (bucket app-training) it can read. This module turns
    those answers into a pass/fail and the markdown table the workflow
    prints — the same split as scripts/verify_invariants.py: the shell
    script asks, this judges.

    A catalog row is identified by slug/language/version, not by slug alone.
    An active English and an active Spanish row of the same walkthrough share
    one slug, so comparing slug lists made a healthy bilingual catalog look
    like a role was missing a video (PR631 review). Storage evidence is the
    exact object name, not a top-level folder: a slug reads as "readable"
    even when its MP4 is gone and only the poster or captions remain, so
    this compares the full path of every video, captions and poster file a
    visible row promises.

Exit 0 when every checked person saw exactly the catalog identities and
exactly the storage files the role floor says they should (installer 0+,
foreman 1+, leadership 2+ — docs/role-training-videos.md, "Who can watch"),
1 when one of them saw something else, a promised file turned out missing
from storage, or nothing could be measured. A check that cannot tell "clean"
from "did not look" is worse than no check, so an answer that did not run as
the simulated login, and a run that checked nobody at all, both FAIL rather
than pass quietly.

This proves who can open which catalog rows and which exact files, and that
every file a visible row promises actually exists in storage where it says
it does. It does NOT play the video, and it does not test signed-link
behavior or real Safari playback (docs/role-training-videos.md, "Not yet
verified").

Only role names, head counts, slugs, languages, versions and storage paths
are printed here — never an id or a name.

READ-ONLY. This never talks to the network; scripts/verify-app-training-live.sh
does the asking.
"""
from __future__ import annotations

import json
import os
import sys

#: A published video's min_role floor, by rank. Keys are exactly the
#: min_role values public.app_training_videos can hold today
#: (docs/role-training-videos.md, "Who can watch").
FLOOR: dict[str, int] = {"installer": 0, "foreman": 1, "supervisor": 2}

#: Every login's rank, legacy aliases included (lead ranks with foreman,
#: admin with supervisor). partner and any role this app does not recognise
#: rank below every floor, so they should see nothing
#: (can_watch_app_training).
RANK: dict[str, int] = {
    "installer": 0, "foreman": 1, "lead": 1, "supervisor": 2, "admin": 2,
    "owner": 3, "big_boss": 3, "partner": -1,
}

#: The order roles print in; anything not listed here sorts after, by name.
ROLE_ORDER: list[str] = ["installer", "foreman", "lead", "supervisor", "admin", "owner", "big_boss", "partner"]


def _fmt(items) -> str:
    return ", ".join(items) or "nothing"


def catalog_identity(row: dict) -> str:
    """The identity a published catalog row is compared by. Bilingual rows
    (installer/en and installer/es) share a slug, so the slug alone is not a
    safe identity — two published rows would read back as one and a role
    correctly seeing both would look one short (PR631 review)."""
    return f"{row['slug']}/{row['language']}/{row['version']}"


def expected_files(rows) -> list[str]:
    """The exact object names a set of catalog rows promises: every non-null
    video/captions/poster path. A published row's slug being "readable" is
    not enough — the MP4 itself has to be one of the objects the login can
    open, or a missing file passes as a missing folder never would
    (PR631 review)."""
    return sorted(
        {
            path
            for row in rows
            for path in (row.get("video_path"), row.get("captions_path"), row.get("poster_path"))
            if path
        }
    )


def parse_api_answer(raw: str):
    """The Management API answers with the last statement's rows; accept a
    list of them or one object, and find the single `result` value. A
    payload with no `result` at all — an API error message, most often — is
    reported with its own text rather than parsed as data."""
    data = json.loads(raw)
    found = []

    def walk(o):
        if isinstance(o, dict):
            if "result" in o:
                found.append(o["result"])
            else:
                for v in o.values():
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(data)
    if len(found) != 1:
        raise SystemExit(f"unexpected answer from the database: {raw[:300]}")
    r = found[0]
    return json.loads(r) if isinstance(r, str) else r


def judge(published: list[dict], answers: list[dict]) -> tuple[dict, int]:
    """Compare each person's answer with what the role floor says they
    should see. Returns (by_role, bad): a per-role tally — head count, how
    many were wrong, what that role should see, and why any were wrong —
    and the total count of people who saw something other than what their
    role allows.

    Catalog and storage are judged separately, and each as an exact-match
    set: the catalog identities (slug/language/version) a role should see
    have to equal what it actually saw, and the storage object names a
    role's visible rows promise have to equal what it actually saw. A
    mismatch is reported as one or both of two reasons: "file missing in
    storage" (a promised object is not among the files seen) and "sees a
    file it should not" (a file is seen that no visible row promises) — with
    the matching pair for catalog rows themselves, "catalog row missing" and
    "sees a catalog row it should not".

    Nothing is proven, so nothing is reported, if any answer did not run as
    the simulated login (a superuser read would pass by accident), or if
    there are no answers at all."""
    by_role: dict[str, dict] = {}
    bad = 0
    for r in answers:
        role = r.get("role") or "unknown"
        if r.get("as_user") != "authenticated":
            raise SystemExit(
                f"FAILED: a check did not run as the login ({r.get('as_user')}); nothing proven"
            )
        allowed = [p for p in published if RANK.get(role, -1) >= FLOOR[p["min_role"]]]
        should_catalog = sorted(catalog_identity(p) for p in allowed)
        should_files = expected_files(allowed)
        sees_catalog = sorted(set(r["catalog"]))
        sees_files = sorted(set(r["files"]))

        reasons: set[str] = set()
        if sees_catalog != should_catalog:
            if any(c not in sees_catalog for c in should_catalog):
                reasons.add("catalog row missing")
            if any(c not in should_catalog for c in sees_catalog):
                reasons.add("sees a catalog row it should not")
        if sees_files != should_files:
            if any(f not in sees_files for f in should_files):
                reasons.add("file missing in storage")
            if any(f not in should_files for f in sees_files):
                reasons.add("sees a file it should not")

        g = by_role.setdefault(
            role,
            {"n": 0, "wrong": 0, "should_catalog": should_catalog, "should_files": should_files, "reasons": set()},
        )
        g["n"] += 1
        if reasons:
            g["wrong"] += 1
            bad += 1
            g["reasons"] |= reasons
    if not by_role:
        raise SystemExit("FAILED: nobody was checked, so nothing is proven")
    return by_role, bad


def render_table(published: list[dict], by_role: dict) -> str:
    """The markdown table the workflow appends to the job summary."""
    lines = [
        "### Using Forge walkthroughs: what each person can open (live)\n",
        "Published now: "
        + (", ".join(f"{catalog_identity(p)} ({p['min_role']}+)" for p in published) or "nothing")
        + "\n",
        "Every account that has not been removed was checked as itself, inside a read-only transaction.\n",
        "This proves who can open which catalog rows and which exact files, and that "
        "every file a visible row promises exists in storage. It does not play the "
        "video, and it does not test signed-link behavior or real Safari playback.\n",
        "| Role | People checked | Should see | Result |",
        "|---|---|---|---|",
    ]
    for role in sorted(by_role, key=lambda k: (ROLE_ORDER.index(k) if k in ROLE_ORDER else 99, k)):
        g = by_role[role]
        if not g["wrong"]:
            result = "all correct"
        else:
            result = f"WRONG for {g['wrong']} ({', '.join(sorted(g['reasons']))})"
        lines.append(f"| {role} | {g['n']} | {_fmt(g['should_catalog'])} | {result} |")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    published = parse_api_answer(os.environ["PUBLISHED"])
    if len(argv) > 1:
        with open(argv[1]) as fh:
            raw_lines = fh.readlines()
    else:
        raw_lines = sys.stdin.readlines()
    answers = []
    for line in raw_lines:
        line = line.strip()
        if not line:
            continue
        answers.append(parse_api_answer(line))
    by_role, bad = judge(published, answers)
    print(render_table(published, by_role))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
