# Role-specific app updates

Status: release candidate; verify deployment before describing as live.

After a new installed build loads, a dismissible “What’s new in Forge” popup shows unread improvements for the signed-in person's role, with descriptions already expanded. If no new notes apply, it says “Different Role Update” without revealing other roles' feature details. Normal refreshes of an acknowledged version do not show it again. Settings retains the role-filtered history.

“Got it”, Escape, tapping outside, or following a feature/history link acknowledges the installed build and visible note IDs for that account on this device. The receipt survives refreshes and route navigation. A newer compiled build ID produces a new notice. Clearing storage or changing devices shows it again. Role preview never dismisses the real user's notice. If the release feed cannot load, normal work remains available; reconnecting retries and Settings shows the error. An authorization check distinguishes an empty role feed from partner, retired or revoked accounts, which receive no popup.

## Audience and rollout

Each announcement lists exact numeric audiences: installer 0, foreman 1, supervisor 2, owner 3. Include every role to which the change applies; a higher rank does not automatically inherit installer-only training notes. Legacy lead/admin/big_boss aliases follow existing role ranks. Partners receive no internal announcements in this first release.

The database enforces role, partner, retirement and access-revocation restrictions on every read, including direct API requests. Crew accounts cannot write announcements. The UI narrows returned rows again for role preview and ignores unknown roles. The feed is not saved in the offline query cache. A failure to read announcements never blocks normal app use.

The frontend also accepts only IDs in `INCLUDED_UPDATE_IDS`. Therefore a backend-first deployment cannot tell an older phone that a new feature is already on that phone. Withdrawing a note removes it from subsequent reads. Every changed announcement needing renewed attention gets a new ID; editing an old ID does not reset a dismissal.

## Include notes in each future release

1. Write short English and Spanish titles and descriptions explaining what changed for a person. Use no payroll figures, names, secrets, or internal implementation details.
2. Choose explicit audience ranks. Split shared crew improvements from supervisor-only controls into separate announcements.
3. Add rows in a new, uniquely numbered database migration and append their IDs to `INCLUDED_UPDATE_IDS` in the same change. Use the actual publication day; future dates remain hidden. Optional links must be simple internal app paths.
4. Keep prior IDs in the manifest for Settings history. Do not announce draft PRs or unverified fixes as shipped. Every deployed build can trigger a notice; a build with no new applicable note uses the generic Different Role Update message.
5. Verify installer, foreman, supervisor/owner and preview behavior; deploy the migration and frontend through the existing release process. A refresh loads the notes belonging to the installed build.

The initial catch-up describes the previously merged photo, voice, leave and reporting improvements. It deliberately omits unshipped AI job-creation/schedule-publication work.

## Verification

- Actual migration exercised in disposable PostgreSQL under installer, foreman, supervisor, owner, partner, revoked, retired and anonymous callers; read-only grants, off-site access, hidden future/withdrawn notes verified.
- Pure tests cover explicit audiences, unknown/legacy roles, current-build filtering, corrupt receipts, per-account dismissal and internal-only links.
- Browser fixtures cover reload/dismiss/new announcement behavior, Settings history, owner role preview, Spanish on a dark 375px phone, desktop, keyboard, and a missing database table.
- Production role checks and physical iPhone Safari remain release validation, not implied by local fixtures.

## Ask display formatting

Ask displays replies as plain text, removing paired Markdown emphasis, heading markers and code fences while preserving names, values and link destinations. User messages and structured report exports are unchanged. The original response remains available to follow-up context. Rendering stays React text; no HTML execution or new Markdown dependency is introduced.
