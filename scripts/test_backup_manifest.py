#!/usr/bin/env python3
"""Tests for scripts/backup_manifest.py.

    python3 scripts/test_backup_manifest.py

Stdlib only, no database, no token: the catalog is a dict and every query is
answered from it.

What matters here is that the manifest is a thing the restore test can be held
to. A manifest that under-counts, or that picks a different spot row on the way
back, turns the weekly restore check into a coin toss, and a check that fails at
random is a check that gets muted.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import backup_manifest as bm  # noqa: E402

# The rows in the fake database, by "schema.table".
CATALOG = {
    "public.profiles": [
        {"id": "p1", "display_name": "Dave", "role": "installer"},
        {"id": "p2", "display_name": "Maria", "role": "foreman"},
    ],
    "public.install_events": [{"id": "e%d" % i, "unit": i} for i in range(9)],
    "public.time_shifts": [{"id": "s%d" % i, "hours": i} for i in range(5)],
    "public.empty_table": [],
    "storage.objects": [{"id": "o1", "name": "a.pdf"}],
}


def fake_query(ref, sql):
    text = " ".join(sql.split())
    if "from pg_namespace" in text:
        return [{"nspname": s} for s in sorted({k.split(".")[0] for k in CATALOG})]
    if "from pg_class" in text:
        return [
            {"schema": k.split(".")[0], "name": k.split(".")[1], "kind": "table", "rls_enabled": True}
            for k in sorted(CATALOG)
        ]
    if "count(*)" in text:
        out = []
        for part in text.split(" union all "):
            schema = part.split("select '")[1].split("'")[0]
            table = part.split(" as s, '")[1].split("'")[0]
            out.append({"s": schema, "t": table, "n": len(CATALOG["%s.%s" % (schema, table)])})
        return out
    if "to_jsonb(t)::text" in text:
        schema = text.split('from "')[1].split('"')[0]
        table = text.split('"."')[1].split('"')[0]
        rows = CATALOG["%s.%s" % (schema, table)]
        if not rows:
            return []
        # `order by 1` over the row's jsonb: the fake sorts by the same canonical
        # text so the pick is deterministic here too.
        chosen = sorted(rows, key=lambda r: json.dumps(r, sort_keys=True))[0]
        return [{"j": json.dumps(chosen, sort_keys=True)}]
    raise AssertionError("unexpected query: %s" % text[:120])


class Case(unittest.TestCase):
    def setUp(self):
        self.out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.out, True)

    def build(self):
        return bm.build("testref", self.out, "2026-09-05T09:10:00Z", "2026-09-05T09:14:00Z", fake_query)

    def test_every_table_is_counted_including_the_empty_one(self):
        m = self.build()
        counts = {(r["schema"], r["table"]): r["rows"] for r in m["tables"]}
        self.assertEqual(counts[("public", "profiles")], 2)
        self.assertEqual(counts[("public", "install_events")], 9)
        self.assertEqual(counts[("public", "time_shifts")], 5)
        self.assertEqual(
            counts[("public", "empty_table")],
            0,
            "an empty table still has to be in the manifest — a restore that "
            "invents rows in it is just as wrong as one that loses them",
        )
        self.assertEqual(m["table_count"], len(CATALOG))
        self.assertEqual(m["total_rows"], 17)

    def test_three_spot_rows_are_the_biggest_tables_and_are_hashed_not_stored(self):
        m = self.build()
        picked = [(s["schema"], s["table"]) for s in m["spot_rows"]]
        self.assertEqual(
            picked,
            [("public", "install_events"), ("public", "time_shifts"), ("public", "profiles")],
        )
        for spot in m["spot_rows"]:
            self.assertEqual(len(spot["sha256"]), 64)
            self.assertIsNotNone(spot["id"])
        text = json.dumps(m)
        self.assertNotIn("Dave", text, "a crew member's name must not travel in the manifest")
        self.assertNotIn("Maria", text)

    def test_an_empty_table_is_never_a_spot_row(self):
        m = self.build()
        self.assertNotIn(
            ("public", "empty_table"),
            [(s["schema"], s["table"]) for s in m["spot_rows"]],
            "a spot row from an empty table proves nothing",
        )

    def test_the_spot_hash_changes_when_the_row_does(self):
        before = bm.row_hash({"id": "p1", "display_name": "Dave"})
        after = bm.row_hash({"id": "p1", "display_name": "Dav"})
        self.assertNotEqual(before, after)
        # Key order must NOT change it, or the restore comparison is a coin toss.
        self.assertEqual(
            bm.row_hash({"a": 1, "b": 2}),
            bm.row_hash({"b": 2, "a": 1}),
        )

    def test_dump_files_are_measured_and_the_postgres_version_is_read_from_the_header(self):
        with open(os.path.join(self.out, "schema.sql"), "w") as fh:
            fh.write("--\n-- PostgreSQL database dump\n--\n\n")
            fh.write("-- Dumped from database version 15.8\n")
            fh.write("-- Dumped by pg_dump version 15.8\n\nCREATE TABLE public.a (id uuid);\n")
        with open(os.path.join(self.out, "data.sql"), "w") as fh:
            fh.write("COPY public.a (id) FROM stdin;\n\\.\n")
        m = self.build()
        self.assertEqual(m["postgres_version"], "15.8")
        self.assertIn("schema.sql", m["dumps"])
        self.assertIn("data.sql", m["dumps"])
        self.assertEqual(len(m["dumps"]["schema.sql"]["sha256"]), 64)
        self.assertGreater(m["dumps"]["schema.sql"]["bytes"], 0)
        self.assertNotIn("roles.sql", m["dumps"], "only files that exist are described")

    def test_a_dump_with_no_version_header_says_so_rather_than_guessing(self):
        with open(os.path.join(self.out, "schema.sql"), "w") as fh:
            fh.write("CREATE TABLE public.a (id uuid);\n")
        self.assertEqual(self.build()["postgres_version"], "")

    def test_storage_counts_and_bytes_per_bucket_come_through(self):
        with open(os.path.join(self.out, "storage-manifest.json"), "w") as fh:
            json.dump(
                {
                    "buckets": {
                        "plansets": {"objects": 7, "bytes": 23_000_000, "copied": 7},
                        "install-media": {"objects": 412, "bytes": 900_000_000, "copied": 412},
                    },
                    "object_count": 419,
                    "total_bytes": 923_000_000,
                    "copied": 419,
                    "reused": 0,
                    "skipped_over_ceiling": 0,
                    "failed": 0,
                    "warnings": [],
                },
                fh,
            )
        storage = self.build()["storage"]
        self.assertTrue(storage["present"])
        self.assertEqual(storage["object_count"], 419)
        self.assertEqual(storage["buckets"]["install-media"]["objects"], 412)
        self.assertEqual(storage["total_bytes"], 923_000_000)

    def test_a_backup_with_no_storage_manifest_says_so_instead_of_pretending(self):
        storage = self.build()["storage"]
        self.assertFalse(storage["present"])
        self.assertIn("no storage manifest", storage["note"])

    def test_the_summary_reports_totals_and_never_a_table_by_table_breakdown(self):
        with open(os.path.join(self.out, "storage-manifest.json"), "w") as fh:
            json.dump(
                {
                    "buckets": {"plansets": {"objects": 7, "bytes": 23}},
                    "object_count": 7,
                    "total_bytes": 23,
                    "failed": 0,
                    "warnings": ["reached the ceiling"],
                },
                fh,
            )
        text = bm.summary_markdown(self.build())
        self.assertIn("**5 tables**", text)
        self.assertIn("17 rows", text)
        self.assertIn("**7 stored files**", text)
        self.assertIn("WARNING: reached the ceiling", text)
        # A workflow summary on a public repository is public.
        self.assertNotIn("install_events", text)
        self.assertNotIn("profiles", text)

    def test_the_git_sha_and_both_timestamps_are_recorded(self):
        os.environ["GITHUB_SHA"] = "0123456789abcdef0123456789abcdef01234567"
        try:
            m = self.build()
        finally:
            del os.environ["GITHUB_SHA"]
        self.assertEqual(m["git_sha"], "0123456789abcdef0123456789abcdef01234567")
        self.assertEqual(m["started_at"], "2026-09-05T09:10:00Z")
        self.assertEqual(m["finished_at"], "2026-09-05T09:14:00Z")
        self.assertEqual(m["project_ref"], "testref")


if __name__ == "__main__":
    unittest.main(verbosity=1)
