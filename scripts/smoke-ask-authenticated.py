#!/usr/bin/env python3
"""Run the existing Ask smoke check as the designated QA foreman, never service role."""
import json
import os
from pathlib import Path
import subprocess
import urllib.request


def main():
    password = os.environ.get("TEST_FOREMAN_PASSWORD")
    if not password:
        print("Ask Forge was not tested: the designated test login is not configured.")
        return 2
    settings = dict(line.split("=", 1) for line in Path("app/.env.example").read_text().splitlines()
                    if "=" in line and not line.startswith("#"))
    url = settings["VITE_SUPABASE_URL"].strip().strip('"')
    expected = "https://" + os.environ.get("SUPABASE_PROJECT_REF", "") + ".supabase.co"
    if url != expected:
        print("Ask Forge was not tested: the configured project does not match the smoke target.")
        return 1
    try:
        request = urllib.request.Request(url + "/auth/v1/token?grant_type=password",
            headers={"apikey": settings["VITE_SUPABASE_ANON_KEY"].strip().strip('"'), "Content-Type": "application/json"},
            data=json.dumps({"email": "qa.foreman@crew.infinitywindows.app", "password": password}).encode())
        with urllib.request.urlopen(request, timeout=30) as response:
            token = json.load(response).get("access_token")
        if not token:
            raise ValueError("No session")
    except Exception:
        print("Ask Forge was not tested: the designated foreman could not sign in. Check test-account access.")
        return 2
    # Credentials go only in the child environment; no output or command arguments.
    child_env = dict(os.environ, ASK_SMOKE_JWT=token)
    child_env.pop("TEST_FOREMAN_PASSWORD", None)
    child_env.pop("SUPABASE_SERVICE_ROLE_KEY", None)
    return subprocess.run(["bash", "scripts/smoke-ask.sh"], env=child_env, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
