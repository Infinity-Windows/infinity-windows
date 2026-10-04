# Activity role acceptance — release held

The source-matched application fixture now has a separate PostgreSQL 17 role
acceptance job. Its purpose is to prevent a superuser test account from hiding
missing privileges or an incorrect caller identity. It does not claim that stock
PostgreSQL reproduces Supabase's native library hooks.

The evidence is the installed role metadata captured by the coordinator in a
forced rollback: workflow 37198783399, job 111426024453. Its original encoded
payload SHA-256 is `6ff049f469e44ffc9f8bfd899ee9f7df780c40f9ec049f3e62ed294c9ceb3913`.
The checked-in formatted metadata file is independently pinned in the harness.
It contains role names/attributes, grant paths, privileges and safe configuration
values; it contains no employee rows or passwords.

The harness requires a fresh, exact-name `forge_work_activity_role_test` database
on localhost port 5432, initialized with the separate
`forge_fixture_bootstrap` superuser. That role imports the immutable application
schema and prepares the installed roles. The actual cutover DDL runs through a
new `postgres` login with the installed NOSUPERUSER, BYPASSRLS, CREATEROLE,
CREATEDB and REPLICATION attributes. It is never temporarily made superuser.
Application calls connect as `authenticator`, then use its actual SET ROLE path
to authenticated or service_role. Changing roles inside a bootstrap connection
would not prove the same authority, because PostgreSQL checks SET ROLE against
the session login's memberships.

Acceptance compares all 15 role attribute records, 15 exact membership edges
including grantor/admin/inherit/set options, 105 transitive permission results,
and seven database/schema privilege sets. The original 221-entry source guard
must pass before the whole cutover installs as its real source owner. Calls then
exercise private context refusals, a forged custom role claim, schema creation
refusal, supported service-role maintenance, SECURITY DEFINER role-switch denial
and an explicit fixture-only SECURITY INVOKER escalation control. The control
shows why source closure must exclude arbitrary role-switching invoker routines;
it is never included in a migration. The actual twelve-argument paid clock,
snapshot-confirmed setup, break/end/out and empty execution-context cleanup run
through the authenticator login.

## Exact limitations

The installed authenticator setting is `session_preload_libraries = 'supautils,
safeupdate'` (separate forced-rollback workflow 37199267567, job 111427414059).
Those libraries are not installed or imitated in this stock PG17 fixture.
Upstream safeupdate has a post-parse hook that rejects UPDATE/DELETE without a
WHERE clause. Upstream supautils adds privileged utility/role operations,
event-trigger dispatch controls and executor permission hints. Therefore matching
SQL role rows is not proof of matching the installed provider hooks. The observed
library names do not identify their installed source revision or binary hash.
See the primary sources:
[safeupdate source](https://github.com/eradman/pg-safeupdate/blob/master/safeupdate.c),
[supautils hook source](https://github.com/supabase/supautils/blob/master/src/supautils.c)
and [privileged-role source](https://github.com/supabase/supautils/blob/master/src/privileged_role.c).
These are upstream source observations, not claims about the exact installed binary.

Provider log_statement settings are known to be `none`. The custom database
`app.settings.jwt_exp` value remains withheld; no application migration or
source-matched function references that setting. JWT verification, PostgREST
transport and provider account-management internals remain external boundaries.
The separate vector/provider schema exclusions remain documented in the schema
fixture report. The fixture's auth.uid/role/jwt functions only read synthetic
claims. Production runtime authentication must still validate those claims.

A plain PG17 pass will establish actual-login role/ACL acceptance for the
application. Full provider-hook equivalence requires a corresponding Supabase
runtime or narrowly reviewed provider-side acceptance; it must not be inferred
from this job. Neither this fixture nor its metadata probe activates capture.
The SQL assembly refusal and final ROLLBACK remain unchanged.

## Local validation and independent gates

`python3 scripts/verify-work-activity-engine-role-parity.py --check-plan` validates
the pinned metadata, source hashes, role DDL plan and explicit exclusions without
connecting to a database. Python compilation and URL refusal checks are also
local. PGlite rejects changing its built-in postgres role with SQLSTATE 0A000;
that limitation is preserved rather than replacing real-login proof with an
invented account. Actual PostgreSQL execution is a separate CI gate.

The earlier module-path correction passed all 30 sequential runtime checks via
an absolute PGlite path, file URL and installed-package resolution. The matching
schema and cutover exports each round-tripped in a fresh PGlite. The coordinator
reported real PG17 source-matched acceptance at 36f: 30 sequential checks and
18 concurrent scenarios with 17 observed blocking edges. That older job used
a superuser bootstrap and does not substitute for the new role-login job.
