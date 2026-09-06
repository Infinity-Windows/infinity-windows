# Backups

The database is payroll truth. It is where an installer's hours live, where the
photos proving a window went in live, and where every job's inventory lives.
Supabase does not back it up on this plan. Until 2026-09-05 the only copy that
had ever been taken was made by hand on 2026-07-29 and committed into this
public repository, and it was five weeks stale before anyone noticed.

This page is what runs now, where the copies go, what proves they are good, and
the one thing only the owner can do.

## What runs, and when

| What | When | Workflow |
| --- | --- | --- |
| Copy the database and every stored file | every night, 09:10 UTC (~3am Mountain) | `.github/workflows/backup-nightly.yml` |
| Put a copy back and check it | Sundays, 10:40 UTC | `.github/workflows/restore-test.yml` |

Both can also be run by hand: **Actions → the workflow → Run workflow**. Neither
can be triggered by a pull request, and neither ever writes to production.

## What one night's copy contains

One dated `.tar.gz`:

| File | What it is |
| --- | --- |
| `roles.sql` | the database roles |
| `schema.sql` | every table, view, function, policy and extension |
| `data.sql` | every row, as `COPY` statements — including Supabase's own `auth` and `storage` tables |
| `storage/` | the actual bytes of every object in every bucket |
| `storage-manifest.json` | bucket, path, size, etag and checksum per file |
| `MANIFEST.json` | row counts taken at dump time, three spot-row hashes, the git commit, the timestamps |

`MANIFEST.json` is the point. A dump file proves the tool ran; it does not prove
the dump holds the rows the database held. A `pg_dump` that stopped halfway
still writes a file, still exits 0, and still packs into an archive of a
plausible size. Counting the rows at the moment of the dump, and insisting on
the same counts after a restore, is what turns "we have a file" into "we have
the company".

The nightly downloads every stored file, every night. The script can resume — a
second run into the same folder re-uses bytes whose etag has not changed, which
is what makes re-running it on a laptop quick — but a GitHub runner starts empty
every night, so in CI it never resumes. That is fine at this size and worth
knowing before anyone sizes the job around it.

If the copy cannot fetch every file, the nightly **fails** and Slack says so.
That includes hitting its 2 GiB ceiling: an incomplete backup is reported as a
problem rather than as a green night with a note on a page nobody opens.

## How sensitive the archive is

As sensitive as the database. `data.sql` is dumped with `--schema '*'` and
`auth` is not one of the schemas Supabase's dump tool excludes, so every
archive holds `auth.users`: the crew's email addresses and their bcrypt
password hashes, alongside their hours and the builders' plans.

Nothing here is a reason not to take the backup — it is the reason the bucket is
private, the reason no archive is ever uploaded as a workflow artifact on this
public repository, and the reason a copy pulled onto a laptop belongs on an
encrypted disk and gets deleted afterwards.

## Where the copies go

**Off-site, to Backblaze B2**, when three repository secrets are set:
`B2_KEY_ID`, `B2_APPLICATION_KEY` and `B2_BUCKET`. The archive lands under
`YYYY/MM/DD/` and the job summary says so.

**Nowhere, when they are not set.** The nightly still runs, still proves a good
copy can be taken, and says in one sentence every morning that nothing left the
runner. That is deliberate, and it is the one place where the obvious thing is
wrong: **workflow artifacts on a public repository can be downloaded by
anyone.** Uploading the archive as an artifact would publish every crew member's
hours and every builder's plans nightly — a worse leak than the committed
backups this same change removed. So the fallback is to make no copy rather than
a public one.

### Setting up Backblaze — about half an hour, once

Backblaze B2's free tier covers 10 GB of storage, which is far more than this
project needs, and the paid rate beyond it is a few dollars a month.

1. Create an account at <https://www.backblaze.com/sign-up/cloud-storage>.
2. **Buckets → Create a Bucket.** Give it a name — `forge-windows-backups` is a
   reasonable one, and bucket names are globally unique so you may need a
   suffix. Set **Files in Bucket** to **Private**. Leave encryption and object
   lock at their defaults.
3. **Lifecycle Settings** on that bucket → **Keep only the last version of the
   file**, and set "Keep prior versions for this many days" to **30**. Without a
   lifecycle rule the bucket grows forever and nothing here deletes anything.
4. **Application Keys → Add a New Application Key.**
   - Name it something you will recognise in a year, e.g. `github-nightly-backup`.
   - **Allow access to Bucket:** the bucket you just made, not "All".
   - **Type of Access:** Read and Write.
   - Leave the file-name prefix and duration empty.
   - Press Create. The `keyID` and `applicationKey` are shown **once**. Copy
     both now.
5. In this repository: **Settings → Secrets and variables → Actions → New
   repository secret**, three times:
   - `B2_KEY_ID` — the keyID from step 4
   - `B2_APPLICATION_KEY` — the applicationKey from step 4
   - `B2_BUCKET` — the bucket name from step 2
6. **Actions → Nightly backup → Run workflow.** The summary should end with
   "Copied off-site to ...". Then open the bucket in Backblaze and check the
   file is really there — a green check is not a backup.

Nothing else needs changing. Both workflows notice the secrets on their own, and
the restore test starts testing the stored archive instead of a fresh dump.

## What the restore test proves

Every Sunday, `restore-test.yml` takes the newest archive, starts a throwaway
Postgres **inside the CI runner** — never Supabase — of the same major version
the dump came from, replays roles, schema and data into it, and then asks
`scripts/restore_verify.py` three questions:

1. **Row counts.** Does every table hold exactly the number of rows
   `MANIFEST.json` recorded? This is the check that catches a truncated dump,
   which is otherwise indistinguishable from a good one.
2. **Functions and policies.** Is every function and every row-level-security
   policy the schema dump declares actually present? Losing a policy is the
   dangerous one: all the rows are there, and every installer can suddenly read
   everyone else's pay.
3. **Three spot rows**, looked up by the ids the manifest wrote down and
   compared by hash. Counts cannot tell you the rows came back with the right
   bytes in them.

Any mismatch fails the workflow and posts the reason to Slack. A pass is
recorded in the job summary rather than posted, because a channel that gets a
routine green message every week is a channel people stop reading.

The image is `supabase/postgres`, not stock Postgres, because the schema dump
creates extensions — pg_cron, pg_net, pgsodium — that stock Postgres has never
heard of. The tag is chosen from `postgres_version` in `MANIFEST.json`, which
the nightly asks the live database for; the pinned tags are
`supabase/postgres:15.14.1.168` and
`supabase/postgres:17.6.1.168`, in the workflow's `env:` block. A dump from any
other major version fails the job loudly rather than restoring into the wrong
one.

## Putting it back for real

[`scripts/restore.md`](../scripts/restore.md) is the page for the day production
is gone: where the archive is, how to make a new project, how to replay the
database and the files, the five places that have to be re-pointed, and why
everyone has to be re-invited afterwards. Read it before you need it.

## Backups are never committed

`docs/backups/` and `backups/` are both in `.gitignore`, and the backup scripts
default to writing under `backups/`.

That folder used to hold twenty-seven real files in this public repository: ten
production database dumps (six of them carrying real crew email addresses), two
summary notes, thirteen builder planset PDFs across two projects, a crew
member's handwritten signature as a PNG, and the signed safety record it came
from. They were removed on 2026-09-05. They are gone from the repository going forward, but
anyone who cloned before that date still has them, so the removal is a stop to
the bleeding rather than an undo.

Older documents in `docs/` still quote paths like
`docs/backups/2026-07-29T1200Z-…-full.json`. Those were real files on the day
those documents were written, and the documents are records of what happened;
the paths are not live and are deliberately left as written rather than
rewritten to look like the files never existed.

One of those dumps was load-bearing: `scripts/test_supabase_merge.py` and CI's
merge dry run are built on it. It lives on as
`scripts/fixtures/merge-sample-project.json`, with the crew's names replaced by
placeholders.

### The browser specs that need a real drawing

Twelve tests across six spec files open the real architectural sheet, and none
of them can use a placeholder: which pages are floor plans is decided by reading
the PDF, so a stub would open PECAN14 on a page with no marks and the screenshot
would be an empty building that still passed.

| Spec | What it measures |
| --- | --- |
| `job-map.spec.ts` | is the map readable at 390px (3 jobs) |
| `pin-accuracy.spec.ts` | does a dot land on the callout it belongs to (3 jobs) |
| `data-off.spec.ts` | a data-off unit marked on the real map |
| `vision-placement.spec.ts` | floor-plan-page detection against a real document (2 tests) |
| `studio-plan-underlay-real-trace.spec.ts` | the real trace under the real sheet (2 of its 3 tests) |
| `wave-n-true-north.spec.ts` | setting north in the tracer (1 of its 2 tests) |

On a machine without the sheets they skip themselves and say why, so the nightly
browser-test workflow currently runs about 250 tests and skips these twelve. On
a machine that has them — the owner's clone, and any clone that predates
2026-09-05 — they run exactly as before.

To run them anywhere, put a nightly backup's plansets where they look:

```bash
# from the repository root, with an archive unpacked into ./restore
mkdir -p backups/latest
cp -R restore/storage backups/latest/storage
npm --prefix app run e2e
```

`backups/` is ignored, so nothing you put there can be committed.

## What is still missing

- **Point-in-time recovery.** There is none. Supabase Pro adds daily copies
  taken by the platform itself, which would sit behind this one and cover the
  case where GitHub Actions is also having a bad day. For a database that holds
  payroll it is worth the money.
- **Migration history.** Supabase's dump tool skips the `supabase_migrations`
  schema, so a restored project has the whole schema and no record of how it got
  there. `scripts/restore.md` step 6 has the one command that fixes it; until it
  is run, the next backend deploy would try to re-apply every migration.
- **Anything done since last night.** At worst a day's work is lost. The honest
  thing on the day is to say so and have the crew re-enter it.
