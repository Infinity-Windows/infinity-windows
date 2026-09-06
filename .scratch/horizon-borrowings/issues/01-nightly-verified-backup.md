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

2026-09-05 — Built. `.github/workflows/backup.yml` runs nightly at 09:20 UTC and
on demand: snapshot (SELECT-only, `scripts/backup_project.py`, now writes a
date-stamped `.json.gz` plus `manifest.json` with inner and outer sha256),
verify from disk in a separate step (`--verify-only`), seal
(`scripts/backup-seal.sh`, AES-256 with `BACKUP_PASSPHRASE`), open the seal
again and re-verify, upload 90 days, copy to R2 when its secrets exist, Slack
on failure. Two deviations from the ticket, both because the repo is public:
the artifact is encrypted rather than plain, and the passphrase is a new
required secret (a copy belongs in the password manager, the runbook says
why). The restore path is `docs/restore-from-backup.md` plus
`scripts/restore_backup.py` (`--plan`, `--sql`), proven offline on the
committed July snapshot in `scripts/test_restore_backup.py` — never against
production. `docs/backups/README.md` says the July files are fixtures, not the
backup. Owner actions before the first green run: add `BACKUP_PASSPHRASE`
(and keep a copy), optionally the four R2 secrets.
