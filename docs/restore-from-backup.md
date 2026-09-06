# Restoring the database from a nightly backup

**Read this before the day you need it.** The backup job
(`.github/workflows/backup.yml`) takes a read-only snapshot of production every
night, proves it can be read back, seals it, and keeps it for 90 days as a
workflow artifact (and in Cloudflare R2 once those secrets exist). This page
is how a snapshot becomes a working database again.

Nothing below has been run against production. The generator was proven on the
committed July snapshot (`scripts/test_restore_backup.py`), which is what a
restore file looks like without the risk of applying one.

## What a snapshot holds, and what it does not

| Held | Not held, and what that means |
|---|---|
| Every row of every table, in one JSON file | **Password hashes.** Every login must reset their password or sign in through their provider again. |
| Credential columns blanked to `[REDACTED-CREDENTIAL]` (PIN hashes, push keys) | **Device PINs.** Every installer sets a new PIN on first open. |
| Schema: columns, constraints, indexes, policies, functions, triggers, enums | **Storage bytes** (photos, plansets, receipts). The inventory lists every object by name and size; the bytes live in the bucket. `scripts/backup_storage_objects.py` can capture them separately and is not part of the nightly job. |
| Auth roster: emails, phones, roles, sign-in dates | **Edge function secrets.** Names only. `deploy-backend.yml` pushes them again from GitHub secrets on the next merge. |
| Applied migration history | |

## 1. Get the file

1. GitHub → Actions → **Backup database** → the newest green run → Artifacts →
   download `db-backup-<date>`. Unzip it; you have `manifest.json.enc` and
   `<stamp>-czprjcskmzzagdztqonm-full.json.gz.enc`.
2. Open the seal. The passphrase is the `BACKUP_PASSPHRASE` repository secret;
   a copy is in the owner's password manager under the same name.

   ```bash
   BACKUP_PASSPHRASE='…' scripts/backup-seal.sh open db-backup-2026-09-06 plain
   python3 scripts/backup_project.py --verify-only plain
   ```

   `backup OK` means the hashes match and the row totals add up. Anything
   else: pick the previous night's artifact and try again.

## 2. Decide what you are restoring into

- **A few rows or one table** (someone deleted the wrong thing): skip to
  step 4, generate the SQL, and copy out only the statements you need.
- **The whole project** (the project is gone or unusable): create a new
  Supabase project, point a checkout of this repo at it in `supabase/config`,
  and apply the schema first:

  ```bash
  supabase link --project-ref <new-ref>
  supabase db push
  ```

  The snapshot's `_migrations` list says which migrations were applied when it
  was taken; the repo at the matching commit is the schema to push.

## 3. See the plan

```bash
python3 scripts/restore_backup.py --plan plain/<stamp>-czprjcskmzzagdztqonm-full.json.gz
```

It prints the tables in an order that satisfies the foreign keys, the row
count of each, the credential columns that come back blanked, and the three
things that need a person (passwords, storage bytes, function secrets).

## 4. Generate and apply the SQL

```bash
python3 scripts/restore_backup.py --sql plain/<stamp>-czprjcskmzzagdztqonm-full.json.gz --out restore.sql
```

`restore.sql` is one transaction: every table's user triggers off, the inserts
in dependency order with every value cast to its recorded type, triggers back
on, `commit`. Read the top of it. Then, with the database password from the
Supabase dashboard:

```bash
psql "postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f restore.sql
```

If it stops, nothing was written; fix the cause and run it again. The usual
causes are a schema that does not match the snapshot (push the right commit's
migrations first) and a table in a foreign-key cycle, which the file lists at
the bottom and which needs its constraints deferred by hand.

## 5. After the rows are back

1. Push the function secrets and functions: re-run **Deploy backend** by hand.
2. Tell every login to reset their password (Sign in → Forgot password) and
   every installer to set a new PIN.
3. Storage: copy the buckets from the old project if it still exists, or from
   a `backup_storage_objects.py` capture if one was taken.
4. Run the production invariant checks (`verify-warehouse.yml` by hand) and
   open the app as the test installer.
5. Take a fresh backup: **Backup database** → Run workflow.

## Where the older copies are

`docs/backups/` holds the July 2026 snapshots taken by hand during the
database consolidation. They are the fixtures the merge tooling's dry run and
`test_restore_backup.py` use, and they stay. Everything newer is an artifact of
the backup workflow, never a file in this repository.
