# The `profiles` table let any installer make themselves the boss

**Plain English:** until today, anybody who could sign into the app could give
themselves the owner's job title. That meant pricing, job costs and everyone's
hours. It is closed now, and closed in a way we tested by actually trying the
attack. Nobody's account or job title changed, and no crew member has to do
anything.

Applied to production (`czprjcskmzzagdztqonm`) on 2026-07-29. Migrations:
`supabase/migrations/20260729200000_profiles_rls_lockdown.sql` and
`supabase/migrations/20260729200100_profiles_pin_hash.sql`.

---

## 1. What was wrong

`public.profiles` had row-level security switched on and exactly **one** policy:

```
policyname: "authenticated full access"   cmd: ALL   qual: true   with_check: true
```

`ALL` with `true` on both sides means every signed-in user had unrestricted
SELECT, INSERT, UPDATE and DELETE on **every** row. On top of that, Supabase's
default grants gave `anon` and `authenticated` every table privilege on every
column — including `TRUNCATE`, which is not subject to row-level security at
all.

### 1a. Privilege escalation — the serious one

A `BEFORE UPDATE` trigger from the 2026-07-18 hardening
(`20260718090000_security_hardening.sql`) did stop a direct
`update profiles set role = 'owner'`. But a trigger on UPDATE does not fire on
DELETE or INSERT, and the blanket policy allowed both. Verified against
production in a rolled-back transaction, as installer Chris:

| Attempt | Result before the fix |
| --- | --- |
| `update profiles set role='owner' where id=auth.uid()` | blocked by the trigger |
| `delete from profiles where id=auth.uid();` then `insert … values(auth.uid(), 'Chris', 'owner')` | **SUCCEEDED — role is now `owner`** |
| read the `pin` column of all five other users | **SUCCEEDED** |
| `update profiles set pin='1234'` on the owner's row | **SUCCEEDED** |
| `delete from profiles where id = <the owner>` | **SUCCEEDED** |
| rename another crew member | **SUCCEEDED** |

Owner rights in this app mean the `/costing` screen, job costs and margins,
everyone's timecards, the admin and access-approval screens, and the AI's
management-only answers (`supabase/functions/ask/index.ts` gates on
`profiles.role`). The delete-then-reinsert route needed no tooling beyond the
app's own Supabase client.

Two further routes were open for anyone who could sign up at all: Supabase email
self-signup is on, and a brand-new account could `INSERT` its own profile row
with `role = 'owner'` directly — the trigger never saw inserts.

### 1b. PIN disclosure

`profiles.pin` stored the crew's 4-digit unlock PIN **in plain text**, readable
and writable by every signed-in user. Production had 6 profiles with
`pin IS NULL` for all of them, so nobody was exposed — but a collaborator's copy
of the database did contain a real plain-text PIN, which is how this was found.
The moment a crew member set a PIN it became readable by anyone logged in.

---

## 2. How profiles are legitimately used (established before changing anything)

Enumerated from the code, not guessed, because getting this wrong locks everyone
out.

**Reads of other people's rows — all of these had to keep working:**

| Where | Columns |
| --- | --- |
| `listProfiles()` — Roster, Team, Dispatch board, Project map, Scheduling, Training, Tools, Timecard, Vehicles, Vehicle detail, Trip editor, chat roster | `id, display_name, skill_level, role, active, created_at, updated_at` |
| Issues, Service, `points.ts` leaderboard | `id, display_name` |
| PostgREST foreign-key embeds: `time_shifts`, `tool_checkouts`, `incidents`, `tools`, `vehicle_drivers`, `trip_crew`, `schedule_assignment_members` | `profiles(display_name)` |
| `costing.ts` labour rates | `profiles(role)` |
| `OPENING_SELECT` assignee | was `assignee:assigned_to(*)` |

An installer needs cross-user reads too — the points leaderboard, "who is
clocked in" on the clock screen, the travel trip editor and the project chat
roster are all installer-reachable. So read access could not be narrowed to
"your own row plus foreman+".

**Writes:**

| Who | What | Path |
| --- | --- | --- |
| any user | their own `display_name` | direct UPDATE from the Roster screen |
| any user | their own PIN | `set_my_pin()` RPC |
| foreman+ | anyone's `display_name`, `skill_level`, `active` | direct UPDATE (`Crew.tsx`, gated on `isForemanPlus`) |
| supervisor+ | anyone's `role` | `set_profile_role()` RPC (`Crew.tsx`, gated on `isSupervisorPlus`) |
| new sign-in | insert their own row | `ensureMyProfile()` |
| founder emails | self-promote to owner on first sign-in | was a direct UPDATE of `role` from the browser |
| nobody | delete a profile | no code path exists |

**Service-role callers, which bypass RLS entirely and had to stay working:**
`vault-config`, `ingest-knowledge` and `ask` all read `profiles.role` on the
service key. Every trigger added below returns early when `auth.uid() is null`,
so migrations, seeds and service-key writes are untouched.

---

## 3. The fix

### Three layers, so no single mistake re-opens it

1. **Column privileges.** Postgres will not let you subtract a column from a
   table-level grant, so the table-level `SELECT`/`INSERT`/`UPDATE` grants were
   dropped and re-granted column by column. `role` is absent from the INSERT and
   UPDATE lists; the PIN is absent from all three. A direct write to `role` now
   fails with `42501` *before* row-level security is consulted, and any column
   added later is unreachable by default.
2. **RLS policies**, per command instead of one blanket `ALL`:

   | Command | Policy |
   | --- | --- |
   | SELECT | `true` — the crew directory (see below for why) |
   | INSERT | `id = auth.uid() or my_role_rank() >= 2` |
   | UPDATE | `id = auth.uid() or my_role_rank() >= 1` |
   | DELETE | `my_role_rank() >= 2` |

   `TRUNCATE` and `TRIGGER` are revoked, and `anon` now holds nothing at all on
   the table.
3. **Triggers.** `guard_profile_role_change` (BEFORE UPDATE) and
   `guard_profile_insert` (BEFORE INSERT). These are the layer that still
   applies when the write arrives through a `SECURITY DEFINER` function, which
   runs as the table owner and therefore bypasses both layers above — and that
   is how every legitimate role change happens.

**Why a trigger rather than column-level RLS**, as asked: RLS in Postgres is
row-level only. A policy cannot express "this UPDATE may touch every column
except `role`". Column `GRANT`s can, and are absolute — but they are static, so
they cannot express "…unless the caller is a supervisor". A trigger can. Hence
both: the grant makes the column unwritable by clients outright, and the trigger
gates the one privileged path that can still write it. Proof step **A16** below
shows the trigger alone still refusing the attack after the column privilege is
handed back by hand.

### Why SELECT stays open to `authenticated`

The task asked to prefer a narrow view. `public.crew_directory`
(`id, display_name, role, skill_level, active`, `security_invoker = true`,
`SELECT` to `authenticated` only) exists and is what new code should read. But
table-level SELECT has to remain, for two reasons that are structural rather
than a matter of taste:

* PostgREST foreign-key embeds — `time_shifts?select=profiles(display_name)` and
  the six others listed above — resolve against the **base table**. A view
  cannot stand in for them, and rewriting seven call sites onto manual joins
  would be a much larger, riskier change than the one being asked for.
* Twelve screens, several of them installer-reachable, read other people's rows.

With the PIN unreachable by grant, what remains readable is a staff directory:
name, job title, skill tier, on-site flag. Step **A9** proves that
`select * from profiles` — the query that would sweep up a future secret
column — now fails outright for a signed-in installer.

### Role ladder helper

`role_rank(text)` mirrors `roleRank()` in `app/src/lib/install/types.ts` exactly,
legacy aliases included (`big_boss`→3, `admin`→2, `lead`→1), so a policy and the
UI can never disagree. Unknown or NULL is the installer floor. `my_role_rank()`
is `SECURITY DEFINER` for one specific reason: a policy on `profiles` that reads
`profiles` recurses infinitely under RLS.

`set_profile_role()` was tightened from "any caller whose role is not literally
`installer`" (which let a **foreman** hand out owner) to supervisor-or-owner,
and now refuses self-promotion above your own rank. Its return type changed from
`profiles` — the whole row, which column grants do not protect because the
function runs as the owner — to a narrow `jsonb`. `api.ts` already ignored the
result.

### The founder bootstrap, made explicit

`ensureMyProfile()` used to promote two hard-coded founder emails to owner by
writing `profiles.role` straight from the browser. With that column revoked it
needs a server-side path, so it is now `claim_owner_bootstrap()` — which reads
the email from the **verified JWT**, not from an argument, and returns `false`
for everybody else. The browser asks for the promotion instead of granting it to
itself. The old trigger's founder escape hatch allowed *any* role change on
*any* row for those emails; the new one allows exactly self→owner.

### PINs are hashed

`profiles.pin` (plain text) is gone; `profiles.pin_hash` holds a per-row salted
**bcrypt** hash via pgcrypto, which was already installed on production as
version 1.3 in the `extensions` schema. No client role holds any privilege on
the column, so it is reachable only through `set_my_pin` / `check_my_pin` /
`my_pin_status`, all `SECURITY DEFINER`, all `authenticated`-only, all with
`search_path` pinned. Verification stays server-side and returns only a boolean,
exactly as before.

**Why bcrypt and not PBKDF2, given `vault_config` uses PBKDF2.** The vault PIN
is verified inside an Edge Function, where Web Crypto's PBKDF2 is the native
primitive (`supabase/functions/_shared/pin.ts`, 100k iterations). This PIN is
verified inside a SQL function, and pgcrypto has no PBKDF2. Reimplementing it as
a 100,000-iteration plpgsql loop was written and measured, then rejected:
Postgres has no `bytea` XOR operator, so each round needs bit-string
conversions, and the derivation costs seconds of database CPU per PIN check.
bcrypt is one C call, measured on production at **78 ms at cost 10**. Same
security properties as the vault PIN — per-row random salt, deliberately slow
KDF, plaintext never stored or returned, compared only server-side — using the
primitive native to where the comparison happens.

The weak part is the 4-digit keyspace, not the hash: 10,000 candidates at 78 ms
is roughly 13 minutes of offline work for somebody who has already stolen the
table. That is accepted because this PIN is a convenience lock on top of an
already-authenticated Supabase session (`app/src/components/PinGate.tsx`), not a
credential in its own right. Attempt throttling is listed as follow-up work
rather than pretending a bigger cost factor fixes a 4-digit secret.

**All 6 production PINs were `NULL`**, verified before the migration ran, so
nothing was migrated, re-issued or lost and no crew member had to do anything.
The migration refuses to run — with a message naming the row count — if it ever
meets a database where a plain-text PIN still exists.

### Frontend changes

* `ensureMyProfile()` no longer sends `role` on insert (new accounts land on the
  `installer` column default) and calls `claim_owner_bootstrap()` instead of
  writing `role`. A database that predates the RPC still signs in, unpromoted.
* `OPENING_SELECT` embeds the assignee by explicit column instead of
  `assignee:assigned_to(*)`, because `*` against `profiles` now fails.
* New test `app/src/lib/install/profileColumns.test.ts` asserts the client can
  never ask for a PIN column or use a wildcard against `profiles` — 8 new
  assertions, so a future edit breaks the build rather than the crew.

---

## 4. Proof

Taken against production. Re-runnable from
`docs/profiles-security-proof-2026-07-29.sql`, wrapped in a transaction that is
rolled back.

Every attack step asserts its own **effect**, not merely the absence of an
error. That distinction matters: row-level security makes a forbidden UPDATE or
DELETE match zero rows and return *success*, so "no error was raised" would have
been a meaningless pass. An earlier draft of this test reported "ALLOWED" for
three attacks that had in fact been silently filtered. So each attack raises if
it failed to take effect, which means `REJECTED` = the database stopped it.

### Backup, taken and verified first

`docs/backups/2026-07-29T1934Z-czprjcskmzzagdztqonm-full.json`, from
`scripts/backup_project.py` (every statement a SELECT). Verified by re-counting
**every** table against the live database:

```
tables re-counted : 67
live rows total   : 544
backup rows total : 544
auth users        : 6
storage objects   : 9
capture failures  : []
VERIFIED: every table's live count matches the backup, byte-for-row.
```

Re-checked after the migration: `profiles` unchanged at 6 rows; the only drift
was `locations` 42→44 and `push_subscriptions` 0→1, which is live crew traffic
(GPS pings and a device registering for push) during the window, not the
migration.

### The escalation, verbatim

Impersonation is `set local role authenticated` plus a
`request.jwt.claims` GUC carrying the real production `sub` — the same thing
`auth.uid()` reads for a signed-in request. Chris is
`88e9158c-c299-4abf-86e2-4d6c1134d0be`, a plain installer.

```sql
begin;
perform set_config('request.jwt.claims',
  '{"sub":"88e9158c-c299-4abf-86e2-4d6c1134d0be","role":"authenticated","email":"chris@crew.demo"}',
  true);
set local role authenticated;

-- A1
update profiles set role='owner' where id=auth.uid();
```

```
ERROR: 42501 permission denied for table profiles
```

```sql
-- A2, the sanctioned RPC
select set_profile_role(auth.uid(), 'owner');
```

```
ERROR: 42501 only a supervisor or owner can change roles
```

```sql
-- A3, the route that worked this morning
delete from profiles where id=auth.uid();
insert into profiles(id,display_name,skill_level,active)
values('88e9158c-c299-4abf-86e2-4d6c1134d0be','Chris',1,true);
```

```
the delete matched no row (RLS), so the insert collided with the surviving row:
ERROR: P0001 my row is still there - the delete was refused
```

```sql
-- A16: hand the column privilege back by hand and try again, so the trigger is
-- the only thing standing in the way.
reset role;
grant update (role) on table public.profiles to authenticated;
set local role authenticated;
update profiles set role='owner' where id=auth.uid();
```

```
ERROR: 42501 only a supervisor or owner can change a role
       (blocked: installer -> owner on 88e9158c-c299-4abf-86e2-4d6c1134d0be)
```

And the same statement from the owner (Taylor,
`958d3bfc-946e-46b3-a84c-a84d5f586a2e`) **succeeds**:

```sql
perform set_config('request.jwt.claims',
  '{"sub":"958d3bfc-946e-46b3-a84c-a84d5f586a2e","role":"authenticated","email":"taylor@horizonsolarusa.com"}',
  true);
set local role authenticated;
select set_profile_role('69a880bc-8489-48d5-8673-28dcfd5b0210','foreman');
-- ALLOWED; Maria's role reads back as 'foreman'
select set_profile_role('69a880bc-8489-48d5-8673-28dcfd5b0210','installer');
-- ALLOWED; back to installer
rollback;
```

### Full result: 33 checks, 0 failures

| # | Actor | Attempt | Result |
| --- | --- | --- | --- |
| A1 | installer | make myself owner with a direct UPDATE | REJECTED `42501` permission denied for table profiles |
| A2 | installer | make myself owner through the role RPC | REJECTED `42501` only a supervisor or owner can change roles |
| A3 | installer | delete my row so I can re-create it as owner | REJECTED `P0001` my row is still there - the delete was refused |
| A4 | installer | insert myself a fresh row with role owner | REJECTED `42501` permission denied for table profiles |
| A5 | installer | promote a workmate to owner | REJECTED `42501` only a supervisor or owner can change roles |
| A6 | installer | delete the owner's profile | REJECTED `P0001` the owner is still there - the delete was refused |
| A7 | installer | rename a workmate | REJECTED `P0001` name unchanged - the update was refused |
| A8 | installer | deactivate a workmate so they lose the app | REJECTED `P0001` still active - the update was refused |
| A9 | installer | `select * from profiles` | REJECTED `42501` permission denied for table profiles |
| A10 | installer | read someone else's PIN | REJECTED `42501` permission denied for table profiles |
| A11 | installer | read my own PIN | REJECTED `42501` permission denied for table profiles |
| A12 | installer | set the owner's PIN to one I know | REJECTED `42501` permission denied for table profiles |
| A13 | installer | empty the table with TRUNCATE (skips RLS) | REJECTED `42501` permission denied for table profiles |
| A14 | installer | claim owner through the founder bootstrap RPC | REJECTED — returned false, role unchanged |
| A15 | installer | read a secret out of `crew_directory` | REJECTED `42703` column "pin_hash" does not exist |
| A16 | installer | A1 again after `UPDATE(role)` is re-granted | REJECTED `42501` only a supervisor or owner can change a role |
| A17 | **anon** | read the crew list while signed out | REJECTED `42501` permission denied for table profiles |
| A18 | foreman | hand out owner | REJECTED `42501` only a supervisor or owner can change roles |
| A19 | supervisor | promote themselves to owner | REJECTED `42501` you cannot promote yourself above your own role |
| L1 | installer | read my own profile | ALLOWED |
| L2 | installer | read the crew list (roster, pickers, leaderboard, chat) | ALLOWED — all 6 |
| L3 | installer | read the narrow `crew_directory` view | ALLOWED — all 6 |
| L4 | installer | who is clocked in (PostgREST profiles embed) | ALLOWED |
| L5 | installer | the exact roster read the app issues | ALLOWED — all 6 |
| L6 | installer | change my own display name | ALLOWED |
| L7 | installer | set, verify and clear my own PIN | ALLOWED — right PIN accepted, wrong PIN and a prefix rejected |
| L8 | installer | PIN is stored hashed, never plain | ALLOWED — `pin_hash` starts `$2…`, is not `4821` |
| L9 | owner | approve an access request | ALLOWED |
| L10 | owner | assign a role (installer → foreman) | ALLOWED |
| L11 | foreman | edit a workmate's skill tier and on-site flag | ALLOWED |
| L12 | owner | put the foreman back to installer | ALLOWED |
| L13 | service role | edge functions read `profiles.role` on the service key | ALLOWED — all 6 |
| L14 | owner | remove a profile | ALLOWED |

### Committed end state

```
policies:            profiles_select_authenticated  SELECT  using true
                     profiles_insert_self           INSERT  check (id = auth.uid() or my_role_rank() >= 2)
                     profiles_update_self_or_lead   UPDATE  using/check (id = auth.uid() or my_role_rank() >= 1)
                     profiles_delete_supervisor     DELETE  using (my_role_rank() >= 2)
authenticated SELECT: id, display_name, skill_level, role, active, created_at, updated_at
authenticated INSERT: id, display_name, skill_level, active, updated_at
authenticated UPDATE: display_name, skill_level, active, updated_at
authenticated table:  DELETE only (no TRUNCATE, no TRIGGER)
anon:                 nothing
columns:              id, display_name, skill_level, role, active, created_at, updated_at, pin_hash
plaintext pin column: 0
triggers:             guard_profile_insert, guard_profile_role_change
anon-executable functions (of the 9 touched): NONE
unpinned search_path (of the 9 touched):      NONE
crew_directory:       SELECT to authenticated; nothing to anon
roster:               Ammon=owner, Chris=installer, Dave=installer,
                      Maria=installer, Sam=installer, Taylor=owner   (6, unchanged)
PINs set:             0
```

### App checks

`npm run build` (`tsc -b && vite build`) passes, `npm test` 1277 tests in 101
files pass (1269 before, +8 from the new column-contract test), `npm run lint`
exits 0 with the same pre-existing warnings as `master`.

---

## 5. How this was applied, and how to roll it back

**Applied directly, not with `db push`.** Production carries 37 phantom rows in
`supabase_migrations.schema_migrations`, and `supabase db push` refuses to run at
all until the documented cleanup clears them — see
[`docs/db-push-readiness.md`](./db-push-readiness.md). Both files were executed
in a single transaction through the Management API, with a guard that rolls the
whole thing back unless the roster still reads
`Ammon=owner, Chris=installer, Dave=installer, Maria=installer, Sam=installer, Taylor=owner`.
Both were then recorded in `schema_migrations` under their **own filename
versions**, so they are not phantoms and `db push` will treat them as applied.
`NOTIFY pgrst, 'reload schema'` was issued so PostgREST picked up the dropped
column and the new function signature.

**One knock-on for the cleanup runbook:** the history table is now 109 rows for
72 files (still 37 phantoms, still 0 filename versions missing).
`scripts/cleanup-migration-phantoms.sh` pins its expectations at 70/107/37 and
will refuse until they are updated — which is exactly what it is designed to do,
and its own error message prints the command:

```
EXPECT_LOCAL=72 EXPECT_REMOTE=109 EXPECT_PHANTOMS=37 \
  SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm scripts/cleanup-migration-phantoms.sh
```

The phantom count is unchanged, so nothing about that cleanup got harder.

### Rollback

Restores the previous behaviour exactly, including the hole. Only worth running
if the lockdown breaks something in front of a crew and there is no time to
diagnose it.

```sql
begin;

-- 1. Blanket policy back
drop policy if exists profiles_select_authenticated  on public.profiles;
drop policy if exists profiles_insert_self           on public.profiles;
drop policy if exists profiles_update_self_or_lead   on public.profiles;
drop policy if exists profiles_delete_supervisor     on public.profiles;
create policy "authenticated full access" on public.profiles
  for all to authenticated using (true) with check (true);

-- 2. Grants back
grant all on table public.profiles to anon, authenticated;

-- 3. Triggers off
drop trigger if exists guard_profile_insert      on public.profiles;
drop trigger if exists guard_profile_role_change on public.profiles;

-- 4. PIN column back. Note: any PIN set since the migration lives only as a
--    bcrypt hash and CANNOT be recovered — those crew members must re-set it.
alter table public.profiles add column if not exists pin text;
grant all on table public.profiles to anon, authenticated;

commit;
notify pgrst, 'reload schema';
```

Then revert the frontend commit, because `ensureMyProfile()` calls
`claim_owner_bootstrap()`. A partial rollback is fine too: dropping only
`guard_profile_insert` and the DELETE policy re-opens the escalation, so prefer
loosening one thing at a time and re-running the proof file after each step.

---

## 6. What is still open, in priority order

Deliberately **not** fixed here — a single RLS change is how people get locked
out of their own app. Counts are from production on 2026-07-29, after this fix.

| # | Gap | Measured | Risk in one line |
| --- | --- | --- | --- |
| 1 | **Clients can `TRUNCATE` almost every table** | 72 of the 73 base tables in `public` grant `TRUNCATE` to `anon`/`authenticated` — `profiles` is now the only exception | `TRUNCATE` is not subject to row-level security at all, so every policy on those tables can be stepped over and a table emptied; the only reason it is not catastrophic today is that PostgREST offers no way to issue the statement. Cheapest big win: one migration revoking `truncate, trigger` across `public`. |
| 2 | **49 tables still carry `FOR ALL USING (true)` for `authenticated`** | 49 with the full blanket `ALL`; 53 with a `true` clause somewhere | Same shape of hole this document closes, on job costs, timecards, issues, AI spend limits, knowledge docs, `access_requests`. Nothing here is a role escalation, but any signed-in user can rewrite or delete another crew's work, approve their own access request, or lift AI spend caps. Fix in batches by table family, each batch with its own before/after proof; `job_costs`, `time_shifts`, `access_requests` and `ai_spend_limits` first. |
| 3 | **Email self-signup is open** | `disable_signup: false`, `external_email_enabled: true`, `mailer_autoconfirm: false`, no CAPTCHA, `password_min_length: 6` | Anyone with an email address can create an account. Post-fix they land as `installer`, so they cannot escalate — but installer already reaches 22 screens and the whole crew directory, and combined with gap 2 that is write access to real job data. Turn signup off and invite crew from the dashboard; the app already has an access-request flow built for exactly this (`Admin.tsx`). Highest ratio of risk removed to effort. |
| 4 | **38 `SECURITY DEFINER` functions are executable by `anon`** | 38 (the earlier audit counted 23; it has grown) | Each runs with owner privileges, so any that does not check `auth.uid()` itself is reachable by a signed-out visitor. Includes `approve_shift`, `assign_issue`, `create_issue`, `ai_spend_set_limits`, `undo_install`. Needs reading one at a time — most will be no-ops for `anon` because they key off `auth.uid()` — then a blanket `revoke execute … from anon`. |
| 5 | **7 `SECURITY DEFINER` functions have no pinned `search_path`** | `assign_issue`, `lead_add_shift`, `lead_edit_shift`, `open_service_case`, `reject_shift`, `set_issue_fault`, `undo_install` | Classic escalation route: a caller who can create a schema can shadow an unqualified name and have it resolved with owner privileges. The 2026-07-18 migration pinned every function that existed then; these were added afterwards. Behaviour-neutral one-liner each. |
| 6 | **Storage buckets are broadly scoped** | 4 buckets, all `public: false`; 4 policies, 3 of them `FOR ALL` to `authenticated` for a whole bucket | No bucket is world-readable, which is the important thing. But any signed-in user can read, overwrite and delete every plan set, install photo and signed toolbox record — including another crew's. `install-media` has no policy at all, so it is unreachable from the client (a gap the other way). Scope by path prefix per project or per user. |
| 7 | **No throttling on PIN attempts** | n/a | A 4-digit PIN behind an authenticated session; `check_my_pin` can be called in a loop at ~78 ms a try. Low severity because the PIN is a second factor on a session you already hold, but a counter with a lockout is cheap. |
| 8 | **`_naive_probe` has row-level security switched off** | 1 table | Left over from a concurrency experiment. Zero rows, no data, but it is the only table in `public` with RLS off. Drop it. |

Recommended next step: **gap 3 then gap 1**. Turning off self-signup and
revoking `TRUNCATE` are both single, reversible, low-blast-radius changes that
remove a large share of what is left, and neither can lock a crew member out of
a screen they use today.
