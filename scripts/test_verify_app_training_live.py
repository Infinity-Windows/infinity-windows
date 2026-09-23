#!/usr/bin/env python3
"""Tests for scripts/verify_app_training_live.py.

    python3 scripts/test_verify_app_training_live.py

Stdlib only, offline, the same discipline as scripts/test_verify_invariants.py:
each case hands the judge a small hand-built answer of the shape
scripts/verify-app-training-live.sh's `ask()` produces (one JSON object per
simulated login), so nothing here needs a token, a project or a network.

A check nobody has proved can FAIL is not a check, so the cases that matter
most are the failing ones: a foreman who can open the leadership walkthrough,
a catalog answer that is right while the storage-file answer is wrong, an
answer that did not run as the simulated login (a superuser read would pass
by accident), and a run that checked nobody at all. An unknown role has to
come back clean seeing nothing, the same as a partner
(docs/role-training-videos.md, "Always refused"). And the ordinary shape —
every role seeing exactly its own floor — has to pass with no failures, or
the nightly check is red on day one and people learn to ignore it.
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
import unittest.mock
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import verify_app_training_live as va  # noqa: E402

# The three "Using Forge" walkthroughs published today
# (docs/role-training-videos.md, "Who can watch"): installer 0+, foreman 1+,
# leadership (owner/supervisor) 2+.
PUBLISHED = [
    {"slug": "installer", "min_role": "installer"},
    {"slug": "foreman", "min_role": "foreman"},
    {"slug": "leadership", "min_role": "supervisor"},
]


def answer(role: str, catalog: list, files=None, as_user: str = "authenticated") -> dict:
    """One simulated login's answer, the shape `ask()` builds with
    json_build_object: role, as_user (current_user, should be
    "authenticated"), the catalog slugs it can read, and the storage folders
    it can read. Defaults files to match catalog, since most fixtures want
    both sides to agree; pass files= explicitly to make them disagree."""
    return {
        "role": role,
        "as_user": as_user,
        "catalog": list(catalog),
        "files": list(catalog if files is None else files),
    }


class TheApiAnswerParser(unittest.TestCase):
    def test_a_single_row_result_is_parsed(self):
        raw = json.dumps([{"result": {"role": "installer", "as_user": "authenticated",
                                       "catalog": ["installer"], "files": ["installer"]}}])
        self.assertEqual(va.parse_api_answer(raw)["role"], "installer")

    def test_a_string_encoded_result_is_parsed(self):
        # The Management API sometimes hands back a json column already
        # serialised to a string rather than parsed; both must work.
        inner = json.dumps({"role": "owner", "as_user": "authenticated", "catalog": [], "files": []})
        raw = json.dumps([{"result": inner}])
        self.assertEqual(va.parse_api_answer(raw)["role"], "owner")

    def test_a_management_api_error_payload_fails_clearly(self):
        raw = json.dumps({"message": "permission denied for schema public"})
        with self.assertRaises(SystemExit) as ctx:
            va.parse_api_answer(raw)
        self.assertIn("unexpected answer from the database", str(ctx.exception))
        self.assertIn("permission denied", str(ctx.exception))

    def test_more_than_one_result_in_a_payload_fails(self):
        raw = json.dumps([{"result": "a"}, {"result": "b"}])
        with self.assertRaises(SystemExit):
            va.parse_api_answer(raw)


class TheJudge(unittest.TestCase):
    def test_all_correct_mix_installer_foreman_admin_owner_partner(self):
        answers = [
            answer("installer", ["installer"]),
            answer("foreman", ["foreman", "installer"]),
            answer("admin", ["foreman", "installer", "leadership"]),
            answer("owner", ["foreman", "installer", "leadership"]),
            answer("partner", []),
        ]
        by_role, bad = va.judge(PUBLISHED, answers)
        self.assertEqual(bad, 0)
        for role in ("installer", "foreman", "admin", "owner", "partner"):
            self.assertEqual(by_role[role]["n"], 1, role)
            self.assertEqual(by_role[role]["wrong"], 0, role)
        self.assertEqual(by_role["installer"]["should"], ["installer"])
        self.assertEqual(by_role["foreman"]["should"], ["foreman", "installer"])
        self.assertEqual(by_role["owner"]["should"], ["foreman", "installer", "leadership"])
        self.assertEqual(by_role["partner"]["should"], [])
        table = va.render_table(PUBLISHED, by_role)
        self.assertEqual(table.count("all correct"), 5)
        self.assertNotIn("WRONG", table)

    def test_a_foreman_who_can_open_the_leadership_row_fails(self):
        answers = [answer("foreman", ["foreman", "installer", "leadership"])]
        by_role, bad = va.judge(PUBLISHED, answers)
        self.assertEqual(bad, 1)
        self.assertEqual(by_role["foreman"]["wrong"], 1)
        self.assertIn("WRONG for 1", va.render_table(PUBLISHED, by_role))

    def test_catalog_correct_but_storage_files_wrong_fails(self):
        # The row-security answer (catalog) and the storage-policy answer
        # (files) both have to match what the role should see, separately.
        answers = [answer("installer", ["installer"], files=["installer", "foreman"])]
        by_role, bad = va.judge(PUBLISHED, answers)
        self.assertEqual(bad, 1)
        self.assertEqual(by_role["installer"]["wrong"], 1)

    def test_an_answer_that_ran_as_postgres_fails(self):
        answers = [answer("owner", ["foreman", "installer", "leadership"], as_user="postgres")]
        with self.assertRaises(SystemExit) as ctx:
            va.judge(PUBLISHED, answers)
        self.assertIn("did not run as the login (postgres)", str(ctx.exception))

    def test_an_unknown_role_that_sees_nothing_is_ok(self):
        # docs/role-training-videos.md, "Always refused": any role the app
        # doesn't recognise must see nothing, and that is a pass, not a skip.
        answers = [answer("contractor", [])]
        by_role, bad = va.judge(PUBLISHED, answers)
        self.assertEqual(bad, 0)
        self.assertEqual(by_role["contractor"]["should"], [])

    def test_a_missing_role_field_defaults_to_unknown_and_still_gets_judged(self):
        answers = [{"as_user": "authenticated", "catalog": [], "files": []}]
        by_role, bad = va.judge(PUBLISHED, answers)
        self.assertEqual(bad, 0)
        self.assertIn("unknown", by_role)

    def test_nobody_checked_fails(self):
        with self.assertRaises(SystemExit) as ctx:
            va.judge(PUBLISHED, [])
        self.assertIn("nobody was checked", str(ctx.exception))


class TheRoleFloors(unittest.TestCase):
    def test_floor_matches_the_docs_table(self):
        self.assertEqual(va.FLOOR, {"installer": 0, "foreman": 1, "supervisor": 2})

    def test_legacy_aliases_rank_with_their_modern_role(self):
        self.assertEqual(va.RANK["lead"], va.RANK["foreman"])
        self.assertEqual(va.RANK["admin"], va.RANK["supervisor"])
        self.assertEqual(va.RANK["big_boss"], va.RANK["owner"])

    def test_partner_ranks_below_every_floor(self):
        self.assertLess(va.RANK["partner"], min(va.FLOOR.values()))


class TheTable(unittest.TestCase):
    def test_published_now_line_lists_every_video_with_its_floor(self):
        by_role, _ = va.judge(PUBLISHED, [answer("owner", ["foreman", "installer", "leadership"])])
        table = va.render_table(PUBLISHED, by_role)
        self.assertIn(
            "Published now: installer (installer+), foreman (foreman+), leadership (supervisor+)",
            table,
        )

    def test_nothing_published_says_nothing(self):
        by_role, _ = va.judge([], [answer("partner", [])])
        table = va.render_table([], by_role)
        self.assertIn("Published now: nothing", table)

    def test_role_rows_sort_in_house_order_then_unknowns_last(self):
        answers = [
            answer("owner", ["foreman", "installer", "leadership"]),
            answer("partner", []),
            answer("contractor", []),
            answer("installer", ["installer"]),
            answer("foreman", ["foreman", "installer"]),
            answer("admin", ["foreman", "installer", "leadership"]),
        ]
        by_role, _ = va.judge(PUBLISHED, answers)
        table = va.render_table(PUBLISHED, by_role)
        rows = [ln for ln in table.splitlines() if ln.startswith("| ") and "People checked" not in ln]
        seen_roles = [ln.split("|")[1].strip() for ln in rows]
        self.assertEqual(seen_roles, ["installer", "foreman", "admin", "owner", "partner", "contractor"])


class TheCli(unittest.TestCase):
    def _run(self, published, answer_dicts):
        """Write the answers the way `ask()` appends them to its file (one
        Management-API-shaped JSON payload per line) and call main() the way
        the shell script does: PUBLISHED in the environment, the file as
        argv[1]."""
        with tempfile.NamedTemporaryFile("w", suffix=".ndjson", delete=False) as fh:
            for a in answer_dicts:
                fh.write(json.dumps([{"result": a}]) + "\n")
            path = fh.name
        try:
            buf = io.StringIO()
            with unittest.mock.patch.dict(os.environ, {"PUBLISHED": json.dumps([{"result": published}])}):
                with redirect_stdout(buf):
                    code = va.main(["verify_app_training_live.py", path])
            return code, buf.getvalue()
        finally:
            os.remove(path)

    def test_healthy_mix_exits_zero_and_prints_all_correct(self):
        code, out = self._run(PUBLISHED, [
            answer("installer", ["installer"]),
            answer("foreman", ["foreman", "installer"]),
            answer("owner", ["foreman", "installer", "leadership"]),
        ])
        self.assertEqual(code, 0)
        self.assertIn("all correct", out)
        self.assertNotIn("WRONG", out)

    def test_a_wrong_answer_exits_one_and_names_the_role(self):
        code, out = self._run(PUBLISHED, [
            answer("installer", ["installer", "foreman"]),  # installer must not see foreman's video
        ])
        self.assertEqual(code, 1)
        self.assertIn("| installer |", out)
        self.assertIn("WRONG for 1", out)

    def test_nobody_checked_raises_instead_of_exiting_clean(self):
        with self.assertRaises(SystemExit) as ctx:
            self._run(PUBLISHED, [])
        self.assertIn("nobody was checked", str(ctx.exception))


if __name__ == "__main__":
    unittest.main(verbosity=1)
