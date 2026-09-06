#!/usr/bin/env python3
"""Tests for scripts/backup_verify.py.

    python3 scripts/test_backup_verify.py

Offline: a throwaway backup directory with a real MANIFEST.json shape, tarred
the way the nightly job tars it. The cases that matter are the failing ones —
a flipped byte, a truncated dump, a missing dump, a stored file that changed,
no manifest at all — because a verify step that passes over damage is the
thing this file exists to rule out. And the healthy archive must pass.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import backup_verify  # noqa: E402


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Fixture:
    def __init__(self, tmp: str):
        self.root = os.path.join(tmp, "2026-09-06T0910Z")
        os.makedirs(os.path.join(self.root, "storage", "plansets", "job"))
        self.files = {
            "roles.sql": b"create role crew;\n",
            "schema.sql": b"create table projects (id uuid);\n" * 40,
            "data.sql": b"COPY projects FROM stdin;\n" + b"row\n" * 500,
        }
        for name, body in self.files.items():
            Path(self.root, name).write_bytes(body)
        obj = b"%PDF-1.4 fake sheet " * 100
        Path(self.root, "storage", "plansets", "job", "sheet.pdf").write_bytes(obj)
        self.manifest = {
            "project_ref": "ref",
            "postgres_version": "15.1",
            "table_count": 3,
            "dumps": {n: {"bytes": len(b), "sha256": digest(b)} for n, b in self.files.items()},
        }
        Path(self.root, "MANIFEST.json").write_text(json.dumps(self.manifest))
        Path(self.root, "storage-manifest.json").write_text(json.dumps({
            "objects": [
                {"bucket": "plansets", "path": "job/sheet.pdf", "sha256": digest(obj)},
                {"bucket": "photos", "path": "job/missing.jpg", "sha256": digest(b"x")},
            ]
        }))
        self.tmp = tmp

    def archive(self) -> str:
        path = os.path.join(self.tmp, "ref-2026-09-06T0910Z.tar.gz")
        with tarfile.open(path, "w:gz") as tar:
            tar.add(self.root, arcname=os.path.basename(self.root))
        return path


def run(target: str) -> tuple[int, str]:
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = backup_verify.main(["backup_verify.py", target])
    return code, buf.getvalue()


class BackupVerify(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.fx = Fixture(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_a_healthy_archive_passes_and_reports_the_missing_file_as_a_warning(self):
        code, out = run(self.fx.archive())
        self.assertEqual(code, 0, out)
        self.assertIn("OK: archive reads back", out)
        self.assertIn("3 dump(s) and 1 stored file(s)", out)
        self.assertIn("WARNING: 1 stored file(s)", out)

    def test_a_flipped_byte_in_a_dump_fails_and_names_it(self):
        p = Path(self.fx.root, "data.sql")
        b = bytearray(p.read_bytes()); b[10] ^= 0xFF; p.write_bytes(bytes(b))
        code, out = run(self.fx.archive())
        self.assertEqual(code, 1)
        self.assertIn("data.sql does not hash", out)

    def test_a_truncated_dump_fails_on_size_and_hash(self):
        p = Path(self.fx.root, "schema.sql")
        p.write_bytes(p.read_bytes()[:20])
        code, out = run(self.fx.archive())
        self.assertEqual(code, 1)
        self.assertIn("schema.sql is 20 bytes", out)

    def test_a_missing_dump_fails(self):
        os.remove(Path(self.fx.root, "roles.sql"))
        code, out = run(self.fx.archive())
        self.assertEqual(code, 1)
        self.assertIn("roles.sql is named in the manifest but is not in the archive", out)

    def test_a_changed_stored_file_fails(self):
        Path(self.fx.root, "storage", "plansets", "job", "sheet.pdf").write_bytes(b"not the sheet")
        code, out = run(self.fx.archive())
        self.assertEqual(code, 1)
        self.assertIn("storage/plansets/job/sheet.pdf does not hash", out)

    def test_no_manifest_is_a_failure_not_a_pass(self):
        os.remove(Path(self.fx.root, "MANIFEST.json"))
        code, out = run(self.fx.archive())
        self.assertEqual(code, 1)
        self.assertIn("MANIFEST.json is missing", out)

    def test_a_manifest_naming_no_dumps_fails(self):
        Path(self.fx.root, "MANIFEST.json").write_text(json.dumps({"dumps": {}}))
        code, out = run(self.fx.archive())
        self.assertEqual(code, 1)
        self.assertIn("names no dumps", out)

    def test_an_unpacked_directory_works_too(self):
        code, out = run(self.fx.root)
        self.assertEqual(code, 0, out)

    def test_an_archive_with_an_unsafe_path_is_refused(self):
        path = os.path.join(self._tmp.name, "evil.tar.gz")
        with tarfile.open(path, "w:gz") as tar:
            info = tarfile.TarInfo("../etc/passwd"); data = b"x"; info.size = 1
            tar.addfile(info, io.BytesIO(data))
        with self.assertRaises(SystemExit):
            run(path)


if __name__ == "__main__":
    unittest.main(verbosity=1)
