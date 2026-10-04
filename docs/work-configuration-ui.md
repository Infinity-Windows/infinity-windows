# Work configuration screens

Settings now presents company activities, proposals, published history and capture menus to the real signed-in owner or supervisor. Supervisors save proposals; owners can publish or retire immutable versions. English and Spanish labels are stored with each version. Fields support text, numbers with units/bounds, Boolean values and single/multiple selections. Menu composition pins published activity version IDs and preserves ordering and enabled flags.

An editor retains the draft revision and latest publication version from when it was opened. If a refreshed catalog advances either value, the user must reload the editor before another command. Publishing uses the explicit edited body, with an optional future effective timestamp. Existing frozen selections and historical versions are never automatically replaced.

The job overview provides published menu choices to the exact authority accepted by the selection command: owner/supervisor on a visible job, or an active foreman with that job's menu_select grant. A new permission-first stable read returns only eligible labels and the job's current selection revision. It retains a now-ineligible selection's pointer for the next CAS; it never returns drafts, grants, company field bodies or other-job pointers. Missing authority is an error, not an empty catalog.

Owners/supervisors can grant or revoke menu_select, dimensions_edit and final_qc for the selected job. The existing active-foreman roster supplies picker names; server predicates decide current actor, recipient, visibility and QA eligibility after the configuration lock. Revocation sends the exact active grant ID and cannot revoke a replacement grant silently. A permission does not verify dimensions or accept QC.

## Requests and private data

Reads and commands run online with the checked token and sign-in generation. Preview suppresses management controls. Private queries use separate nonpersisted keys with zero stale/retention time and are removed on panel/account/project changes. Offline panels hide private snapshots; durable clock/photo queues are untouched.

Commands execute directly, without TanStack mutation persistence or automatic retries. A generation-scoped RAM controller freezes the original request UUID and payload, preserves it across ordinary navigation and preview for the same account, and blocks duplicate in-flight/new logical requests. Unknown results remain unresolved even if a later attempt returns a SQL refusal: only a validated receipt resolves an earlier uncertain command. An initial confirmed transactional refusal permits a fresh read and new confirmation. Pending requests never dispatch themselves.

Account changes erase earlier private intent. While any request is unresolved, the browser receives a beforeunload confirmation request to prevent accidental abandonment. Memory does not survive a forced browser exit/reload or a sign-in change; this is not a durable field outbox. Keep the sign-in open and use the explicit same-request retry until resolved.

## Validation boundary

Focused tests cover immutable retries, unknown then refused then receipt, duplicate attempts, navigation/preview/account boundaries, stale forms, exact grant revocation and private query registration. Chromium fixtures cover real typing/focus, 320/390 portrait and landscape layouts, supervisor publishing restrictions and offline privacy. The actual migrated chooser has separate disposable SQL checks. Hosted WebKit, actual-schema rollback and protected release/deployment checks are required for the final candidate. These screens do not activate a personal activity dispatcher, payroll changes, independent dimension verification or QC acceptance.
