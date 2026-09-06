#!/usr/bin/env python3
"""Tests for the nightly backup's write-and-verify half.

    python3 scripts/test_backup_project.py

Stdlib only and offline: every case builds a small snapshot by hand, writes it
to a temporary directory, and reads it back. No project, no token, no network.

The thing to prove is that verification actually notices damage. A verify step
that passes over a truncated file, a swapped file, or a snapshot short a table
is the failure mode this whole workflow exists to rule out — so each of those
is done to a good backup here, and each must be reported.
"""
from __future__ import annotations

import gzip
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import backup_project  # noqa: E402

REF = "abcdefghijklmnopqrst"
NOW = datetime(2026, 9, 6, 9, 20, tzinfo=timezone.utc)


def snapshot(rows_a: int = 3, rows_b: int = 2, failures: list[str] | None = None) -> dict:
    a = [{"id": i, "name": f"a{i}"} for i in range(rows_a)]
    b = [{"id": i, "pin_hash": "[REDACTED-CREDENTIAL]"} for i in range(rows_b)]
    tables = [
        {"schema": "public", "table": "a", "kind": "table", "row_count": rows_a,
         "captured": bool(rows_a), "json_key": "a"},
        {"schema": "public", "table": "b", "kind": "table", "row_count": rows_b,
         "captured": bool(rows_b), "json_key": "b"},
        {"schema": "public", "table": "empty", "kind": "table", "row_count": 0, "captured": False},
    ]
    return {
        "exported_at": "2026-09-06T09:20:00.000Z",
        "project_id": REF,
        "a": a,
        "b": b,
        "_meta": {
            "project_ref": REF,
            "table_count": 3,
            "non_empty_table_count": 2,
            "total_rows": rows_a + rows_b,
            "tables": tables,
            "capture_failures": failures or [],
            "redactions": ["public.b.pin_hash: 2 value(s) redacted"],
        },
        "_auth": {"user_count": 4},
        "_storage": {"object_count": 9},
        "_migrations": [{"version": "1"}, {"version": "2"}],
    }


class WriteAndVerify(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_good_backup_verifies_clean(self):
        manifest = backup_project.write_backup(self.out, snapshot(), REF, NOW)
        self.assertEqual(backup_project.verify_backup(self.out), [])
        self.assertEqual(manifest["files"][0]["name"], f"2026-09-06T0920Z-{REF}-full.json.gz")
        self.assertEqual(manifest["summary"]["total_rows"], 5)
        self.assertEqual(manifest["summary"]["auth_users"], 4)
        self.assertEqual(manifest["summary"]["migrations"], 2)
        self.assertEqual(sorted(os.listdir(self.out)), sorted([manifest["files"][0]["name"], "manifest.json"]))

    def test_filename_carries_the_real_date_not_a_constant(self):
        later = datetime(2027, 1, 2, 3, 4, tzinfo=timezone.utc)
        manifest = backup_project.write_backup(self.out, snapshot(), REF, later)
        self.assertTrue(manifest["files"][0]["name"].startswith("2027-01-02T0304Z-"))

    def test_same_snapshot_twice_is_byte_identical(self):
        m1 = backup_project.write_backup(self.out, snapshot(), REF, NOW)
        m2 = backup_project.write_backup(self.out, snapshot(), REF, NOW)
        self.assertEqual(m1["files"][0]["sha256"], m2["files"][0]["sha256"])

    def _damage(self, fn):
        manifest = backup_project.write_backup(self.out, snapshot(), REF, NOW)
        path = os.path.join(self.out, manifest["files"][0]["name"])
        fn(path)
        return backup_project.verify_backup(self.out)

    def test_truncated_file_is_reported(self):
        def truncate(path):
            data = open(path, "rb").read()
            open(path, "wb").write(data[: len(data) // 2])
        problems = self._damage(truncate)
        self.assertTrue(problems, "a half file verified clean")
        self.assertTrue(any("bytes on disk" in p for p in problems), problems)

    def test_flipped_byte_is_reported(self):
        def flip(path):
            data = bytearray(open(path, "rb").read())
            data[-8] ^= 0xFF
            open(path, "wb").write(bytes(data))
        problems = self._damage(flip)
        self.assertTrue(any("sha256 on disk" in p for p in problems), problems)

    def test_missing_file_is_reported(self):
        problems = self._damage(os.remove)
        self.assertTrue(any("missing" in p for p in problems), problems)

    def test_rewritten_gzip_with_a_row_dropped_is_reported(self):
        # Same manifest, but the file underneath now holds one row fewer: the
        # outer hash fails AND the row accounting fails, and both are said.
        def drop_row(path):
            snap = snapshot()
            snap["a"].pop()
            raw = json.dumps(snap, indent=2, sort_keys=True).encode() + b"\n"
            open(path, "wb").write(gzip.compress(raw, mtime=0))
        problems = self._damage(drop_row)
        self.assertTrue(any("sha256" in p for p in problems), problems)
        self.assertTrue(any("holds 2 rows, inventory says 3" in p for p in problems), problems)

    def test_snapshot_with_capture_failures_never_verifies(self):
        backup_project.write_backup(self.out, snapshot(failures=["public.x: refused"]), REF, NOW)
        problems = backup_project.verify_backup(self.out)
        self.assertTrue(any("not captured" in p for p in problems), problems)

    def test_wrong_project_is_reported(self):
        snap = snapshot()
        snap["_meta"]["project_ref"] = "someotherproject"
        backup_project.write_backup(self.out, snap, REF, NOW)
        problems = backup_project.verify_backup(self.out)
        self.assertTrue(any("is for project" in p for p in problems), problems)

    def test_missing_manifest_is_one_clear_problem(self):
        problems = backup_project.verify_backup(self.out)
        self.assertEqual(len(problems), 1)
        self.assertIn("manifest.json unreadable", problems[0])

    def test_verify_cli_exits_nonzero_on_damage(self):
        manifest = backup_project.write_backup(self.out, snapshot(), REF, NOW)
        os.remove(os.path.join(self.out, manifest["files"][0]["name"]))
        with self.assertRaises(SystemExit) as ctx:
            backup_project._verify_cli(self.out)
        self.assertEqual(ctx.exception.code, 1)

    def test_verify_cli_passes_a_good_backup(self):
        backup_project.write_backup(self.out, snapshot(), REF, NOW)
        backup_project._verify_cli(self.out)  # no SystemExit


class ReadOnlyGuarantee(unittest.TestCase):
    def test_the_query_helper_still_refuses_writes(self):
        # The backup runs against production with a management token. The only
        # thing standing between "backup" and "a script that could write" is
        # this regex in mgmt_query; if it ever loosens, this fails first.
        import mgmt_query
        for sql in ("delete from projects", "update a set b=1", "drop table x", "insert into a values (1)"):
            with self.assertRaises(SystemExit):
                mgmt_query.query("ref", sql)


if __name__ == "__main__":
    unittest.main(verbosity=1)
