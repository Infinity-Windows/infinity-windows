# The test logins

There are **two** accounts an agent may sign in as. Nothing else. Both are
obviously named, both are flagged as robots in the database, and neither can
change anything on a real job.

| | Installer | Foreman |
| --- | --- | --- |
| Login | `qa.installer@crew.infinitywindows.app` | `qa.foreman@crew.infinitywindows.app` |
| Shows up as | **TEST — automation, do not assign** | **TEST — automation FOREMAN, do not assign** |
| Password in | `~/.config/infinity-windows/test-installer.env` | `~/.config/infinity-windows/test-foreman.env` |
| Repo secret | `TEST_INSTALLER_PASSWORD` | `TEST_FOREMAN_PASSWORD` |
| Workflow | `provision-test-installer.yml` | `provision-test-foreman.yml` |

Nothing is ever sent to either address — the domain is the one the app mints for
crew who have no email, and this project has no mail sender at all. They are
usernames.

## Which one to use

**Default to the installer.** It is the smaller blast radius and it reaches every
screen a crew member uses: My Work, Jobs, plan sets, Scan, Warehouse, Schedule,
Learn, Points, Safety, Photos, Profile.

**Use the foreman only for something an installer genuinely cannot reach.** As of
today that is:

- dragging a mark on the plan (`guard_opening_pin_move`, foreman+);
- the **Undo** bar and its attribution line (`undo_opening_pin_move`);
- **Put mark N back on the plan** and **Put every mark back**
  (`reset_opening_pin_to_extracted`, `reset_project_pins_to_extracted`);
- the moved-mark ring on a dot;
- **Load marks from plans** / re-extract, and deleting an opening;
- the foreman-only screens: Roster, Team, Issues, Service, Quality, Scheduling,
  Dispatch.

If you find yourself reaching for the foreman to check something an installer can
see, use the installer.

## Signing in, locally, right now

The passwords live in `~/.config/infinity-windows/`, mode `600`. From anywhere:

```bash
cat ~/.config/infinity-windows/test-installer.env
cat ~/.config/infinity-windows/test-foreman.env
```

Those print `TEST_INSTALLER_EMAIL` / `TEST_INSTALLER_PASSWORD` and
`TEST_FOREMAN_EMAIL` / `TEST_FOREMAN_PASSWORD`. Open the app
(`http://localhost:5173`, or your own dev port, or the deployed site) and type
them into the normal sign-in form. There is no special flow and no magic link —
they sign in exactly as a crew member does.

Driving one from a script instead of a browser:

```bash
set -a; . ~/.config/infinity-windows/test-foreman.env; set +a
# $TEST_FOREMAN_EMAIL and $TEST_FOREMAN_PASSWORD are now set.
```

**Why the home directory and not the repository.** Most work here happens in
`git worktree` checkouts — there were fourteen of them the day this was written —
and each one has its own working directory, so a file at `<repo>/.secrets/…`
exists for exactly one of them and is invisible to the other thirteen. One
location outside every checkout is readable from all of them, survives a branch
switch, and cannot be committed by accident. `.secrets/` is gitignored as well,
for anyone who prefers to keep a copy in-tree.

### If a file is not there

You are probably on a fresh machine — they are deliberately not in git. **You do
not need to ask anyone for a password.** Choose a new one and make the account
use it, which takes about a minute and needs only `gh`.

For the **installer**:

```bash
mkdir -p ~/.config/infinity-windows
NEW="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
printf 'TEST_INSTALLER_EMAIL=qa.installer@crew.infinitywindows.app\nTEST_INSTALLER_PASSWORD=%s\n' \
  "$NEW" > ~/.config/infinity-windows/test-installer.env
chmod 600 ~/.config/infinity-windows/test-installer.env

printf '%s' "$NEW" | gh secret set TEST_INSTALLER_PASSWORD \
  --repo Infinity-Windows/infinity-windows
unset NEW

gh workflow run provision-test-installer.yml --repo Infinity-Windows/infinity-windows
gh run watch "$(gh run list --workflow=provision-test-installer.yml --limit 1 \
  --json databaseId --jq '.[0].databaseId')" --repo Infinity-Windows/infinity-windows
```

For the **foreman**, the same three moves with the other name:

```bash
mkdir -p ~/.config/infinity-windows
NEW="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
printf 'TEST_FOREMAN_EMAIL=qa.foreman@crew.infinitywindows.app\nTEST_FOREMAN_PASSWORD=%s\n' \
  "$NEW" > ~/.config/infinity-windows/test-foreman.env
chmod 600 ~/.config/infinity-windows/test-foreman.env

printf '%s' "$NEW" | gh secret set TEST_FOREMAN_PASSWORD \
  --repo Infinity-Windows/infinity-windows
unset NEW

gh workflow run provision-test-foreman.yml --repo Infinity-Windows/infinity-windows
gh run watch "$(gh run list --workflow=provision-test-foreman.yml --limit 1 \
  --json databaseId --jq '.[0].databaseId')" --repo Infinity-Windows/infinity-windows
```

When the run is green the account's password is the value you just generated, and
your local file and the repo secret agree. Re-running does not create a second
account — it repairs the one that exists, through the same no-email password
reset a real crew member would be given.

## Where the credentials live, and why in two places

| Where | What for | Who can read it |
| --- | --- | --- |
| `~/.config/infinity-windows/test-*.env`, mode 600 | An agent or person working locally, in any checkout or worktree | Anyone on that machine |
| Repo secrets `TEST_INSTALLER_PASSWORD`, `TEST_FOREMAN_PASSWORD` | The workflows that set the accounts' passwords | Nothing and nobody — GitHub never gives a secret value back |

The passwords are generated **locally**, never inside CI. Anything invented
inside a workflow run can only leave it through a log or an artifact, and both
are readable by everyone with access to the repository. Generating them outside
means the value never crosses a log, and the local copy is the authoritative one:
the workflow's job is only to make the account agree with it.

Never paste a password into a PR, an issue, a commit message or a chat message,
and never move one inside a checkout.

## THE SANDBOX RULE

> A test login may only change the job called **`ZZTEST` — "TEST — automation
> sandbox, not a real job"**. Every other job on this database, including Black
> Desert and Smith Residence, is **read-only** to it.

This is not advice. Since migration
`20260730190000_test_accounts_sandbox_only.sql` the database refuses it:

- `public.sandbox_projects` lists the projects a test login may write. It holds
  exactly one row, the `ZZTEST` job. No client role can read or write that table
  at all, so an account cannot add itself a new playground.
- A `BEFORE INSERT OR UPDATE OR DELETE` trigger on **every project-scoped table
  in `public`** refuses a write by a profile flagged `is_test` when the row's
  project is not on that list. The tables are found from the catalogue rather
  than typed out, so a table added next month is covered by re-running the
  migration, and `public.test_account_write_scope()` reports any that are not.
- That covers the undo and reset RPCs for free. They are `SECURITY DEFINER` and
  so run past row-level security entirely, but they still have to write
  `project_openings`, and that write goes through the trigger. No RPC needed
  changing, and no policy a real foreman depends on was touched.
- Three **restrictive** policies on `storage.objects` stop a test login writing,
  overwriting or deleting a file outside the sandbox job's folder — that is what
  protects Black Desert's plan-set PDF. They are scoped to INSERT, UPDATE and
  DELETE only: **reading** a real plan set is untouched, because that is the
  whole reason the installer login exists.
- A test login is narrowed to **its own profile row**, so it cannot rename or
  deactivate a real crew member even though the Roster policy lets a real
  foreman do exactly that.

Every provisioning run **proves** this rather than claiming it. It creates a
throwaway job (`ZZTEST-DECOY`), tries as the foreman to move its mark, delete its
opening, insert an opening, delete the job, undo somebody else's move, reset its
marks, and overwrite and delete its plan set — asserts that all nine were
refused and that the job is bit-for-bit unchanged — then deletes it again. The
dangerous attempts are aimed at a job created ninety seconds earlier that nothing
depends on, so a guard that had broken could not have damaged a customer's work.
Against the real jobs the only probe is a write of a column back to the value it
already holds: refused if the guard is armed, and literally nothing if it were
not.

### What is left over, honestly

The rule is "this row belongs to that job", so it can only apply to a table that
can be tied to a job. A handful cannot be — the window-type catalogue, warehouse
shelves, cost codes, the points ledger, knowledge documents. A test login at
foreman rank can still write those. Two things make that acceptable rather than
ignored:

- none of them is a customer's job, an opening, a measurement, an assignment, a
  QC check or a photo — the things that represent field work someone was paid
  for;
- the provisioning run **prints the current list**, read from the live database
  via `public.test_account_write_scope()`, so it cannot quietly grow without
  somebody seeing it.

If that list ever needs closing, the honest fix is a per-table allowlist for test
accounts, not a wider guard — say so rather than widening this one.

## What they must not do

- **Do not clock in, with either account.** Timecards are payroll. A shift under
  one of these names would land in the weekly export and in the shifts a
  supervisor is asked to approve. `time_shifts`, `task_sessions` and
  `points_ledger` are deliberately **not** excluded from anybody's numbers,
  because they are per-person and reversible rather than a company-wide baseline.
  This rule was written for the installer account and it applies unchanged to the
  foreman.
- **Do not use the foreman where the installer will do.** See "Which one to use".
- **Do not give either a higher role.** Neither can promote itself, and a
  supervisor test account is a separate decision, not a promotion of one of
  these.
- **Do not assign them work.** Both are flagged "not on site today" so they do
  not appear as available, and their names say so.
- **Do not re-extract or delete on a real job, ever, even to test.** The database
  now refuses it, but the rule stands on its own: that is somebody's field work.

Both accounts **can** read the real jobs, including Black Desert and Smith
Residence, and their plan sets. Every installer can; that is what an installer's
job is, and opening a real plan set is the reason these logins exist.

## What the foreman cannot do, and how that is known

| It cannot… | Because | Proved by |
| --- | --- | --- |
| Invite anybody | `manage-crew-access` needs supervisor rank; it also refuses any `is_test` caller outright; and a `crew_invites` trigger refuses an invite authored by one | `create_invite` at installer AND owner rank both return 403 |
| Approve a request for access | `approve-access-request` has the same two gates | a call returns 403 |
| See who has been offered access | `crew_invites` SELECT policy is supervisor+ | reading the table returns nothing |
| Change anyone's role, including its own | `profiles.role` is revoked from `authenticated` at the column level; `set_profile_role()` needs supervisor rank; and a third trigger refuses a role change by a test account | the RPC is refused, the direct column write is refused, and the role is re-read as `foreman` |
| Rename or deactivate a real crew member | narrowed to its own profile row | a rename attempt is refused and the name is re-read unchanged |
| Clear its own test flag | `is_test` is revoked from `authenticated` at the column level | the write is refused and the flag is re-read as true |
| Add a real job to the jobs it may write | no client role holds any grant on `sandbox_projects` | the insert is refused and the table is re-read |

## How their work is kept out of the company's numbers

This is the part that mattered most, and it is enforced by the database rather
than by this document.

`install_events` is **empty** on production. `window_types.median_minutes` is the
target time for a window type, `p90_minutes` is the slow case, and
`learned_difficulty` is how hard the app believes the type is — all three are
recomputed from `install_events` by a trigger on every insert. So the first event
ever recorded *becomes* the baseline the crew are measured against, and dispatch
estimates from it. A test account tapping through one install to check that a
screen renders would have set that permanently, and nothing about the result
would have looked wrong.

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

**Nothing foreman-specific needed a new exclusion.** The figures a foreman's
actions feed are all derived from `install_events` (already excluded) or are
per-job rather than per-person: dispatch routing reads
`installer_type_stats`/`installer_category_stats`, which are excluded; scheduling
and the dispatch board read assignments on a job, and the only job this account
can write is the sandbox one, which is excluded from nothing because nothing
aggregates it. Moving a mark on the sandbox plan feeds no rollup at all — it
writes `project_openings.pin_x` and a row in `project_opening_pin_moves`, neither
of which is aggregated anywhere.

What is **not** excluded, because it is per-person and reversible rather than a
company-wide baseline: `points_ledger` rows, `time_shifts`, and `task_sessions`.
Hence "do not clock in". If one appears anyway, the row is named
"TEST — automation…" and can simply be deleted.

Each provisioning run proves the exclusion rather than asserting it: it writes a
real install event as the test account, checks that the target time, slow case,
difficulty and golden install did not move and that the account appears in no
per-installer stats, then deletes the event. It does that against `ZZTEST-TYPE`,
so an exclusion that had broken could only ever have marked up a window type
nobody installs.

## Creating, repairing and removing them

```bash
# Create, or reset the password to the current secret.
gh workflow run provision-test-installer.yml
gh workflow run provision-test-foreman.yml

# Delete the installer login, the sandbox job, its staging bays and the test
# window type. (This takes the foreman's sandbox with it — see below.)
gh workflow run provision-test-installer.yml -f remove=true

# Delete just the foreman login.
gh workflow run provision-test-foreman.yml -f remove=true
```

Both are manual workflows — the accounts are durable, so there is nothing to do
on a merge. They share a concurrency group, because they share the sandbox job
and the crew-invite machinery.

The `ZZTEST` sandbox belongs to the installer script; removing it deletes the
`sandbox_projects` row with it, which leaves the foreman account with nowhere it
may write. Re-running either provisioning workflow puts it back.

Both accounts are created by minting a real invite through `manage-crew-access`
and redeeming it through `redeem-crew-invite` — the same path an owner adding a
new hire takes, so every run also road-tests that flow. **Public signup stays
off** and nothing here touches it.

Why a workflow rather than a local script: creating a login needs the Supabase
management token, and no machine here holds one. GitHub does, as the repo secret
`SUPABASE_ACCESS_TOKEN` — the same one `deploy-backend.yml` uses. Signing in
afterwards needs nothing but the password, which is why that half works locally.

The shared plumbing is `scripts/lib/supabase_rest.py`; the sandbox job's plan
sheet is drawn from nothing by `scripts/lib/tiny_pdf.py`, because the project map
only offers a draggable mark when the job has a building PDF, and the only other
PDFs on this database are the two customers'.

## For Taylor

- These are robot accounts, not people. They show up in the crew list as
  **"TEST — automation, do not assign"** and **"TEST — automation FOREMAN, do
  not assign"**. Please don't give either any work, and don't worry when you see
  them.
- There is also a fake job called **"TEST — automation sandbox, not a real job"**
  (`ZZTEST`) and a fake window type. They exist so the robots have somewhere
  harmless to tap. They sort to the bottom of every list.
- **The robots cannot change anything on a real job.** Not Black Desert, not
  Smith Residence. They can look at them — that is how a plan-set fix gets
  checked — but the database refuses to let them move a mark, delete an opening,
  re-read a plan set or touch a file on any job except the fake one. That is
  enforced by the database, so it holds even if a script goes wrong.
- The foreman robot **cannot add anybody to the app** and **cannot change
  anybody's job title**. Only you and a supervisor can.
- Their work is **not** counted in anybody's numbers.
- If you ever want them gone, ask an agent to "remove the test accounts" and it
  takes two commands.
