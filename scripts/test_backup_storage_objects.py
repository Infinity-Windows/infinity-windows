#!/usr/bin/env python3
"""Tests for scripts/backup_storage_objects.py.

    python3 scripts/test_backup_storage_objects.py

Stdlib only. Nothing here touches the network, a project or a key: the three
storage calls are replaced with a fake bucket held in a dict.

The four behaviours worth pinning are the four the July run got wrong, and all
of them fail SILENTLY in production if they regress — a backup that quietly
copied nothing still exits 0 and still uploads an archive:

  1. It finds objects nested under folders. Every planset and every install
     photo is stored under a folder per project, so a walk that does not recurse
     backs up an empty bucket and says it succeeded.
  2. A second run reuses last night's bytes when size and etag match, and copies
     again when either changed. Without this a nightly job re-downloads the
     whole bucket every night forever.
  3. Reaching the size ceiling keeps the objects it already copied, rather than
     refusing the bucket outright — and fails the run, so a backup that is
     missing files never reports a green night.
  4. The service key never reaches the manifest.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import backup_storage_objects as bso  # noqa: E402

KEY = "sb_secret_this_is_not_a_real_key"


class FakeStorage:
    """A storage API backed by a dict of "bucket/path" -> bytes."""

    def __init__(self, files):
        self.files = dict(files)
        self.downloads = []

    def buckets(self):
        names = sorted({k.split("/", 1)[0] for k in self.files})
        return [{"name": n} for n in names]

    def list(self, bucket, prefix, offset):
        # Mimic the real endpoint: one directory level, folders as null-id rows.
        entries = {}
        for key, body in self.files.items():
            b, path = key.split("/", 1)
            if b != bucket or not path.startswith(prefix):
                continue
            rest = path[len(prefix) :]
            head, sep, _ = rest.partition("/")
            if sep:
                entries.setdefault(head, None)
            else:
                entries[head] = {
                    "name": head,
                    "id": "id-" + path,
                    "updated_at": "2026-09-05T00:00:00Z",
                    "metadata": {"size": len(body), "eTag": '"%s"' % _etag(body)},
                }
        rows = []
        for name in sorted(entries):
            rows.append(entries[name] or {"name": name, "id": None})
        return rows[offset : offset + bso.PAGE]

    def download(self, bucket, path, dest):
        self.downloads.append("%s/%s" % (bucket, path))
        with open(dest, "wb") as fh:
            fh.write(self.files["%s/%s" % (bucket, path)])


def _etag(body: bytes) -> str:
    import hashlib

    return hashlib.md5(body).hexdigest()


class Case(unittest.TestCase):
    def setUp(self):
        self.out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.out, True)
        self.logs = []

    def run_backup(self, api, limit=0):
        return bso.run(api, self.out, limit, log=self.logs.append)

    def manifest(self):
        with open(os.path.join(self.out, bso.MANIFEST_NAME)) as fh:
            return json.load(fh)

    # 1. Nested objects are found, in every bucket.
    def test_walks_nested_folders_in_every_bucket(self):
        api = FakeStorage(
            {
                "plansets/proj-a/sheet.pdf": b"PDF-A",
                "plansets/proj-b/deep/er/sheet.pdf": b"PDF-B",
                # The bucket the July run missed entirely.
                "install-media/proj-a/unit-1/before.jpg": b"JPEGBYTES",
            }
        )
        m = self.run_backup(api)
        paths = sorted(o["path"] for o in m["objects"])
        self.assertEqual(
            paths,
            ["proj-a/sheet.pdf", "proj-a/unit-1/before.jpg", "proj-b/deep/er/sheet.pdf"],
        )
        self.assertEqual(m["object_count"], 3)
        self.assertEqual(m["copied"], 3)
        self.assertEqual(m["failed"], 0)
        self.assertEqual(m["buckets"]["install-media"]["objects"], 1)
        self.assertEqual(m["buckets"]["install-media"]["bytes"], len(b"JPEGBYTES"))
        # And the bytes really landed on disk.
        with open(os.path.join(self.out, "storage", "plansets", "proj-a", "sheet.pdf"), "rb") as fh:
            self.assertEqual(fh.read(), b"PDF-A")

    # 2. Resume: unchanged objects are not fetched twice; changed ones are.
    def test_second_run_reuses_unchanged_and_recopies_changed(self):
        files = {
            "plansets/a.pdf": b"one",
            "plansets/b.pdf": b"two",
        }
        api = FakeStorage(files)
        self.run_backup(api)
        self.assertEqual(sorted(api.downloads), ["plansets/a.pdf", "plansets/b.pdf"])

        api2 = FakeStorage(dict(files, **{"plansets/b.pdf": b"two-but-edited"}))
        m = self.run_backup(api2)
        self.assertEqual(api2.downloads, ["plansets/b.pdf"], "only the changed object")
        self.assertEqual(m["reused"], 1)
        self.assertEqual(m["copied"], 1)

    def test_a_deleted_local_file_is_fetched_again_even_when_the_etag_matches(self):
        api = FakeStorage({"plansets/a.pdf": b"one"})
        self.run_backup(api)
        os.remove(os.path.join(self.out, "storage", "plansets", "a.pdf"))
        api2 = FakeStorage({"plansets/a.pdf": b"one"})
        m = self.run_backup(api2)
        self.assertEqual(api2.downloads, ["plansets/a.pdf"])
        self.assertEqual(m["reused"], 0)

    # 3. The ceiling keeps what fits, says so, and fails the run.
    def test_ceiling_keeps_what_fits_and_warns(self):
        api = FakeStorage(
            {
                "plansets/a.pdf": b"x" * 100,
                "plansets/b.pdf": b"y" * 100,
                "plansets/c.pdf": b"z" * 100,
            }
        )
        m = self.run_backup(api, limit=250)
        self.assertEqual(m["copied"], 2, "everything under the ceiling is copied")
        self.assertEqual(m["skipped_over_ceiling"], 1)
        self.assertEqual(m["failed"], 0)
        self.assertTrue(m["warnings"], "a ceiling hit has to say so out loud")
        self.assertIn("ceiling", " ".join(m["warnings"]))
        skipped = [o for o in m["objects"] if not o.get("copied")]
        self.assertEqual(len(skipped), 1)
        self.assertIn("ceiling", skipped[0]["skipped_reason"])
        # The July behaviour, which this replaces, would have copied nothing.
        self.assertGreater(len(api.downloads), 0)

    def test_a_ceiling_hit_fails_the_run_rather_than_passing_for_a_green_night(self):
        # The night the install photos outgrow the ceiling must not look exactly
        # like every other night. Before this, it exited 0, posted nothing to
        # Slack, and left the warning on a summary page nobody opens on a pass.
        api = FakeStorage({"plansets/%d.pdf" % i: b"x" * 100 for i in range(3)})
        prior_cls, bso.Storage = bso.Storage, lambda ref, key: api
        prior_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        os.environ["SUPABASE_SERVICE_ROLE_KEY"] = KEY
        try:
            with contextlib.redirect_stderr(io.StringIO()) as err:
                code = bso.main(["--ref", "abc", "--out", self.out, "--limit-bytes", "250"])
        finally:
            bso.Storage = prior_cls
            if prior_key is None:
                os.environ.pop("SUPABASE_SERVICE_ROLE_KEY", None)
            else:
                os.environ["SUPABASE_SERVICE_ROLE_KEY"] = prior_key
        self.assertEqual(code, 1, "a backup with files missing from it must not exit 0")
        self.assertIn("incomplete", err.getvalue())
        m = self.manifest()
        self.assertEqual(m["skipped_over_ceiling"], 1)
        self.assertEqual(m["copied"], 2, "and everything that fit is still kept")

    def test_no_ceiling_by_request(self):
        api = FakeStorage({"plansets/a.pdf": b"x" * 5000})
        m = self.run_backup(api, limit=0)
        self.assertEqual(m["copied"], 1)
        self.assertEqual(m["skipped_over_ceiling"], 0)

    # 4. Nothing about the credential is written down.
    def test_the_key_never_reaches_the_manifest(self):
        api = FakeStorage({"plansets/a.pdf": b"one"})
        self.run_backup(api)
        with open(os.path.join(self.out, bso.MANIFEST_NAME)) as fh:
            text = fh.read()
        self.assertNotIn(KEY, text)
        self.assertNotIn("Authorization", text)
        self.assertNotIn("apikey", text)

    def test_a_download_failure_is_recorded_and_fails_the_run(self):
        class Broken(FakeStorage):
            def download(self, bucket, path, dest):
                raise RuntimeError("curl exited 22")

        m = self.run_backup(Broken({"plansets/a.pdf": b"one"}))
        self.assertEqual(m["failed"], 1)
        self.assertEqual(m["copied"], 0)
        self.assertIn("curl exited 22", m["objects"][0]["error"])
        self.assertTrue(m["failures"])

    def test_a_corrupt_manifest_is_treated_as_no_manifest(self):
        with open(os.path.join(self.out, bso.MANIFEST_NAME), "w") as fh:
            fh.write("{not json")
        api = FakeStorage({"plansets/a.pdf": b"one"})
        m = self.run_backup(api)
        self.assertEqual(m["copied"], 1, "a half-written manifest must not stop the backup")

    def test_a_size_mismatch_is_a_failure_not_a_silent_pass(self):
        class Short(FakeStorage):
            def download(self, bucket, path, dest):
                with open(dest, "wb") as fh:
                    fh.write(b"tru")

        m = self.run_backup(Short({"plansets/a.pdf": b"truncated-on-the-wire"}))
        self.assertEqual(m["failed"], 1)
        self.assertIn("size mismatch", m["objects"][0]["error"])

    def test_paging_past_the_hundred_row_page(self):
        files = {"plansets/%03d.pdf" % i: b"x" for i in range(bso.PAGE + 7)}
        m = self.run_backup(FakeStorage(files))
        self.assertEqual(m["object_count"], bso.PAGE + 7)
        self.assertEqual(m["copied"], bso.PAGE + 7)

    def test_missing_key_is_a_plain_english_refusal(self):
        env = os.environ.pop("SUPABASE_SERVICE_ROLE_KEY", None)
        try:
            code = bso.main(["--ref", "abc", "--out", self.out])
        finally:
            if env is not None:
                os.environ["SUPABASE_SERVICE_ROLE_KEY"] = env
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
