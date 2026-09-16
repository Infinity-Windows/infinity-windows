"""Recovery must never promote a real account or revive a removed person."""
import contextlib
import io
import os
from pathlib import Path
import runpy
import unittest
from unittest.mock import MagicMock, patch
from lib.supabase_rest import Steps


class RecoveryTests(unittest.TestCase):
    def test_recovery_boundaries(self):
        with patch.dict(os.environ, {"TEST_FOREMAN_PASSWORD": "synthetic-test-password"}), patch("lib.supabase_rest.Client"):
            fn = runpy.run_path(str(Path(__file__).with_name("provision-test-foreman.py")))["restore_access_only"]
        valid = {"role": "foreman", "active": False, "is_test": True, "retired_at": None}
        for fields, armed, expected in [
            (valid, True, True), ({**valid, "is_test": False}, True, False),
            ({**valid, "role": "owner"}, True, False),
            ({**valid, "retired_at": "2026-09-01"}, True, False),
            ({**valid, "active": True}, True, False), (valid, False, False),
        ]:
            with self.subTest(fields=fields, armed=armed):
                client = MagicMock()
                client.find_user.return_value = "synthetic-id"
                client.svc.return_value = [fields]
                client.call_function.return_value = ("200", {"ok": True})
                client.password_session.return_value = "synthetic-token"
                fn.__globals__.update(sb=client, steps=Steps(), guard_is_installed=lambda: (armed, "fixture"))
                with contextlib.redirect_stdout(io.StringIO()):
                    result = fn()
                self.assertEqual(result == 0, expected)
                self.assertEqual(client.call_function.called, expected)
                self.assertFalse(client.admin.called)
                self.assertFalse(any(call.args[0] != "GET" for call in client.svc.call_args_list))
                if expected:
                    client.call_function.assert_called_once_with("manage-crew-access", {"action": "restore_access", "user_id": "synthetic-id"}, client.service)


if __name__ == "__main__":
    unittest.main()
