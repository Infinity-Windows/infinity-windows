"""Release-gate refusals and immutable workflow-output checks; no network."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("pwa-release-baseline.py")
SHA = "70a791c2b955566cd2c212f99ab6d72e2c921141"
RELEASE = {"buildId": SHA, "builtAt": "2026-10-01T20:38:40.143Z"}


class ReleaseBaselineTest(unittest.TestCase):
    def run_gate(self, release, expected=None):
        with tempfile.TemporaryDirectory() as folder:
            version = Path(folder) / "version.json"
            output = Path(folder) / "workflow-output"
            version.write_text(release if isinstance(release, str) else json.dumps(release))
            command = [sys.executable, str(SCRIPT), str(version), "--github-output", str(output)]
            if expected is not None:
                command += ["--expect", expected]
            result = subprocess.run(command, capture_output=True, text=True)
            return result, output.read_text() if output.exists() else ""

    def test_literal_served_revision_is_the_only_workflow_output(self):
        result, output = self.run_gate(RELEASE, SHA)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, f"build_ref={SHA}\n")
        self.assertEqual(json.loads(result.stdout)["built_at"], RELEASE["builtAt"])

    def test_changed_release_refuses_without_overwriting_pin(self):
        result, output = self.run_gate(RELEASE, "2c966dc192854b069715a1531790d34fa9b05ff6")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Production changed", result.stderr)
        self.assertEqual(output, "")

    def test_untrusted_metadata_cannot_become_git_ref_or_workflow_directive(self):
        for revision in (None, 713, "master", SHA[:8], SHA + "\nother=value", "$(touch /tmp/bad)", SHA.upper()):
            with self.subTest(revision=revision):
                result, output = self.run_gate({**RELEASE, "buildId": revision})
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(output, "")

    def test_bad_response_or_timestamp_refuses(self):
        for release in ("<html>error</html>", [], {}, {**RELEASE, "builtAt": None}, {**RELEASE, "builtAt": "not-a-dateZ"}, {**RELEASE, "builtAt": "2026-10-01T20:38:40"}, {**RELEASE, "builtAt": "2026-10-01Z"}):
            with self.subTest(release=release):
                result, output = self.run_gate(release)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(output, "")

    def test_invalid_expected_ref_is_not_accepted(self):
        result, output = self.run_gate(RELEASE, "origin/master")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output, "")


if __name__ == "__main__":
    unittest.main()
