import importlib.util
import io
import json
import os
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("smoke", Path(__file__).with_name("smoke-ask-authenticated.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

class AuthenticatedAskTest(TestCase):
    def test_login_passes_session_only_to_child(self):
        with patch.dict(os.environ, {"TEST_FOREMAN_PASSWORD": "fixture-password", "SUPABASE_PROJECT_REF": "czprjcskmzzagdztqonm", "SUPABASE_SERVICE_ROLE_KEY": "service-fixture"}), patch("urllib.request.urlopen", return_value=io.BytesIO(json.dumps({"access_token": "fixture-jwt"}).encode())), patch("subprocess.run") as run:
            run.return_value.returncode = 0
            self.assertEqual(smoke.main(), 0)
            self.assertEqual(run.call_args.kwargs["env"]["ASK_SMOKE_JWT"], "fixture-jwt")
            self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", run.call_args.kwargs["env"])
            self.assertNotIn("TEST_FOREMAN_PASSWORD", run.call_args.kwargs["env"])
    def test_login_failure_does_not_run_as_service_role(self):
        with patch.dict(os.environ, {"TEST_FOREMAN_PASSWORD": "fixture-password", "SUPABASE_PROJECT_REF": "czprjcskmzzagdztqonm"}), patch("urllib.request.urlopen", side_effect=ValueError("private")), patch("subprocess.run") as run, patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(smoke.main(), 2)
            run.assert_not_called()
            self.assertNotIn("private", output.getvalue())
    def test_wrong_project_is_refused(self):
        with patch.dict(os.environ, {"TEST_FOREMAN_PASSWORD": "fixture-password", "SUPABASE_PROJECT_REF": "wrong-project"}), patch("urllib.request.urlopen") as request:
            self.assertEqual(smoke.main(), 1)
            request.assert_not_called()

if __name__ == "__main__":
    main()
