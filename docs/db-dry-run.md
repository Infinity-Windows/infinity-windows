# The rolled-back database practice run

Try a pull request's new migrations and RPCs on the real database, as the
people who will use them, inside one transaction that is always thrown away.

## When

**Every pull request that adds a migration or an RPC, before it merges.**

Twice a migration passed every local test and failed in production on a
constraint the local copy never had. On 2026-09-06 #578's finalize hit
`movements_one_subject_ck` after a dry run that had only counted objects and
never called the RPC. PGlite and a fixture schema are the tests' world; the
crew's world has every constraint, trigger, grant and row of the last three
months in it. So the rule: every new migration is applied and every new RPC is
**called**, as a real role on the sandbox job, inside a transaction that is
then rolled back.

## How

1. Write a probe: copy `scripts/dry-run-probes/TEMPLATE.sql` to
   `scripts/dry-run-probes/pr-<number>-<what>.sql` and make it call every RPC
   the pull request adds or changes — as an installer, a foreman, whoever will
   call it — on **the sandbox job** (`pg_temp.dry_run_sandbox_job()`),
   recording a check for every outcome. The template explains the helpers and
   the rules.

2. Run it from GitHub, which is the only place the management token lives:

   ```bash
   gh workflow run db-dry-run.yml \
     -f ref=claude/r0-clock-integrity \
     -f migrations="supabase/migrations/20261028000000_clock_integrity.sql supabase/migrations/20261028010000_clock_integrity_note.sql" \
     -f probe=scripts/dry-run-probes/pr-640-clock-integrity.sql
   gh run watch "$(gh run list --workflow=db-dry-run.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   ```

   `ref` is the branch to try. `migrations` are its migration files, in the
   order they apply; leave it blank and the run tries every migration the
   branch adds on top of master. `probe` is taken from the branch when it has
   one at that path, otherwise from master — so a probe merged here can try a
   branch that was cut before it existed.

3. Read the run's summary. Green means every check passed; red means the
   change is not ready. Either way nothing was kept.

## Reading the result

The summary is one table, one line per check the probe recorded:

```
Rolled-back database practice run on czprjcskmzzagdztqonm
  ok    clock_in: the same client id again answers with the original shift   shift 3f2c…
  FAIL  clock_out: the same id again moves nothing                          9999 s, submitted
```

Four outcomes, by exit code:

| | It means | Do |
|---|---|---|
| **ok, every check** (0) | The migration applied to the real schema and every RPC did what the probe expected. | Merge. |
| **FAIL** (1) | A statement failed — the database's own error is printed, constraint name and all — or a check reported a failure, or the probe recorded no checks. | Fix the change (or the probe) and run again. |
| **REFUSED** (2) | Nothing was sent. A migration or probe carried something that could escape the transaction, a file was missing, or the token or project was not set. | Read the reason; it says what to change. |
| **COULD NOT TELL** (3) | Nothing was measured: no answer, a lock or statement timeout, a token or project problem — or the run stopped on a `dry run:` sentence while setting itself up, before the change was tried. | Run again in a quieter minute. After a `dry run:` sentence, fix what it names first (below). |

### When the run stops on "dry run:"

Rather than try the change under the wrong conditions, the harness stops with
one plain sentence that starts `dry run:`. The report says the run **could not
set itself up**. The change was never tried, so it is not called broken. The
two you will meet:

| It says | Why | Do |
|---|---|---|
| `no QA login has the installer role — set qa.installer (…) to Installer in the app` (or the same for the foreman) | That QA login's role was changed in the app. The picker used to hand back a real person instead, whom the database refuses on a testing job, so the run died on a sentence like "Choose an existing job for the daily log." that read as a product bug: three runs of #641's probe on 2026-09-23/24. | Set the login back to its role in the app. A probe that really means a real person calls `dry_run_pick_real`. |
| `no job is both flagged as testing and on the sandbox list` | No live job is a testing project on the sandbox list, so the QA logins have nowhere to write. | A supervisor or above marks a practice job as testing in the app; that puts it on the sandbox list too. |

A probe that cannot start for a reason of its own (nothing on the sandbox job
to try the change on) stops the same way, with its own `dry run:` sentence.

## The guarantee

The whole run is **one** statement batch:

```
begin;  →  harness  →  the migrations, in order  →  the probe
        →  do $$ raise exception 'DRY_RUN_RESULT:<the checks>' $$
```

The last statement always raises. Postgres therefore rolls the entire batch
back whether or not anything before it misbehaved — the migration, the
probe's writes, every helper — and the error message is how the results get
out. If a statement fails earlier, that error is the result and the rollback
is the same. The connection is closed after the answer, which is a second
rollback on top of the first.

Before a byte is sent, `scripts/db-dry-run.sh` refuses anything that could
break out of that transaction: a `commit` or `rollback` anywhere, `create
index concurrently`, `vacuum`, `alter system`, a psql command. A migration
that wraps *itself* in `begin;` … `commit;` (fourteen on master do, and
`supabase db push` accepts them because it, too, applies each file in a
transaction of its own) has that wrapper set aside and runs under the batch's
transaction instead. A probe is refused for any transaction control at all.

Honest limits:

- **Sequence numbers are the one trace.** A rollback cannot un-take a
  `nextval`, so a table with a serial id skips a few numbers. Nothing else is
  left behind; `scripts/db-dry-run-harness.test.sh` proves that on a real
  PostgreSQL 16 every time CI runs.
- **Locks are real, for a few seconds.** `alter table time_shifts` waits for
  the clock punches in flight and then blocks the next ones until the batch
  ends, exactly as the deploy will. The batch sets `lock_timeout` to 5 s so it
  fails rather than queues the crew behind it; `DB_DRY_RUN_LOCK_TIMEOUT` and
  `DB_DRY_RUN_STATEMENT_TIMEOUT` raise the limits for a migration that
  genuinely needs longer.
- **It proves the SQL, not the pipeline.** Migration numbering, the CLI's
  history table and the edge functions are `deploy-backend.yml`'s to check.
- **The sandbox job is the belt to these braces.** Everything is rolled
  back; probes write on the sandbox job anyway, so that even a rollback that
  failed could have touched nothing real. `dry_run_sandbox_job()` reads it at
  run time — the live job that is both flagged as testing and on the sandbox
  list, PECAN14 first — because no code stays the sandbox for good: BLACK22
  was, until 2026-09-24. The QA test logins (`docs/test-account.md`) are the
  callers for the same reason: the database fences them to the sandbox. An
  installer or a foreman is the QA login or nobody; the other roles have no
  QA login, so their pick is a real person, rolled back like everything else.

The token is never printed and never put on a command line: curl reads it
from a private config file that is deleted on exit, and everything printed
passes through a scrubber that also drops any email address, because the
run's log is readable by everyone with access to the repository.
