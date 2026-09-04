#!/usr/bin/env python3
"""Tests for scripts/secret_name_audit.py.

Two things have to hold, and the second matters more than the first.

  1. It catches a real misnaming. The worked example is the one that actually
     happened: OPEN_AI_WINDOWS_API stored when the app looks for OPENAI_API_KEY.
     Note those differ by six characters out of fifteen, so anything relying on
     raw character distance alone would miss it.

  2. It does NOT cry wolf. Every legitimate secret this repo holds is checked
     against every name the app requires, and none of them may be reported.
     Advice that fires on SLACK_CHANGELOG_WEBHOOK is advice nobody reads, and a
     check nobody reads is how the original mistake survived a whole afternoon.

Nothing here touches the network, GitHub or a real secret: the "names GitHub
holds" are passed in as a plain list.

  python3 scripts/test_secret_name_audit.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import secret_name_audit as audit  # noqa: E402

REQUIRED = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY"]
OPTIONAL = ["VAPID_SUBJECT"]

# Every secret this repo really held on 2026-07-29, plus the misnamed one.
REAL_SECRETS = [
    "ANTHROPIC_API_KEY",
    "SLACK_CHANGELOG_WEBHOOK",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_DB_PASSWORD",
    "SUPABASE_SERVICE_ROLE_KEY",
    "VAPID_PRIVATE_KEY",
    "VAPID_PUBLIC_KEY",
    "VITE_SUPABASE_ANON_KEY",
    "VITE_SUPABASE_URL",
    "VITE_VAPID_PUBLIC_KEY",
]

passed = 0
failed = 0


def check(label: str, got, want) -> None:
    global passed, failed
    if got == want:
        passed += 1
    else:
        failed += 1
        print("FAIL: %s\n      got:  %r\n      want: %r" % (label, got, want))


def flags(required: str, stored: str) -> bool:
    return audit.resemblance(required, stored) is not None


# --- the mistake that actually happened ------------------------------------

check(
    "OPEN_AI_WINDOWS_API is flagged as OPENAI_API_KEY",
    flags("OPENAI_API_KEY", "OPEN_AI_WINDOWS_API"),
    True,
)

# Proof that raw character distance would NOT have caught it, which is why the
# matching works on normalised words instead.
import difflib  # noqa: E402

_raw = difflib.SequenceMatcher(None, "OPENAI_API_KEY", "OPEN_AI_WINDOWS_API").ratio()
check("raw character similarity of that pair is below the floor", _raw < 0.85, True)

# --- other realistic near-misses -------------------------------------------

for stored in [
    "OPENAI_KEY",           # dropped a word
    "OPEN_AI_API_KEY",      # split OPENAI into two words
    "OPENAI_APIKEY",        # ran two words together
    "OPENAI_API_TOKEN",     # said TOKEN instead of KEY
    "OPENAI_SECRET_KEY",    # added a word
]:
    check("near-miss flagged: %s" % stored, flags("OPENAI_API_KEY", stored), True)

# A name differing only in case is the SAME secret, not a near-miss: GitHub
# treats secret names case-insensitively. So it must be counted as present and
# never suggested as a misspelling of itself.
check(
    "a case-only difference is not reported as a misspelling",
    flags("OPENAI_API_KEY", "openai_api_key"),
    False,
)
check(
    "a case-only difference counts as the key being present",
    audit.audit(["OPENAI_API_KEY"], [], ["openai_api_key"]),
    [],
)

check(
    "a misspelling is flagged: ANTROPIC_API_KEY",
    flags("ANTHROPIC_API_KEY", "ANTROPIC_API_KEY"),
    True,
)
check(
    "a dropped word is flagged: ANTHROPIC_KEY",
    flags("ANTHROPIC_API_KEY", "ANTHROPIC_KEY"),
    True,
)
check(
    "a dropped word is flagged: VAPID_PRIVATE",
    flags("VAPID_PRIVATE_KEY", "VAPID_PRIVATE"),
    True,
)

# --- must NOT cry wolf -----------------------------------------------------
#
# Every real secret against every required name. One wrong suggestion here and
# nobody trusts the check again.

for required in REQUIRED:
    for stored in REAL_SECRETS:
        if required.upper() == stored.upper():
            continue
        check(
            "not flagged: %s is not a misspelling of %s" % (stored, required),
            flags(required, stored),
            False,
        )

# The two halves of the push pair are different secrets, and so is the frontend
# copy of the public half. Confusing them is the exact silent breakage
# scripts/verify-push-key.sh exists to catch, so suggesting it would be worse
# than saying nothing.
check(
    "VITE_VAPID_PUBLIC_KEY is not offered as a misspelling of VAPID_PUBLIC_KEY",
    flags("VAPID_PUBLIC_KEY", "VITE_VAPID_PUBLIC_KEY"),
    False,
)
check(
    "VAPID_PUBLIC_KEY is not offered as a misspelling of VAPID_PRIVATE_KEY",
    flags("VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY"),
    False,
)
check(
    "VAPID_SUBJECT is not offered as a misspelling of VAPID_PUBLIC_KEY",
    flags("VAPID_PUBLIC_KEY", "VAPID_SUBJECT"),
    False,
)
check(
    "the two AI vendors are not confused with each other",
    flags("ANTHROPIC_API_KEY", "OPENAI_API_KEY"),
    False,
)

# The GC email's sender addresses (2026-09-04). Three names a word apart —
# EMAIL_FROM, EMAIL_FROM_STG, EMAIL_FROM_FORGE — stored side by side in the
# same project, which is exactly the shape that makes a "did you mean" line
# tempting and wrong. Two things have to hold.
#
# First, none of them may ever be offered as a misspelling of a key the app
# really needs: an owner who adds a sender address must not be told he has
# fumbled his Anthropic key.
for stored in ["EMAIL_FROM", "EMAIL_FROM_STG", "EMAIL_FROM_FORGE"]:
    for required in REQUIRED:
        check(
            "not flagged: %s is not a misspelling of %s" % (stored, required),
            flags(required, stored),
            False,
        )

# Second, they are all OPTIONAL — each one falls back to the next and then to a
# built-in address — and an optional name is never a candidate. So setting one
# brand's address and not the other's produces no advice at all, which is the
# right amount: nothing is missing.
check(
    "a brand sender address on its own produces no advice",
    audit.audit(
        REQUIRED,
        ["EMAIL_FROM", "EMAIL_FROM_STG", "EMAIL_FROM_FORGE"],
        REQUIRED + ["EMAIL_FROM_STG"],
    ),
    [],
)

# --- the search is narrow on purpose ---------------------------------------

# Today's actual state: the key was misnamed and everything else was in place.
today = [s for s in REAL_SECRETS] + ["OPEN_AI_WINDOWS_API"]
found = audit.audit(REQUIRED, OPTIONAL, today)
check("today's state produces exactly one finding", len(found), 1)
check("...naming the stored secret", found[0]["stored"], "OPEN_AI_WINDOWS_API")
check("...and the name the app wants", found[0]["required"], "OPENAI_API_KEY")

# With the key correctly named, the misnamed leftover must NOT be reported:
# nothing is missing, so there is nothing to suggest.
fixed = today + ["OPENAI_API_KEY"]
check(
    "nothing is flagged once the correctly named key exists",
    audit.audit(REQUIRED, OPTIONAL, fixed),
    [],
)

# An optional secret is never offered as a candidate.
check(
    "an optional secret is not offered as a misspelling",
    audit.audit(["VAPID_PUBLIC_KEY"], ["VAPID_SUBJECT"], ["VAPID_SUBJECT"]),
    [],
)

# A genuinely absent key is reported as absent, not as a misnaming.
report, found = audit.render(REQUIRED, OPTIONAL, REAL_SECRETS)
check("a genuinely absent key produces no finding", found, [])
check("...and is described as absent rather than misnamed", "genuinely absent" in report, True)
check("...and names the missing key", "OPENAI_API_KEY" in report, True)

# The healthy case says so plainly.
report, found = audit.render(REQUIRED, OPTIONAL, REQUIRED)
check("all present: no findings", found, [])
check("all present: says every key is stored", "Every key the app needs" in report, True)

# --- never a gate ----------------------------------------------------------

check("exit code is 0 with a finding", audit.main(["--have-file", "/dev/null"]), 0)

print()
print("passed: %d" % passed)
print("failed: %d" % failed)
sys.exit(1 if failed else 0)
