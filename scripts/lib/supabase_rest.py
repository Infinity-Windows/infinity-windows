"""The half-dozen calls a provisioning script makes against a live Supabase project.

Extracted from scripts/provision-test-installer.py when a second test account
(the foreman) needed exactly the same plumbing. Two copies of "how do I read the
project's API keys" is how one of them quietly stops matching reality.

Nothing here prints, logs or returns a credential. The keys live in memory on the
Client instance for the life of the process and are never written anywhere.

    from lib.supabase_rest import Client, Steps

    sb = Client()                      # reads SUPABASE_PROJECT_REF + _ACCESS_TOKEN
    steps = Steps()
    steps.check(bool(sb.find_user("a@b.c")), "the login exists")
    steps.report()
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

MGMT = "https://api.supabase.com/v1"


def parse(text: str):
    """JSON if it is JSON, otherwise a stub carrying the head of the response.

    A provisioning run against a misconfigured project gets HTML from a proxy,
    and a bare JSONDecodeError traceback tells you nothing about which call
    failed. The stub keeps the first 400 characters so the caller can print it.
    """
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"_raw": text[:400]}


def one(rows) -> dict:
    """First row of a PostgREST list, or {}."""
    return rows[0] if isinstance(rows, list) and rows else {}


class Steps:
    """A numbered PASS/FAIL log, and a non-zero exit if anything failed.

    Every check asserts an EFFECT rather than the absence of an error, because a
    write forbidden by row-level security matches zero rows and returns success.
    """

    def __init__(self) -> None:
        self.failures: list[str] = []
        self.count = 0

    def check(self, ok: bool, detail: str) -> bool:
        self.count += 1
        print(f"  {self.count:>2}  {'PASS' if ok else 'FAIL'}  {detail}", flush=True)
        if not ok:
            self.failures.append(detail)
        return ok

    def report(self) -> int:
        print()
        if self.failures:
            print(f"FAILED ({len(self.failures)}):")
            for f in self.failures:
                print(f"  - {f}")
            return 1
        print(f"All {self.count} checks passed.")
        return 0


class Client:
    """REST, auth-admin and edge-function calls against one Supabase project.

    `SUPABASE_PROJECT_REF` has no default, deliberately, for the reason
    scripts/pgq.sh spells out: a run against the wrong project reports success
    while doing its work on a database nobody uses.
    """

    def __init__(self) -> None:
        self.ref = os.environ.get("SUPABASE_PROJECT_REF", "").strip()
        if not self.ref:
            sys.exit(
                "SUPABASE_PROJECT_REF is not set, and there is no default.\n"
                "Name the project you mean, e.g. for production:\n\n"
                "  SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm <script>"
            )
        self.token = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
        if not self.token:
            sys.exit("set SUPABASE_ACCESS_TOKEN to an sbp_ management token")
        self.api = f"https://{self.ref}.supabase.co"
        self.anon, self.service = self._project_keys()

    # -- plumbing ----------------------------------------------------------

    @staticmethod
    def curl(args: list[str], data: str | None = None) -> str:
        return subprocess.run(
            ["curl", "-sS", *args], input=data, capture_output=True, text=True
        ).stdout

    def _project_keys(self) -> tuple[str, str]:
        """anon and service keys, held in memory only and never printed."""
        keys = parse(self.curl([f"{MGMT}/projects/{self.ref}/api-keys?reveal=true",
                                "-H", f"Authorization: Bearer {self.token}"]))
        if not isinstance(keys, list):
            sys.exit("could not read the project API keys")
        anon = service = None
        for k in keys:
            if k.get("name") == "anon" or k.get("type") == "anon":
                anon = k.get("api_key")
            if k.get("name") in ("service_role", "secret") or \
               k.get("type") in ("service_role", "secret"):
                service = service or k.get("api_key")
        if not anon or not service:
            sys.exit("could not read the project API keys")
        return anon, service

    # -- PostgREST ---------------------------------------------------------

    def rest(self, method: str, path: str, body=None, *, key: str | None = None,
             bearer: str | None = None, prefer: str | None = None):
        key = key or self.anon
        args = ["-X", method, f"{self.api}{path}", "-H", f"apikey: {key}",
                "-H", f"Authorization: Bearer {bearer or key}",
                "-H", "Content-Type: application/json"]
        if prefer:
            args += ["-H", f"Prefer: {prefer}"]
        if body is not None:
            return parse(self.curl([*args, "--data-binary", "@-"], json.dumps(body)))
        return parse(self.curl(args))

    def svc(self, method: str, path: str, body=None, *, prefer: str | None = None):
        """As the service role: past every policy, for setup and for assertions."""
        return self.rest(method, path, body, key=self.service,
                         bearer=self.service, prefer=prefer)

    def sql(self, statement: str):
        """A statement batch through the Management API. Setup and audit only."""
        return parse(self.curl(
            ["-X", "POST", f"{MGMT}/projects/{self.ref}/database/query",
             "-H", f"Authorization: Bearer {self.token}",
             "-H", "Content-Type: application/json", "--data-binary", "@-"],
            json.dumps({"query": statement})))

    def as_user(self, jwt: str, method: str, path: str, body=None, *,
                prefer: str | None = None):
        """As a signed-in crew member: the session a phone would hold."""
        return self.rest(method, path, body, key=self.anon, bearer=jwt, prefer=prefer)

    def status_as_user(self, jwt: str, method: str, path: str, body=None) -> tuple[str, object]:
        """As above, but returning the HTTP status too — a refusal IS the result."""
        args = ["-w", "\n%{http_code}", "-X", method, f"{self.api}{path}",
                "-H", f"apikey: {self.anon}", "-H", f"Authorization: Bearer {jwt}",
                "-H", "Content-Type: application/json"]
        if body is not None:
            out = self.curl([*args, "--data-binary", "@-"], json.dumps(body))
        else:
            out = self.curl(args)
        payload, _, status = out.rpartition("\n")
        return status.strip(), parse(payload)

    # -- auth --------------------------------------------------------------

    def admin(self, method: str, path: str, body=None):
        args = ["-X", method, f"{self.api}{path}", "-H", f"apikey: {self.service}",
                "-H", f"Authorization: Bearer {self.service}",
                "-H", "Content-Type: application/json"]
        if body is not None:
            return parse(self.curl([*args, "--data-binary", "@-"], json.dumps(body)))
        return parse(self.curl(args))

    def find_user(self, email: str) -> str | None:
        users = self.admin("GET", "/auth/v1/admin/users?per_page=200")
        for u in users.get("users", []):
            if (u.get("email") or "").lower() == email.lower():
                return u["id"]
        return None

    def password_session(self, email: str, password: str) -> str | None:
        got = parse(self.curl(
            ["-X", "POST", f"{self.api}/auth/v1/token?grant_type=password",
             "-H", f"apikey: {self.anon}", "-H", "Content-Type: application/json",
             "--data-binary", "@-"],
            json.dumps({"email": email, "password": password})))
        return got.get("access_token")

    # -- edge functions ----------------------------------------------------

    def call_function(self, name: str, body: dict, bearer: str) -> tuple[str, dict]:
        """Invoke an edge function ONCE, returning (http status, parsed body).

        Exactly once matters: these endpoints create accounts, so a helper that
        quietly retried could make two.
        """
        out = self.curl(["-w", "\n%{http_code}", "-X", "POST",
                         f"{self.api}/functions/v1/{name}",
                         "-H", f"apikey: {self.anon}",
                         "-H", f"Authorization: Bearer {bearer}",
                         "-H", "Content-Type: application/json",
                         "--data-binary", "@-"],
                        json.dumps(body))
        payload, _, status = out.rpartition("\n")
        return status.strip(), parse(payload)

    # -- storage -----------------------------------------------------------

    def upload(self, bucket: str, path: str, data: bytes, content_type: str,
               *, bearer: str | None = None) -> tuple[str, object]:
        """Upload an object, upserting. Returns (http status, parsed body).

        The payload goes through a temporary FILE rather than stdin: curl is
        invoked in text mode everywhere else in this module, and a PDF pushed
        through a text pipe comes out re-encoded and unreadable.
        """
        token = bearer or self.service
        with tempfile.NamedTemporaryFile(delete=False) as fh:
            fh.write(data)
            tmp = fh.name
        try:
            out = self.curl(["-w", "\n%{http_code}", "-X", "POST",
                             f"{self.api}/storage/v1/object/{bucket}/{path}",
                             "-H", f"apikey: {self.anon}",
                             "-H", f"Authorization: Bearer {token}",
                             "-H", f"Content-Type: {content_type}",
                             "-H", "x-upsert: true",
                             "--data-binary", f"@{tmp}"])
        finally:
            os.unlink(tmp)
        payload, _, status = out.rpartition("\n")
        return status.strip(), parse(payload)
