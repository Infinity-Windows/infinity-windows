#!/usr/bin/env python3
"""Tests for scripts/verify_app_training_live.py.

    python3 scripts/test_verify_app_training_live.py

Stdlib only, offline, the same discipline as scripts/test_verify_invariants.py:
each case hands the judge a small hand-built answer of the shape
scripts/verify-app-training-live.sh's `ask()` produces (one JSON object per
simulated login), so nothing here needs a token, a project or a network.

A check nobody has proved can FAIL is not a check, so the cases that matter
most are the failing ones: a foreman who can open the leadership walkthrough,
a catalog answer that is right while the storage-file answer is wrong, a
published video whose MP4 is missing from storage even though its slug is
still "readable", a login that sees one storage object beyond what any
visible row promises, an answer that did not run as the simulated login (a
superuser read would pass by accident), and a run that checked nobody at
all. A published bilingual pair (English and Spanish rows sharing one slug)
has to PASS, not fail — that false alarm is what sent this file back for a
second look (PR631 review). An unknown role and a partner have to come back
clean seeing nothing, even when the published rows carry real file paths,
the same as "Always refused" in docs/role-training-videos.md. And the
ordinary shape — every role seeing exactly its own floor — has to pass with
no failures, or the nightly check is red on day one and people learn to
ignore it.
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
# leadership (owner/supervisor) 2+. Real-shaped object paths (not just
# slugs), because the precision the judge now owes is per file, and
# leadership ships with no captions yet — an intentional null to exercise
# that expected_files() skips it.
INSTALLER = {
    "slug": "installer", "language": "en", "version": 1, "min_role": "installer",
    "video_path": "installer/en/v1/tour.mp4",
    "captions_path": "installer/en/v1/tour.vtt",
    "poster_path": "installer/en/v1/tour.jpg",
}
FOREMAN = {
    "slug": "foreman", "language": "en", "version": 1, "min_role": "foreman",
    "video_path": "foreman/en/v1/tour.mp4",
    "captions_path": "foreman/en/v1/tour.vtt",
    "poster_path": "foreman/en/v1/tour.jpg",
}
LEADERSHIP = {
    "slug": "leadership", "language": "en", "version": 1, "min_role": "supervisor",
    "video_path": "leadership/en/v1/tour.mp4",
    "captions_path": None,
    "poster_path": "leadership/en/v1/tour.jpg",
}
PUBLISHED = [INSTALLER, FOREMAN, LEADERSHIP]


def answer(role: str, rows: list, *, drop_files=(), extra_files=(), as_user: str = "authenticated") -> dict:
    """One simulated login's answer, the shape `ask()` produces: role,
    as_user (current_user, should be "authenticated"), the catalog
    identities (slug/language/version) it claims to see, and the exact
    storage object names it claims to see.

    `rows` are PUBLISHED entries this answer claims visibility into — pass
    rows the role should NOT see to build a leaking fixture. `drop_files`
    and `extra_files` perturb the file list on its own, so a fixture can
    disagree about files while the catalog stays exactly right (or the
    reverse): the judge scores the two independently."""
    drop = set(drop_files)
    files = [f for row in rows for f in va.expected_files([row]) if f not in drop]
    return {
        "role": role,
        "as_user": as_user,
        "catalog": [va.catalog_identity(row) for row in rows],
        "files": files + list(extra_files),
    }


class TheApiAnswerParser(unittest.TestCase):
    def test_a_single_row_result_is_parsed(self):
        raw = json.dumps([{"result": {"role": "installer", "as_user": "authenticated",
                                       "catalog": ["installer/en/1"], "files": ["installer/en/v1/tour.mp4"]}}])
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


class TheCatalogIdentityAndExpectedFiles(unittest.TestCase):
    """The two pure helpers judge() relies on, checked directly against
    hand-typed strings — so a bug in either can't hide behind answer()
    building its fixtures the same way judge() builds its expectations."""

    def test_catalog_identity_is_slug_language_version(self):
        self.assertEqual(va.catalog_identity(INSTALLER), "installer/en/1")
        self.assertEqual(va.catalog_identity({"slug": "installer", "language": "es", "version": 2}), "installer/es/2")

    def test_expected_files_collects_every_non_null_path(self):
        self.assertEqual(
            va.expected_files([INSTALLER]),
            sorted(["installer/en/v1/tour.mp4", "installer/en/v1/tour.vtt", "installer/en/v1/tour.jpg"]),
        )

    def test_expected_files_skips_a_null_captions_path(self):
        self.assertEqual(
            va.expected_files([LEADERSHIP]),
            sorted(["leadership/en/v1/tour.mp4", "leadership/en/v1/tour.jpg"]),
        )

    def test_expected_files_of_no_rows_is_empty(self):
        self.assertEqual(va.expected_files([]), [])


class TheJudge(unittest.TestCase):
    def test_all_correct_mix_installer_foreman_admin_owner_partner(self):
        answers = [
            answer("installer", [INSTALLER]),
            answer("foreman", [FOREMAN, INSTALLER]),
            answer("admin", [FOREMAN, INSTALLER, LEADERSHIP]),
            answer("owner", [FOREMAN, INSTALLER, LEADERSHIP]),
            answer("partner", []),
        ]
        by_role, bad = va.judge(PUBLISHED, answers)
        self.assertEqual(bad, 0)
        for role in ("installer", "foreman", "admin", "owner", "partner"):
            self.assertEqual(by_role[role]["n"], 1, role)
            self.assertEqual(by_role[role]["wrong"], 0, role)
        self.assertEqual(by_role["installer"]["should_catalog"], ["installer/en/1"])
        self.assertEqual(by_role["foreman"]["should_catalog"], ["foreman/en/1", "installer/en/1"])
        self.assertEqual(
            by_role["owner"]["should_catalog"], ["foreman/en/1", "installer/en/1", "leadership/en/1"]
        )
        self.assertEqual(by_role["partner"]["should_catalog"], [])
        table = va.render_table(PUBLISHED, by_role)
        self.assertEqual(table.count("all correct"), 5)
        self.assertNotIn("WRONG", table)

    def test_a_foreman_who_can_open_the_leadership_row_fails(self):
        answers = [answer("foreman", [FOREMAN, INSTALLER, LEADERSHIP])]
        by_role, bad = va.judge(PUBLISHED, answers)
        self.assertEqual(bad, 1)
        self.assertEqual(by_role["foreman"]["wrong"], 1)
        self.assertIn("sees a catalog row it should not", by_role["foreman"]["reasons"])
        self.assertIn("sees a file it should not", by_role["foreman"]["reasons"])
        self.assertIn("WRONG for 1", va.render_table(PUBLISHED, by_role))

    def test_catalog_correct_but_storage_files_entirely_wrong_fails(self):
        # The row-security answer (catalog) and the storage-policy answer
        # (files) are judged separately: getting one right does not excuse
        # the other.
        answers = [answer(
            "installer", [INSTALLER],
            drop_files=va.expected_files([INSTALLER]),
            extra_files=va.expected_files([FOREMAN]),
        )]
        by_role, bad = va.judge(PUBLISHED, answers)
        self.assertEqual(bad, 1)
        self.assertEqual(by_role["installer"]["wrong"], 1)
        self.assertIn("file missing in storage", by_role["installer"]["reasons"])
        self.assertIn("sees a file it should not", by_role["installer"]["reasons"])
        self.assertNotIn("catalog row missing", by_role["installer"]["reasons"])
        self.assertNotIn("sees a catalog row it should not", by_role["installer"]["reasons"])

    def test_an_answer_that_ran_as_postgres_fails(self):
        answers = [answer("owner", [FOREMAN, INSTALLER, LEADERSHIP], as_user="postgres")]
        with self.assertRaises(SystemExit) as ctx:
            va.judge(PUBLISHED, answers)
        self.assertIn("did not run as the login (postgres)", str(ctx.exception))

    def test_an_unknown_role_that_sees_nothing_is_ok(self):
        # docs/role-training-videos.md, "Always refused": any role the app
        # doesn't recognise must see nothing, and that is a pass, not a skip.
        answers = [answer("contractor", [])]
        by_role, bad = va.judge(PUBLISHED, answers)
        self.assertEqual(bad, 0)
        self.assertEqual(by_role["contractor"]["should_catalog"], [])

    def test_a_missing_role_field_defaults_to_unknown_and_still_gets_judged(self):
        answers = [{"as_user": "authenticated", "catalog": [], "files": []}]
        by_role, bad = va.judge(PUBLISHED, answers)
        self.assertEqual(bad, 0)
        self.assertIn("unknown", by_role)

    def test_nobody_checked_fails(self):
        with self.assertRaises(SystemExit) as ctx:
            va.judge(PUBLISHED, [])
        self.assertIn("nobody was checked", str(ctx.exception))

    # -- PR631 review: compare compatible identities, and exact files ------

    def test_a_bilingual_published_pair_is_not_a_false_failure(self):
        # The review's exact reproduction: two published installer rows (en
        # and es) must not look like a role is missing one just because they
        # share a slug. The old check compared this catalog list against a
        # `distinct` top-level storage-slug list and produced wrong=1 for a
        # perfectly healthy account.
        installer_es = {
            "slug": "installer", "language": "es", "version": 1, "min_role": "installer",
            "video_path": "installer/es/v1/tour.mp4",
            "captions_path": "installer/es/v1/tour.vtt",
            "poster_path": "installer/es/v1/tour.jpg",
        }
        published = [INSTALLER, installer_es]
        answers = [answer("installer", [INSTALLER, installer_es])]
        by_role, bad = va.judge(published, answers)
        self.assertEqual(bad, 0)
        self.assertEqual(by_role["installer"]["wrong"], 0)
        self.assertEqual(by_role["installer"]["should_catalog"], ["installer/en/1", "installer/es/1"])

    def test_a_missing_mp4_fails_naming_the_file(self):
        # The slug is still "readable" — its poster and captions come back
        # exactly right — but the video object itself is gone from storage.
        # A check that only asks "is the top-level folder readable" would
        # have passed this; naming the exact file is the point of the fix.
        answers = [answer("installer", [INSTALLER], drop_files=[INSTALLER["video_path"]])]
        by_role, bad = va.judge(PUBLISHED, answers)
        self.assertEqual(bad, 1)
        self.assertEqual(by_role["installer"]["reasons"], {"file missing in storage"})
        self.assertIn("file missing in storage", va.render_table(PUBLISHED, by_role))

    def test_seeing_an_extra_object_fails_naming_it(self):
        # Catalog is exactly right; storage hands back one object beyond
        # what any visible row promises (a leak, or a stale grant).
        answers = [answer("installer", [INSTALLER], extra_files=[FOREMAN["video_path"]])]
        by_role, bad = va.judge(PUBLISHED, answers)
        self.assertEqual(bad, 1)
        self.assertEqual(by_role["installer"]["reasons"], {"sees a file it should not"})
        self.assertIn("sees a file it should not", va.render_table(PUBLISHED, by_role))

    def test_partner_and_unknown_role_expect_no_catalog_and_no_files(self):
        # Even with real video/captions/poster paths in the published set
        # (not abstract slugs), a partner or a role this app doesn't
        # recognise must be expected to see nothing at all — and seeing
        # nothing has to be judged exactly right, not merely unmeasured.
        answers = [answer("partner", []), answer("contractor", [])]
        by_role, bad = va.judge(PUBLISHED, answers)
        self.assertEqual(bad, 0)
        for role in ("partner", "contractor"):
            self.assertEqual(by_role[role]["should_catalog"], [])
            self.assertEqual(by_role[role]["should_files"], [])
            self.assertEqual(by_role[role]["wrong"], 0)


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
        by_role, _ = va.judge(PUBLISHED, [answer("owner", [FOREMAN, INSTALLER, LEADERSHIP])])
        table = va.render_table(PUBLISHED, by_role)
        self.assertIn(
            "Published now: installer/en/1 (installer+), foreman/en/1 (foreman+), leadership/en/1 (supervisor+)",
            table,
        )

    def test_nothing_published_says_nothing(self):
        by_role, _ = va.judge([], [answer("partner", [])])
        table = va.render_table([], by_role)
        self.assertIn("Published now: nothing", table)

    def test_the_table_states_what_it_proves_and_what_it_does_not(self):
        # Output wording (PR631 review point 2): say plainly that this is a
        # permission/visibility and storage-existence check, not proof the
        # video plays.
        by_role, _ = va.judge(PUBLISHED, [answer("owner", [FOREMAN, INSTALLER, LEADERSHIP])])
        table = va.render_table(PUBLISHED, by_role)
        self.assertIn("exists in storage", table)
        self.assertIn("does not play the", table)
        self.assertIn("signed-link", table)
        self.assertIn("Safari", table)

    def test_role_rows_sort_in_house_order_then_unknowns_last(self):
        answers = [
            answer("owner", [FOREMAN, INSTALLER, LEADERSHIP]),
            answer("partner", []),
            answer("contractor", []),
            answer("installer", [INSTALLER]),
            answer("foreman", [FOREMAN, INSTALLER]),
            answer("admin", [FOREMAN, INSTALLER, LEADERSHIP]),
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
            answer("installer", [INSTALLER]),
            answer("foreman", [FOREMAN, INSTALLER]),
            answer("owner", [FOREMAN, INSTALLER, LEADERSHIP]),
        ])
        self.assertEqual(code, 0)
        self.assertIn("all correct", out)
        self.assertNotIn("WRONG", out)

    def test_a_wrong_answer_exits_one_and_names_the_role(self):
        code, out = self._run(PUBLISHED, [
            answer("installer", [INSTALLER, FOREMAN]),  # installer must not see foreman's video
        ])
        self.assertEqual(code, 1)
        self.assertIn("| installer |", out)
        self.assertIn("WRONG for 1", out)
        self.assertIn("sees a catalog row it should not", out)
        self.assertIn("sees a file it should not", out)

    def test_nobody_checked_raises_instead_of_exiting_clean(self):
        with self.assertRaises(SystemExit) as ctx:
            self._run(PUBLISHED, [])
        self.assertIn("nobody was checked", str(ctx.exception))


if __name__ == "__main__":
    unittest.main(verbosity=1)
