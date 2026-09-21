# Role-specific app updates

Status: implemented for review, not deployed.

After signing in or refreshing, an in-page “What’s new in Forge” card lists unread improvements applicable to that person's current role. Titles stay short; tapping a title expands the explanation and a link to the feature when appropriate. Nothing blocks the time clock, opens a modal, forces a refresh, or changes an ongoing capture. Settings contains a full history of announcements included in the installed build for that role.

“Got it” remembers only those visible announcement IDs, separately for each account on that device. It persists through refreshes, and new IDs appear on the next refresh. Clearing browser storage or using another device shows them again. Storage failures still allow dismissal for the session. No personal read-history table is added to the database. Role preview does not permanently dismiss the real user's updates.

## Audience and rollout

Each announcement lists exact numeric audiences: installer 0, foreman 1, supervisor 2, owner 3. Include every role to which the change applies; a higher rank does not automatically inherit installer-only training notes. Legacy lead/admin/big_boss aliases follow existing role ranks. Partners receive no internal announcements in this first release.

The database enforces role, partner, retirement and access-revocation restrictions on every read, including direct API requests. Crew accounts cannot write announcements. The UI narrows returned rows again for role preview and ignores unknown roles. The feed is not saved in the offline query cache. A failure to read announcements never blocks normal app use.

The frontend also accepts only IDs in `INCLUDED_UPDATE_IDS`. Therefore a backend-first deployment cannot tell an older phone that a new feature is already on that phone. Withdrawing a note removes it from subsequent reads. Every changed announcement needing renewed attention gets a new ID; editing an old ID does not reset a dismissal.

## Include notes in each future release

1. Write short English and Spanish titles and descriptions explaining what changed for a person. Use no payroll figures, names, secrets, or internal implementation details.
2. Choose explicit audience ranks. Split shared crew improvements from supervisor-only controls into separate announcements.
3. Add rows in a new, uniquely numbered database migration and append their IDs to `INCLUDED_UPDATE_IDS` in the same change. Use the actual publication day; future dates remain hidden. Optional links must be simple internal app paths.
4. Keep prior IDs in the manifest for Settings history. Do not announce draft PRs or unverified fixes as shipped. Infrastructure-only releases need no announcement.
5. Verify installer, foreman, supervisor/owner and preview behavior; deploy the migration and frontend through the existing release process. A refresh loads the notes belonging to the installed build.

The initial catch-up describes the previously merged photo, voice, leave and reporting improvements. It deliberately omits unshipped AI job-creation/schedule-publication work.

## Verification

- Actual migration exercised in disposable PostgreSQL under installer, foreman, supervisor, owner, partner, revoked, retired and anonymous callers; read-only grants, off-site access, hidden future/withdrawn notes verified.
- Pure tests cover explicit audiences, unknown/legacy roles, current-build filtering, corrupt receipts, per-account dismissal and internal-only links.
- Browser fixtures cover reload/dismiss/new announcement behavior, Settings history, owner role preview, Spanish on a dark 375px phone, desktop, keyboard, and a missing database table.
- Production role checks and physical iPhone Safari remain release validation, not implied by local fixtures.
