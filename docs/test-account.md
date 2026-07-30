# The test login

There is one account an agent may sign in as. It is an **installer**, it is
called **“TEST — automation, do not assign”**, and its login is:

```
qa.installer@crew.infinitywindows.app
```

Nothing is ever sent to that address — the domain is the one the app mints for
crew who have no email, and this project has no mail sender at all. It is a
username.

## Why it exists

Almost every screen in this app needs a login, so before this account existed a
fix could be shipped and never actually seen on the screen it fixed. That is not
hypothetical: “plan sets do not render on an iPhone” — the single most important
screen a crew uses — went unverified because nobody could open it. This account
is here so that never costs anyone a day again.

## Signing in, locally, right now

The password lives in **`.secrets/test-installer.env`**, which is gitignored and
never committed. From the repository root:

```bash
cat .secrets/test-installer.env
```

That prints `TEST_INSTALLER_EMAIL` and `TEST_INSTALLER_PASSWORD`. Open the app
(`http://localhost:5173`, or the deployed site), and type them into the normal
sign-in form. There is no special flow and no magic link — it signs in exactly
as a crew member does.

Driving it from a script instead of a browser:

```bash
set -a; . .secrets/test-installer.env; set +a
# $TEST_INSTALLER_EMAIL and $TEST_INSTALLER_PASSWORD are now set.
```

### If `.secrets/test-installer.env` is not there

You are probably on a fresh clone, or in a worktree that never had it — the file
is deliberately not in git. **You do not need to ask anyone for the password.**
Choose a new one and make the account use it, which takes about a minute and
needs only `gh`:

```bash
mkdir -p .secrets
NEW="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
printf 'TEST_INSTALLER_EMAIL=qa.installer@crew.infinitywindows.app\nTEST_INSTALLER_PASSWORD=%s\n' \
  "$NEW" > .secrets/test-installer.env
chmod 600 .secrets/test-installer.env

printf '%s' "$NEW" | gh secret set TEST_INSTALLER_PASSWORD \
  --repo Infinity-Windows/infinity-windows
unset NEW

gh workflow run provision-test-installer.yml --repo Infinity-Windows/infinity-windows
gh run watch "$(gh run list --workflow=provision-test-installer.yml --limit 1 \
  --json databaseId --jq '.[0].databaseId')" --repo Infinity-Windows/infinity-windows
```

When that run is green the account’s password is the value you just generated,
and your local file and the repo secret agree. Re-running it does not create a
second account — it repairs the one that exists, through the same no-email
password reset a real installer would be given.

## Where the credentials live, and why in two places

| Where | What for | Who can read it |
| --- | --- | --- |
| `.secrets/test-installer.env` (gitignored) | An agent or person working locally | Anyone on that machine |
| Repo secret `TEST_INSTALLER_PASSWORD` | The workflow that sets the account’s password | Nothing and nobody — GitHub never gives a secret value back |

The password is generated **locally**, never inside CI. Anything invented inside
a workflow run can only leave it through a log or an artifact, and both are
readable by everyone with access to the repository. Generating it outside means
the value never crosses a log, and the local copy is the authoritative one: the
workflow’s job is only to make the account agree with it.

Never commit `.secrets/`, and never paste the password into a PR, an issue, a
commit message or a chat message.

## What it can reach

It is an installer, so it gets exactly the installer surface — see
[`role-access.md`](role-access.md) for the generated list. In short:

- **Yes:** My Work, Jobs (`/projects`) and every plan-set and opening screen
  under them, Scan, Warehouse, My Schedule, Learn, Points, Safety, Travel, Ask,
  Search, Memo review, Completed installs, Milestones, Photos, Profile,
  Settings.
- **No:** Roster, Team, Timecard, Issues, Service, Quality, Analytics, Training,
  Receive, Catalog, Supplies, Scheduling, Vehicles, Heartbeat, Admin, Crew
  access, Cost codes, Cost, AI spend, AI Knowledge.

The “No” list is not just a hidden menu. `is_foreman_plus()` returns false for
it, it cannot read `crew_invites`, and `manage-crew-access` refuses it with a
403 — all three are asserted on every provisioning run.

It **can** read the real jobs, including Black Desert and Smith Residence, and
their plan sets. Every installer can; that is what an installer's job is, and
opening a real plan set is the reason this login exists.

## What it must not do

- **Do not clock in.** Timecards are payroll. A shift under this name would land
  in the weekly export and in the shifts a supervisor is asked to approve.
- **Do not touch a real job's openings.** Do not mark one installed, do not
  undo an install, do not assign or unassign anything on Black Desert or Smith
  Residence. Those are live jobs with real field work recorded against them.
- **Do not give it a higher role.** If you need to test a foreman screen, that
  is a second account and a separate decision, not a promotion of this one.
- **Do not assign it work.** It is flagged “not on site today” so it does not
  appear as available, and its name says so.

If you need to exercise a flow that writes something, there is a sandbox job for
it: **`ZZTEST` — “TEST — automation sandbox, not a real job”**, with one opening
(`TEST-1`) and its own window type (`ZZTEST-TYPE`). Sorts last in every list.
Nothing real depends on it, so break it freely.

## How its work is kept out of the company's numbers

This is the part that mattered most, and it is enforced by the database rather
than by this document.

`install_events` is **empty** on production. `window_types.median_minutes` is
the target time for a window type, `p90_minutes` is the slow case, and
`learned_difficulty` is how hard the app believes the type is — all three are
recomputed from `install_events` by a trigger on every insert. So the first
event ever recorded *becomes* the baseline the crew are measured against, and
dispatch estimates from it. A test account tapping through one install to check
that a screen renders would have set that permanently, and nothing about the
result would have looked wrong.

Migration `20260730120000_test_accounts_excluded_from_learning.sql` adds
`profiles.is_test` and excludes any profile carrying it from:

- `recompute_window_type_rollups()` — target time, slow case, average grade,
  fail rate, learned difficulty;
- `pick_golden_install()` — the worked example the crew are shown for a type;
- `installer_type_stats` and `installer_category_stats` — the per-installer
  figures `assign_opening_to_installer` ranks on.

`is_test` is readable by everyone and writable by nobody: only the service-role
key can set it, exactly like `role`. A crew member who could clear their own flag
could launder a fabricated time into the baseline, and one who could set it on
somebody else could erase that person's record from the numbers.

The points leaderboard is assembled in the browser rather than in the database,
so it is filtered in `app/src/lib/points.ts` (`rankLeaderboard`) for the same
reason.

Every provisioning run **proves** this rather than asserting it: it writes a real
install event as the test account, checks that the target time, slow case,
difficulty and golden install did not move and that the account appears in no
per-installer stats, then deletes the event. It does that against `ZZTEST-TYPE`,
so an exclusion that had broken could only ever have marked up a window type
nobody installs.

What is **not** excluded, because it is per-person and reversible rather than a
company-wide baseline: `points_ledger` rows, `time_shifts`, and `task_sessions`.
Hence “do not clock in”. If one appears anyway, the row is named
“TEST — automation, do not assign” and can simply be deleted.

## Creating, repairing and removing it

All of it is `.github/workflows/provision-test-installer.yml`, which runs
`scripts/provision-test-installer.py`. It is a manual workflow — the account is
durable, so there is nothing to do on a merge.

```bash
# Create it, or reset its password to the current secret.
gh workflow run provision-test-installer.yml

# Delete the login, the sandbox job, its staging bays and the test window type.
gh workflow run provision-test-installer.yml -f remove=true
```

The account is created by minting a real invite through `manage-crew-access` and
redeeming it through `redeem-crew-invite` — the same path an owner adding a new
hire takes, so every run also road-tests that flow. **Public signup stays off**
and nothing here touches it.

Why a workflow rather than a local script: creating a login needs the Supabase
management token, and no machine here holds one. GitHub does, as the repo secret
`SUPABASE_ACCESS_TOKEN` — the same one `deploy-backend.yml` uses. Signing in
afterwards needs nothing but the password, which is why that half works locally.

## For Taylor

- This is a robot account, not a person. It will show up in the crew list as
  **“TEST — automation, do not assign”**. Please don’t give it any work, and
  don’t worry when you see it.
- There is also a fake job called **“TEST — automation sandbox, not a real job”**
  (`ZZTEST`) and a fake window type. They exist so the robot has somewhere
  harmless to tap. They sort to the bottom of every list.
- Its work is **not** counted in anybody’s numbers, and it cannot see wages,
  costs, the roster or anything an installer wouldn't.
- If you ever want it gone, ask an agent to “remove the test account” and it
  takes one command.
