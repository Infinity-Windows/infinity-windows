#!/usr/bin/env python3
"""Spot a secret that was added to GitHub under the WRONG NAME.

Why this exists. The pipeline only ever looks for exact names. A key stored as
`OPEN_AI_WINDOWS_API` when the app looks for `OPENAI_API_KEY` is not a
half-working key, it is an invisible one: nothing references that name, so no
check can see it, no warning fires, and the owner has every reason to believe
the job is done. That happened on 2026-07-29. The key was created, the deploy
went green, and the feature stayed broken until a human compared the two names
by eye.

`scripts/sync-function-secrets.sh` cannot catch this. It is handed the values of
the names the app needs and nothing else, so a secret under any other name is
outside its world entirely. The only way to see the mistake is to look at the
LIST OF NAMES GitHub holds and compare it with the list the code requires.

WHAT IT NEVER DOES. It reads names, never values. That is not a promise this
script has to keep by being careful: GitHub's API cannot return a secret's value
to anybody, by design. `GET /repos/{owner}/{repo}/actions/secrets` returns names
and timestamps only. So there is no value here to leak, print or log.

HOW IT MATCHES. Not a hand-written list of known typos, which would catch
exactly one mistake and never the next one. Both names are reduced to a "core":
upper-cased, split into words, and the words that carry no meaning in a secret
name — API, KEY, TOKEN, SECRET — dropped. `OPENAI_API_KEY` and
`OPEN_AI_WINDOWS_API` both start from OPENAI once that is done, which is why
this catches a pair that raw character-by-character distance would not: as
written they differ by six characters out of fifteen.

Three signals, in order of confidence:

  1. the cores are identical            OPENAI_KEY        vs OPENAI_API_KEY
  2. one core contains the other        OPEN_AI_WINDOWS_API vs OPENAI_API_KEY
  3. the cores are near-identical text  ANTROPIC_API_KEY  vs ANTHROPIC_API_KEY

CRYING WOLF IS THE FAILURE MODE. Advice nobody trusts is worse than no advice,
so the search is deliberately narrow:

  - Only names the code REQUIRES and GitHub LACKS are looked up. If every
    required key is present there is nothing to suggest, whatever else is stored.
  - Only secrets that no function needs are offered as candidates. A legitimate
    secret — SUPABASE_ACCESS_TOKEN, SLACK_CHANGELOG_WEBHOOK, an optional one like
    VAPID_SUBJECT — is never suggested as a misspelling of something else.
  - A `VITE_`-prefixed name is never offered as a misspelling of the same name
    without it. In this repo that prefix means "compiled into the app people
    download", so VITE_VAPID_PUBLIC_KEY and VAPID_PUBLIC_KEY are two secrets on
    purpose. Suggesting they are the same mistake is precisely the crossed-pair
    error that scripts/verify-push-key.sh exists to catch.

The list of required names comes from scripts/function_secrets.py, which derives
it by reading the functions' own source. A second hand-maintained copy here
would go stale the first time a function changed — which happens: the move from
OpenAI to Anthropic on 2026-07-29 took OPENAI_API_KEY from six functions to two
without anyone editing a list.

Usage:
  gh api repos/OWNER/REPO/actions/secrets --paginate --jq '.secrets[].name' \
    | scripts/secret_name_audit.py

  scripts/secret_name_audit.py --have-file names.txt

Reads the names GitHub holds, one per line, from stdin or --have-file. Always
exits 0: this is advice, never a gate, and it must not be able to stop a deploy.
"""
from __future__ import annotations

import argparse
import difflib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import function_secrets  # noqa: E402

# Words that say nothing about WHICH secret a name refers to. Dropping them is
# what lets OPEN_AI_WINDOWS_API and OPENAI_API_KEY be recognised as the same
# intent. PRIVATE and PUBLIC are deliberately NOT here: they are the whole
# difference between the two halves of the push pair.
GENERIC_WORDS = {"API", "KEY", "KEYS", "TOKEN", "SECRET"}

# In this repo a VITE_ prefix means "compiled into the app people download", so
# VITE_X and X are two different secrets on purpose, not a typo for each other.
FRONTEND_PREFIX = "VITE"

# How alike two cores must read before it is worth mentioning. High on purpose:
# a wrong suggestion costs more than a missed one, because it teaches people to
# ignore the check.
TEXT_SIMILARITY_FLOOR = 0.85

# Below this, containment stops meaning anything - a two-letter core is inside
# half the names in any repo.
MIN_CONTAINMENT_LEN = 4


def words(name: str) -> list[str]:
    """Upper-cased words of a secret name, split on anything not alphanumeric."""
    out: list[str] = []
    current = ""
    for ch in name.upper():
        if ch.isalnum():
            current += ch
        elif current:
            out.append(current)
            current = ""
    if current:
        out.append(current)
    return out


def core(name: str) -> str:
    """The part of a name that identifies WHICH secret it is."""
    return "".join(w for w in words(name) if w not in GENERIC_WORDS)


def is_frontend_twin(a: str, b: str) -> bool:
    """True when the two names differ only by this repo's VITE_ prefix."""
    ca, cb = core(a), core(b)
    return ca == FRONTEND_PREFIX + cb or cb == FRONTEND_PREFIX + ca


def resemblance(required: str, stored: str) -> str | None:
    """Why `stored` looks like a misspelling of `required`, or None."""
    if required.upper() == stored.upper():
        return None
    if is_frontend_twin(required, stored):
        return None

    cr, cs = core(required), core(stored)
    if not cr or not cs:
        return None

    if cr == cs:
        return "the two names are the same once the words API, KEY, TOKEN and SECRET are set aside"

    if len(cr) >= MIN_CONTAINMENT_LEN and cr in cs:
        return "the name the app looks for is contained in the one you stored"
    if len(cs) >= MIN_CONTAINMENT_LEN and cs in cr:
        return "the name you stored is contained in the one the app looks for"

    if difflib.SequenceMatcher(None, cr, cs).ratio() >= TEXT_SIMILARITY_FLOOR:
        return "the two names are spelled almost identically"

    return None


def audit(required: list[str], optional: list[str], have: list[str]) -> list[dict]:
    """Near-misses between names the code requires and names GitHub holds.

    Only required names GitHub LACKS are looked up, and only stored names that
    no function needs are offered as candidates.
    """
    have_upper = {h.upper() for h in have}
    known = {n.upper() for n in required} | {n.upper() for n in optional}

    missing = [n for n in required if n.upper() not in have_upper]
    candidates = [h for h in have if h.upper() not in known]

    findings = []
    for name in missing:
        for stored in candidates:
            why = resemblance(name, stored)
            if why:
                findings.append({"required": name, "stored": stored, "why": why})
    return findings


def render(required: list[str], optional: list[str], have: list[str]) -> tuple[str, list[dict]]:
    """Plain-English report, plus the findings so a caller can annotate."""
    have_upper = {h.upper() for h in have}
    missing = [n for n in required if n.upper() not in have_upper]
    findings = audit(required, optional, have)
    lines: list[str] = []

    if not missing:
        lines.append(
            "Every key the app needs is stored in GitHub, so there is no missing "
            "name for a misspelled one to be mistaken for."
        )
        return "\n".join(lines), findings

    if not findings:
        lines.append(
            "%d key(s) the app needs are not stored in GitHub, and nothing "
            "stored under a similar name looks like a misspelling of them:"
            % len(missing)
        )
        lines.extend("    %s" % n for n in missing)
        lines.append("")
        lines.append(
            "So they look genuinely absent rather than misnamed. Add each one "
            "under exactly the name above."
        )
        return "\n".join(lines), findings

    lines.append(
        "A key the app needs may have been stored under the wrong name."
    )
    lines.append("")
    for f in findings:
        lines.append("  You have a secret called %s." % f["stored"])
        lines.append("  Did you mean %s?" % f["required"])
        lines.append("")
        lines.append("    The app only ever looks for the exact name %s, so a" % f["required"])
        lines.append("    secret spelled any other way is invisible to it - no")
        lines.append("    check can see it and nothing goes red.")
        lines.append("")
        lines.append("    Why this was flagged: %s." % f["why"])
        lines.append("")
        lines.append("    To fix: add a secret named exactly %s with the same" % f["required"])
        lines.append("    value, then delete %s so it cannot confuse anyone" % f["stored"])
        lines.append("    later. Nothing here can do that for you - this check")
        lines.append("    can read the names of secrets but never their values.")
        lines.append("")

    flagged = {f["required"] for f in findings}
    rest = [n for n in missing if n not in flagged]
    if rest:
        lines.append(
            "Also missing, with nothing similar stored, so they look genuinely "
            "absent rather than misnamed:"
        )
        lines.extend("    %s" % n for n in rest)

    return "\n".join(lines).rstrip(), findings


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="Flag secrets stored in GitHub under a near-miss of a name the app needs."
    )
    ap.add_argument(
        "--have-file",
        help="File of the secret names GitHub holds, one per line. Defaults to stdin.",
    )
    ap.add_argument(
        "--github-output",
        action="store_true",
        help="Also write finding count//names to $GITHUB_OUTPUT for the workflow.",
    )
    args = ap.parse_args(argv)

    if args.have_file:
        with open(args.have_file) as fh:
            raw = fh.read()
    else:
        raw = sys.stdin.read()
    have = [line.strip() for line in raw.splitlines() if line.strip()]

    reqs = function_secrets.all_requirements()
    required = function_secrets.required_union(reqs)
    optional = sorted({v for r in reqs.values() for v in r["optional"]})

    report, findings = render(required, optional, have)
    print(report)

    if args.github_output and os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as fh:
            fh.write("nearmiss_count=%d\n" % len(findings))
            fh.write(
                "nearmiss_pairs=%s\n"
                % "; ".join("%s -> %s" % (f["stored"], f["required"]) for f in findings)
            )

    # Always 0. This is advice, and advice must never stop a deploy.
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
