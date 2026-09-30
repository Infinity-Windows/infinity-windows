#!/usr/bin/env python3
"""Give the toolbox smoke one real QA foreman session; keep admin cleanup separate."""
import json
import os
from pathlib import Path
import subprocess
import urllib.request


def main():
    password = os.environ.get("TEST_FOREMAN_PASSWORD")
    if not password:
        print("Writing features were not fully tested: the designated foreman login is not configured.")
        return 2
    settings = dict(line.split("=", 1) for line in Path("app/.env.example").read_text().splitlines()
                    if "=" in line and not line.startswith("#"))
    url = settings["VITE_SUPABASE_URL"].strip().strip('"')
    expected = "https://" + os.environ.get("SUPABASE_PROJECT_REF", "") + ".supabase.co"
    if url != expected:
        print("Writing features were not tested: the configured project does not match the smoke target.")
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
        print("Writing features were not fully tested: the QA foreman could not sign in.")
        return 2
    # Only the child environment sees the token; the runner never prints it.
    child_env = dict(os.environ, TEXT_SMOKE_FOREMAN_JWT=token)
    child_env.pop("TEST_FOREMAN_PASSWORD", None)
    return subprocess.run(["bash", "scripts/smoke-text-features.sh"], env=child_env, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
