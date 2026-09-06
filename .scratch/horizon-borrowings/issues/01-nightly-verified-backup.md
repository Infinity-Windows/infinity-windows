# 01 — Nightly verified off-site database backup

Status: resolved
Type: task
Size: S

## Horizon does

`.github/workflows/backup.yml` + `scripts/lib/backup.mjs`: 09:20 UTC daily,
dumps every table with the service role, writes a manifest with per-file
hashes, then a SEPARATE step re-reads the files from disk and re-hashes them
("a backup that has never been read back is not a backup"). Uploads as a
GitHub artifact (90 days, no credentials needed) and, when R2/S3 secrets exist,
copies to Cloudflare R2. Skips R2 cleanly when the secrets are missing so the
job stays green and the artifact is still produced.

## Forge today

`scripts/backup_project.py` takes a full read-only snapshot (rows, DDL, auth
roster without hashes, storage inventory, function and secret names, migration
history) via `scripts/mgmt_query.py`. It runs only when someone runs it. The
newest dumps in `docs/backups/` are from 2026-07-29 and are committed to a
public repo. There is no restore script. `scripts/checkpoint.sh` covers git,
not the database.

## Build

1. A workflow `backup.yml`, schedule daily ~09:20 UTC (after `vault-sync` at
   08:00 and `verify-warehouse` at 08:10), plus `workflow_dispatch`.
   Runs `backup_project.py czprjcskmzzagdztqonm backup-out` with the existing
   management token secret, then a second step that re-reads and re-hashes
   `backup-out/` (add a `--verify-only` mode to the script, mirror Horizon's
   manifest idea). Upload as artifact, retention 90 days.
2. Optional durable copy: if `R2_*` (or generic S3) secrets are present, copy
   the bundle there; otherwise print a notice and stay green. Document the
   secret names in the workflow header the way `deploy-backend.yml` does.
3. On failure, reuse `notify-failure.yml` so Slack hears about it.
4. Stop committing dumps to `docs/backups/`: add a README there saying where
   backups live now. Do NOT delete the existing July files without the owner.
5. Restore path: a `scripts/restore-notes.md` (or section in
   `docs/consolidation-runbooks.md`) that says, step by step, how a dump from
   this job is put back. Prove the notes on the committed July dump against a
   scratch project or a dry run — never against the real project.
6. Tests: `scripts/backup_project.test.py` (stdlib-only, offline, like the
   other script tests) for the verify-only mode, and a line in `ci.yml` so
   `ci-runs-script-tests.test.mjs` keeps counting it.

## Done when

- A manual `workflow_dispatch` run produces an artifact whose manifest hashes
  match on re-read, and the run summary shows table count and size.
- A deliberately corrupted file makes the verify step fail (proven in the
  script test, not against production).
- The next nightly run is green without anyone touching it.

## Comments

2026-09-06 — Resolved in two parts. The build session was given the same
item by the owner and landed the larger half as #557 (`backup-nightly.yml`:
Supabase CLI dumps + every stored file, `MANIFEST.json` with row counts and
hashes, off-site to Backblaze B2 via rclone, a Sunday `restore-test.yml`
that restores into a real Postgres and checks row counts, `docs/backups`
removed from the public repo). My draft #545 was closed. This follow-up adds
the two things #557 lacked: `scripts/backup_verify.py` — a fresh unpack and
re-hash of every dump and stored file against the manifest, run between
packaging and upload and again by the restore test on the copy actually
kept — and `scripts/backup-seal.sh`, AES-256 under `BACKUP_PASSPHRASE`,
sealed → opened → re-verified before upload; the upload REFUSES plaintext
when the passphrase is missing. Dropped from the draft: the JSON-snapshot
SQL generator (the restore is a psql replay of the dumps) and the GitHub
artifact fallback (public repo; #557's reasoning stands). Owner actions:
the three B2 secrets (nothing leaves the runner until then), then one manual
run.
