# Getting the app back when production is gone

This is the page for the worst day. It assumes the Supabase project is gone,
corrupted, locked or billing-suspended, that the crew cannot clock in, and that
you are the person fixing it.

Read the whole page once before typing anything. Nothing here writes to the old
project, and none of it is reversible in a hurry.

**The one thing to check first:** is the project really gone, or is it paused?
A paused project restores from the Supabase dashboard in about a minute and
loses nothing. Sign in at <https://supabase.com/dashboard>, open the project
`czprjcskmzzagdztqonm`, and look for a "Restore project" button. If it is there,
press it and stop reading.

---

## What you have

The "Nightly backup" workflow runs at 09:10 UTC (about 3am Mountain) and writes
one dated `.tar.gz` holding everything:

| Inside the archive | What it is |
| --- | --- |
| `roles.sql` | the database roles |
| `schema.sql` | every table, view, function, policy and extension |
| `data.sql` | every row, as `COPY` statements — including Supabase's own `auth` and `storage` tables |
| `storage/` | the actual bytes of every uploaded file |
| `storage-manifest.json` | one line per file: bucket, path, size, checksum |
| `MANIFEST.json` | the row count of every table, taken at the moment of the dump |

**Treat this archive like the database itself.** `data.sql` is dumped with
`--schema '*'`, and `auth` is not one of the schemas Supabase's dump tool
excludes, so the file holds `auth.users` — every crew member's email and their
bcrypt password hash — as well as the `storage` tables. That is good news for
the restore (see Step 7) and it is the reason the B2 bucket must be private, the
reason nothing is ever uploaded as a workflow artifact on this public
repository, and the reason a copy on a laptop belongs on an encrypted disk.

**Where the archive is.** In the Backblaze B2 bucket, under `YYYY/MM/DD/`, if
`B2_KEY_ID`, `B2_APPLICATION_KEY` and `B2_BUCKET` are set in the repository's
Actions secrets. If they are not set, **there is no stored copy** — the backup
runs and proves itself every night, but nothing leaves the runner, and this page
cannot help you. Setting those three secrets is the single most valuable
half-hour anyone can spend on this project; `docs/backups.md` says how.

**The file is sealed.** What is in the bucket is `….tar.gz.enc`. Open it first
with the passphrase from the `BACKUP_PASSPHRASE` secret (a copy is in the
owner's password manager), then check it reads back before trusting it:

```bash
BACKUP_PASSPHRASE='…' scripts/backup-seal.sh open czprjcskmzzagdztqonm-<stamp>.tar.gz.enc backup.tar.gz
python3 scripts/backup_verify.py backup.tar.gz
```

`backup OK` from the second command means every dump is the size and hash the
manifest recorded. Anything else: take the previous night's file instead.

**How fresh it is.** At worst one day old. Anything the crew did between the
last backup and the outage is gone, and the honest thing to do is tell them so
and have them re-enter today's work.

---

## Step 1 — Get the archive onto a machine

```bash
# One-time: install rclone (brew install rclone), then
export RCLONE_CONFIG_OFFSITE_TYPE=b2
export RCLONE_CONFIG_OFFSITE_ACCOUNT=<B2_KEY_ID>
export RCLONE_CONFIG_OFFSITE_KEY=<B2_APPLICATION_KEY>

rclone lsf --files-only --recursive offsite:<B2_BUCKET> | sort | tail -5
rclone copyto "offsite:<B2_BUCKET>/2026/09/05/czprjcskmzzagdztqonm-2026-09-05T0910Z.tar.gz" ./backup.tar.gz

mkdir restore && tar -xzf backup.tar.gz -C restore --strip-components=1
cat restore/MANIFEST.json | head -40
```

`MANIFEST.json` tells you the date, the git commit the app was on, the Postgres
version, and how many rows every table had. Keep it open; it is what you check
the restore against at the end.

## Step 2 — Create a new Supabase project

In the dashboard: **New project**, same organisation.

- **Region:** the same one the old project was in, so the app is not suddenly
  slower for every phone in the field.
- **Postgres version:** the same MAJOR version as `postgres_version` in
  `MANIFEST.json`. A 15 dump into a 17 project mostly works and is not the same
  database.
- **Database password:** generate a new one and put it straight into a password
  manager. You will need it three times today.

Write down the new project ref (the `abcdefgh…` in the dashboard URL). Every
step below calls it `<NEW_REF>`.

## Step 3 — Put the database back

```bash
# The connection string is on the dashboard: Project Settings > Database.
export PGURL='postgresql://postgres:<NEW_PASSWORD>@db.<NEW_REF>.supabase.co:5432/postgres'

psql "$PGURL" -f restore/roles.sql      # "already exists" errors here are normal
psql "$PGURL" -f restore/schema.sql     # so are these, for extensions
psql "$PGURL" -v ON_ERROR_STOP=1 -f restore/data.sql
```

Errors while applying `roles.sql` and `schema.sql` are expected: a new Supabase
project already has the roles and most of the extensions the dump recreates.
Errors while applying `data.sql` are NOT expected — that is why it runs with
`ON_ERROR_STOP=1`.

## Step 4 — Prove it worked before you tell anyone it worked

```bash
scripts/restore_verify.py --backup restore --db-url "$PGURL"
```

This is the same check the weekly "Restore test" workflow runs. It compares
every table's row count against `MANIFEST.json`, confirms every function and
every row-level-security policy the dump declares is present, and re-checks
three individual rows by hash.

**Do not skip this and do not skip past a failure.** A restore that is missing a
policy has every row in place and shows every installer everyone else's pay.

## Step 5 — Put the files back

```bash
# Storage objects go back bucket by bucket. Create the buckets first, in the
# dashboard (Storage > New bucket), with the same names and the same
# public/private setting as before. `storage-manifest.json` lists exactly
# which buckets existed on the night of the backup — read it rather than
# working from memory; new ones get added as features ship.
export SUPABASE_SERVICE_ROLE_KEY=<the new project's service key>

for f in $(cd restore/storage && find . -type f); do
  bucket="$(echo "${f#./}" | cut -d/ -f1)"
  path="$(echo "${f#./}" | cut -d/ -f2-)"
  curl -sS -X POST "https://<NEW_REF>.supabase.co/storage/v1/object/$bucket/$path" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    --data-binary "@restore/storage/${f#./}" >/dev/null || echo "FAILED $f"
done
```

Then check the count against `storage-manifest.json`:

```bash
find restore/storage -type f | wc -l
python3 -c "import json;print(json.load(open('restore/storage-manifest.json'))['object_count'])"
```

## Step 6 — Point everything at the new project

Six places, and missing one of them is the usual way a restore looks broken:

1. **Repository secrets** (Settings → Secrets and variables → Actions):
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `SUPABASE_DB_PASSWORD`.
2. **`SUPABASE_PROJECT_REF`** in `.github/workflows/deploy-backend.yml`,
   `backup-nightly.yml` and `restore-test.yml` — it is an `env:` line in each.
3. **`app/.env.example`** and the README, so the next person's `cp .env.example
   .env` is not pointed at a dead project.
4. **Edge function secrets.** Run the "Deploy backend" workflow; it pushes the
   function secrets from the repository's secrets and tells you what is missing.
5. **Redeploy the frontend** — merge anything, or run "Deploy GitHub Pages"
   manually.
6. **The migration history.** Supabase's dump tool deliberately skips the
   `supabase_migrations` schema, so the new project has the whole schema and no
   record of how it got there, and the next "Deploy backend" run would try to
   apply all 200-odd migrations to a database that already has them. Tell the
   CLI they are done:

   ```bash
   supabase link --project-ref <NEW_REF>
   supabase migration repair --linked --status applied \
     $(ls supabase/migrations/*.sql | xargs -n1 basename | cut -d_ -f1)
   supabase migration list --linked   # local and remote should now agree
   ```

The app shows a red **"Wrong database"** banner whenever the frontend and the
backend disagree about which project they are talking to. Trust it: if you see
it after a restore, step 6 is not finished.

## Step 7 — The people part

**Logins should come back with the data.** `data.sql` includes `auth.users`,
password hashes and all, so once Step 3 has run, the crew's existing passwords
should still work. Do not tell anyone to expect a new login until you have
checked.

Check it before you announce anything:

```bash
psql "$PGURL" -X -t -c 'select count(*) from auth.users'
```

Compare that against the crew you expect, then sign in as one real person.

If the count is zero, or the `auth` part of `data.sql` errored on the way in —
Supabase's own auth service moves its table shape between versions, and a new
project may not accept an older dump's columns — then fall back to re-inviting.
Everyone's `profiles` row (name, role, skill level, everything the app knows
about them) is restored either way; only the login would be new. Use the Crew
screen to send invites, and tell people plainly: their work is there, their
login is not.

---

## What this does not cover

- **Point-in-time recovery.** There is none on this plan. Supabase Pro adds
  daily copies taken by the platform itself, which would sit behind this one and
  cover the case where GitHub Actions is also having a bad day. It is worth the
  money for a database that holds payroll.
- **A backup that is itself corrupt.** That is what the weekly restore test is
  for: it catches it on a Sunday instead of on the worst day.
