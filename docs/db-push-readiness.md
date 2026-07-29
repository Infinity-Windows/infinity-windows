# Turning on automatic migrations — readiness and runbook

> **Short answer: it is safe to add `SUPABASE_ACCESS_TOKEN` and
> `SUPABASE_DB_PASSWORD` right now.** With the migration history in its current
> state `supabase db push` refuses to run at all and exits before it writes a
> single byte to production, so no secret you add can cause a bad apply.
>
> The cost of adding them before the cleanup is noise, not damage: the **Push
> migrations** job will go red on every merge to `master`, and no migration —
> old or new — will be applied until the phantom rows are gone.
>
> If you would rather never see a red run, add `SUPABASE_ACCESS_TOKEN` only
> (that lights up edge-function deploys, which is the part that is genuinely
> broken today), run the cleanup, then add `SUPABASE_DB_PASSWORD`. See
> [the runbook](#the-runbook).

Companion to [`docs/migration-repair-2026-07-29-production.md`](./migration-repair-2026-07-29-production.md),
which is the record of how the history table ended up in this state.

Everything below is derived from the Supabase CLI source at the version the
workflow now pins, **v2.110.0** — see [Where this comes from](#where-this-comes-from).
`.github/workflows/deploy-backend.yml` used to install `latest`; it is pinned so
that this reasoning stays true until someone deliberately bumps it.

## The state we are reasoning about

| | |
| --- | --- |
| Migration files in `supabase/migrations/` | 70 |
| Rows in `supabase_migrations.schema_migrations` on production | 107 |
| Rows whose `version` matches a filename | 70 — all of them, correctly |
| **Phantom rows — a `version` matching no file** | **37** |

The 37 split into 26 stamped `2026072917xxxx`/`2026072918xxxx` by the Supabase
MCP `apply_migration` tool (it writes its own wall-clock time as the `version`
instead of the file's) and 11 older ad-hoc rows from `20260715185858` to
`20260720223956`.

Note that all 26 of the today-dated phantoms sort *after* every one of the 70
filenames, the newest of which is `20260728170000`.

## What `db push` does today

**It fails immediately, before touching the database, and `--include-all` does
not get past it.**

The CLI compares *versions*, nothing else. It reads the remote versions with
`SELECT version FROM supabase_migrations.schema_migrations ORDER BY version`,
lists the local filenames, and merge-walks the two sorted lists. Every step of
the walk puts an entry in one of two buckets:

* a remote version with no matching file → **missing**
* a local file with no matching remote version, sitting *before* the end of the
  remote list → **unapplied** (an out-of-order migration)

Those two buckets raise two different errors, and this is the distinction that
matters here:

| Bucket | Error | Rescued by `--include-all`? |
| --- | --- | --- |
| unapplied | `Found local migration files to be inserted before the last migration on remote database.` | **yes** |
| missing | `Remote migration versions not found in local migrations directory.` | **no** |

The missing bucket is checked **first**, so it wins whenever both are non-empty.

Walking our numbers: each of the 70 filename versions finds its match and both
cursors advance; the 11 old phantoms are interleaved among them and each lands
in *missing*; the local list then runs out, and the walk sweeps every remaining
remote version — the 26 today-dated phantoms — into *missing* too. Result:
**missing = 37, unapplied = 0**, and the command exits with:

```
Remote migration versions not found in local migrations directory.

Make sure your local git repo is up-to-date. If the error persists, try repairing the migration history table:
supabase migration repair --status reverted 20260715185858 20260716… …

And update local migrations to match remote database:
supabase db pull
```

Non-zero exit, so the workflow step goes red.

So, of the four possibilities: it is **not** the "inserted before the last
migration on remote database" error (that one is about out-of-order *local*
files, and we have none); `--include-all` does **not** help; nothing is
silently skipped; and it does **not** proceed cleanly. It is the fifth outcome —
a hard refusal on the *remote-only* versions.

### Nothing is written on the way to that failure

The pending-migration calculation happens before any write. The history table
is only created, the vault secrets are only upserted, and migration SQL is only
executed, inside the branch that runs when there is at least one pending
migration — which this never reaches. The `supabase link` step in front of it
is Management-API GETs plus some local files under `supabase/.temp`; it does not
connect to Postgres in this version.

## What happens to a *new* migration — the part that matters

**A new migration is never silently skipped. The push fails loudly and applies
nothing, including the new file.**

Add `20260730000000_whatever.sql` and the walk goes exactly as above, except the
26 today-dated phantoms now sort *before* the new file instead of running off
the end. They still land in *missing*, missing is still 37, and the same
`Remote migration versions not found…` error still fires — before the new file
is considered at all.

Back-dating the new file does not change the outcome either. A file dated
before the phantoms puts itself in the *unapplied* bucket, but missing is
checked first, so you still get the same error.

There is no version you can give a new migration file that lets it through
while the phantoms exist. **Until the cleanup runs, the migration pipeline is
stopped, and it is stopped in the loud way, not the silent one.** Nothing can
reach production believing it shipped when it did not.

### After the cleanup

With 70 rows and 70 files, adding `20260730000000_whatever.sql` gives a walk
where all 70 match, the remote list runs out, and everything after it —
the one new file — becomes pending. `db push` applies it and records it under
its own filename version. That is the behaviour we want, and it is what the
cleanup restores.

## Does the dry-run gate actually hold?

Yes. Verified, and tightened.

* The **Push** step comes after **Dry run** in the same job, and GitHub applies
  a default status check of `success()` to any `if:` that does not name a status
  function ([expressions reference](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions)).
  A failing dry run therefore skips the push on its own.
* Neither step carries `continue-on-error`, and no step in the workflow does.
* The two steps are in one job, so no `needs:` ordering can be got wrong.

The one way that gate could have been quietly defeated is somebody adding
`continue-on-error: true` to the dry run to get past a red build — that makes
the step *conclude* as success. So Push now also requires
`steps.dryrun.outcome == 'success'`. `outcome` is the result *before*
`continue-on-error` is applied, so the gate holds even then.

The dry run also does the `supabase link`, which means a failure to link stops
the push too.

## The runbook

Do these in order. Steps 1 and 2 can swap; nothing here is destructive to
application data.

### 0. Merge the PR that adds this document

It also pins the CLI version and hardens the gate above.

### 1. Add `SUPABASE_ACCESS_TOKEN`

Repo → Settings → Secrets and variables → Actions → New repository secret.
Value is a personal access token, `sbp_…`.

On the next merge, edge functions start deploying — that is the gap that has
actually been hurting. The **Push migrations** job stays skipped (a yellow
warning, not a failure) for as long as `SUPABASE_DB_PASSWORD` is absent.

### 2. Clear the phantom rows

From a checkout of `master`:

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...
export SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm

# Preview. Writes nothing. Prints the exact rows it would delete.
scripts/cleanup-migration-phantoms.sh
```

It prints what it measured — files on disk, rows in the history table, phantom
rows, and how many of those phantoms sort after every migration file — and then
lists every row it would delete.

**Read the list, not the totals.** The counts move whenever anyone merges a
migration or applies SQL through MCP, so the script no longer asserts them; it
reports them. (It used to pin `70` / `107` / `37` and refuse to run when any of
the three drifted, which was after roughly every merge. A check whose expected
value drifts under ordinary team activity only teaches people to bump it.)

Two things *do* stop it, and neither has an override:

* **a migration file with no applied row** — the opposite problem, and the
  serious one: something in the repo never reached the database;
* **two files claiming one version** — the history table is keyed by version,
  so one of the pair can never be recorded. Rename the later file.

The phantoms listed as sorting *after* every migration file are the live leak
rather than history: something is still applying SQL outside
`supabase/migrations/`. They are safe to delete, but see
[Keeping it clean](#keeping-it-clean).

When the preview looks right:

```bash
scripts/cleanup-migration-phantoms.sh --execute
```

It deletes by an explicit list of exactly the versions it just printed, inside a
transaction whose guard rolls the whole thing back unless the table ends up with
one row per migration file and every filename version intact — a figure counted
from the files on disk during that same run, not a number committed in the
script — then re-reads the table and checks again independently. Finish on:

```
    <N> rows, one per migration file, nothing missing
```

Those rows hold no application data. Deleting them changes no table, no column
and no row of anyone's work — only the CLI's bookkeeping.

**CLI-native alternative.** `supabase migration repair --status reverted <version> …`
deletes the same rows and is what the CLI itself suggests. It works, but it
takes the versions on trust and checks nothing before or after, so prefer the
script.

### 3. Add `SUPABASE_DB_PASSWORD`

Same place. Now both jobs are armed.

### 4. Prove it

Actions → **Deploy backend** → Run workflow (on `master`). The **Push
migrations** job should be green, with the dry run reporting that there is
nothing to do.

## What a healthy dry run looks like

Nothing to apply — the normal state between migrations:

```
DRY RUN: migrations will *not* be pushed to the database.
Remote database is up to date.
```

With a genuinely new migration waiting:

```
DRY RUN: migrations will *not* be pushed to the database.
Would push these migrations:
 • 20260730000000_whatever.sql
Finished supabase db push.
```

Read the bullet list. It is the complete set of files the Push step is about to
run against production, and the last chance to notice one you did not expect.

## If it errors

**`Remote migration versions not found in local migrations directory.`**
Phantom rows again. Run the cleanup in step 2. Do **not** follow the CLI's
second suggestion, `supabase db pull` — that writes a new local migration file
containing a dump of the whole remote schema, which is a much bigger mess than
the one you started with.

**`Found local migration files to be inserted before the last migration on
remote database.`**
Someone committed a migration dated earlier than one already applied. Correct
answer is almost always to rename the file to a current timestamp and re-push;
`--include-all` will force it through in the wrong order and is a last resort.

**A migration's SQL fails.**
The push stops at that file. Everything before it is applied and recorded;
that file and everything after it is not. Fix the SQL in a new PR — never by
hand on the server, or the history table drifts again.

**Anything else.** The job summary links back here. Re-running the workflow is
always safe: a push that failed before applying anything leaves nothing behind,
and the migration files are written to be idempotent.

## Keeping it clean

The 26 worst phantoms exist because migrations were applied through the Supabase
MCP `apply_migration` tool, which records its own timestamp rather than the
file's. Once the workflow is live, land schema changes as a migration file in a
PR and let the workflow push them. Applying SQL to production by hand or through
MCP puts the two out of step again, and the next `db push` stops dead in exactly
the way described above.

## Where this comes from

Behaviour above is read from the Supabase CLI at tag `v2.110.0`, the version
`.github/workflows/deploy-backend.yml` now pins:

* [`pkg/migration/apply.go`](https://github.com/supabase/cli/blob/v2.110.0/apps/cli-go/pkg/migration/apply.go)
  — `FindPendingMigrations`, the merge-walk, and the two error values.
* [`internal/migration/up/up.go`](https://github.com/supabase/cli/blob/v2.110.0/apps/cli-go/internal/migration/up/up.go)
  — `GetPendingMigrations`, which shows `--include-all` acting only on the
  out-of-order error.
* [`internal/db/push/push.go`](https://github.com/supabase/cli/blob/v2.110.0/apps/cli-go/internal/db/push/push.go)
  — the order of operations, and the exact dry-run output strings.
* [`pkg/migration/list.go`](https://github.com/supabase/cli/blob/v2.110.0/apps/cli-go/pkg/migration/list.go)
  — `ORDER BY version` and the `<timestamp>_name.sql` filename pattern.
* [`internal/link/link.go`](https://github.com/supabase/cli/blob/v2.110.0/apps/cli-go/internal/link/link.go)
  — `supabase link` makes no write to the database.

No database was contacted while writing this. It is source reading and
arithmetic against the counts recorded in the repair document.
