# Backups

**These files are from July 2026 and are not the current backup.**

They were taken by hand during the database consolidation (see
`consolidation-runbooks.md`) and stay here because the merge tooling's dry run
in CI and `scripts/test_restore_backup.py` use them as fixtures.

Since September 2026 the backup is the **Backup database** workflow
(`.github/workflows/backup.yml`): a read-only snapshot every night at 09:20
UTC, verified by re-reading it from disk, sealed with `BACKUP_PASSPHRASE`, kept
90 days as a workflow artifact and copied to Cloudflare R2 when those secrets
exist. Nothing newer is ever committed here: this repository is public.

Putting one back: [`../restore-from-backup.md`](../restore-from-backup.md).
