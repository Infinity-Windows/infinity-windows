# Time entries: export and controlled historical import

The detailed export is available in **Team timecards → Export time entries** and in a person's **Export → Export time entries** menu. Select inclusive calendar dates and, for a team export, employees. Dates use the displayed browser time zone and filter by shift start, consistent with the existing timecards.

- CSV uses the supplied BusyBusy entry columns, followed by Status and Time Zone. It includes start/end, breaks, net time, job, cost code and descriptions. Separate employee CSVs download together as a ZIP.
- Forge preview opens a printable report; use Print / Save PDF in the browser. The output schema and printable report use English; the selection dialog supports English/Spanish.
- Only finished, non-removed entries are exported. Unfinished entries are counted in a warning. Submitted and rejected entries retain their status; export is not approval. This report does not infer overtime from an arbitrary partial week. Existing payroll/summary exports remain available.
- Reads paginate to the exact server count and fail on incomplete/changed results. Personal exports filter by profile on every page. Existing server permissions still apply.

## Import controls

`source_import` stores the original CSV row, file, row number, time zone and overlap reconciliation evidence. `source_import_key` uniquely identifies an imported fragment. Normal timecard corrections and job assignment edit the working shift, while a database trigger preserves the original evidence. This adds no client import permission. Historical imports skip the clock-in unit-session cleanup; ordinary clock-ins retain it.

`scripts/time_entry_import.py prepare` is local-only. It validates source totals against elapsed time minus breaks, limits requested dates, requires explicitly confirmed employee/project/time-zone mapping, rejects source overlaps, and compares source intervals to existing Forge punches. Existing punches are left unchanged. Only uncovered source intervals are imported, preserving fractional-second boundaries. Ambiguous overlapping break deductions stop for review; breaks are never invented or deducted twice. All new punches are submitted for normal weekly approval. Unknown source jobs may be mapped to null; their original names remain visible on the timecard and export until assignment.

Keep source files, live audit, mapping, plan and receipts **outside the repository** in a restricted local folder. They must never be attached to a public PR, workflow artifact or log. Private-file extensions are ignored as a second precaution. A mapping contains `confirmed`, `employees` (full source name → profile UUID), `projects` (source job → project UUID or null), `cost_codes` (source code → cost UUID), and optional `create_cost_codes` with id/code/label. New historical codes are inactive so imported classifications are retained without changing the clock-in menu.

```
python3 scripts/time_entry_import.py prepare \
  --sources /private/source-folder --evidence /private/forge-before.private.json \
  --mapping /private/mapping.private.json --output /private/reviewed \
  --from-date YYYY-MM-DD --through-date YYYY-MM-DD --time-zone America/Denver
```

Independently reconcile the private receipt per employee/day and verify all employee aliases and similar project matches with the user. Refresh the live read before preparing the final batch. Preparation prints only its SHA256. Load `import-payload.private.txt` into the temporary encrypted repository secret `FORGE_TIME_IMPORT_PAYLOAD` with `gh secret set ... < /private/reviewed/import-payload.private.txt`. Never paste its content into a command line or workflow input.

The **Import reviewed time entries** workflow is manual and master-only. Supply the reviewed SHA256; run with apply=false first, then apply=true after the preview passes and the requested import is authorized. It uses the existing management secret. SQL checks the employee/project/cost mappings and every relevant existing punch under a short write lock before adding anything. Any changed snapshot or overlap fails the whole transaction. Preview rolls back. Apply verifies all saved fields before commit. Exact batch retry is a no-op; partial batches stop for reconciliation. Never disable sandbox guards or use a test user's login to write real payroll.

After apply, read live records again, verify every imported field/source key, compare existing punches, reconcile per-person/day totals and breaks, and retain a private receipt. Remove the temporary encrypted payload secret. If the API response is uncertain, inspect actual saved records before retrying; do not interpret a missing response as rollback.

## Validation

- `python3 scripts/test_time_entry_import.py`: synthetic source parsing, union boundaries, breaks, date filtering, mapping and duplicate checks.
- `PGLITE_MODULE=... node scripts/verify-time-entry-import.mjs`: real generated SQL in disposable PostgreSQL; preview rollback, saved totals, repeated batches, immutable evidence, unchanged timers, stale snapshots and atomic failure.
- `app/src/lib/timeEntryExport.test.ts`: CSV schema, breaks, time zones, overnight/seconds, escaping and source preservation.
- `app/e2e/time-entry-export.spec.ts`: downloads, ZIP contents, dates/people, personal scope, failed reads and phone/desktop English/Spanish. Fixture data only; this is not a production payroll smoke test.
