# Closing the follow-ups from the `profiles` lockdown

**Plain English:** three things changed today, and one of them is the important
one. **Approving somebody on the Admin screen now actually gives them a working
login.** It never did before — it ticked a box and stopped, which is why "when I
admin approve his login it still won't work" kept happening and why one person
had to have a password set for him by hand. Now an owner taps Approve, gets a
one-time password to pass on, and that person can sign in. Because that finally
works, **strangers can no longer sign themselves up**: the front door is the
approval queue. Separately, no signed-in user can wipe a table any more. Nobody
has to do anything and no crew member's account changed.

Applied to production (`czprjcskmzzagdztqonm`) on 2026-07-29, after
[`profiles-security-2026-07-29.md`](./profiles-security-2026-07-29.md) and its
list of eight remaining gaps. This covers gaps **3, 1, 5 and 8** from that list —
the four that are single, reversible, and cannot lock a crew member out of a
screen they use today. Gaps 2, 4, 6 and 7 are **planned here and deliberately
not applied**; see section 6.

Migrations:
`supabase/migrations/20260729210000_revoke_truncate_from_clients.sql`,
`20260729210100_pin_search_path_remaining_secdef.sql`,
`20260729210200_drop_naive_probe_experiment.sql`.
New edge function: `supabase/functions/approve-access-request/`.

---

## 0. Backup, taken and verified first

`docs/backups/2026-07-29T2005Z-czprjcskmzzagdztqonm-full.json`, from
`scripts/backup_project.py` (every statement it runs is a SELECT), taken before
anything below was applied and verified by re-counting **every** table against
the live database:

```
tables re-counted : 74
live rows total   : 558
backup rows total : 557
auth users        : 6
storage objects   : 9
capture failures  : []
MISMATCHES: public.ai_usage_events: backup 5 live 6
            public.ask_question_log missing from backup
```

Both mismatches are somebody else's live work, not a capture failure. A crew
member asked Ask Infinity a question during the run (`ai_usage_events` +1), and
another agent created `ask_question_log` minutes after the snapshot started.
Every other table matches row for row, and nothing below touches either of them.

The 9 storage objects are listed with their sizes and paths but their **bytes
are not in this repository** — 23,632,980 bytes of plan-set PDFs and signed
toolbox records, over the commit budget, and recorded as such in the file's
`_storage.object_bytes_note`. Nothing in this change can affect a storage object:
no bucket, no storage policy and no object row is touched.

Every change below has a written rollback in section 5.

---

## 1. Approving somebody now creates their login (gap 3, part one)

### What was actually happening

This had to be established before anything else, because closing self-signup
while the approval path is broken would mean **nobody new could ever get into
the app again** — much worse than the risk being removed.

The path, traced end to end:

| Step | Code | What it did |
| --- | --- | --- |
| "Request access" | `SignIn.tsx` → `submitAccessRequest()` | insert a row into `access_requests` as `anon`. Email was **optional**. |
| The queue | `Admin.tsx` → `listAccessRequests()` | read the rows, supervisor+ only |
| "Approve ✓" | `Admin.tsx` → `decideAccessRequest(id, "approved")` | `update access_requests set status='approved'` — **and nothing else** |

There is no trigger on `access_requests`, no function watching it, and nothing
anywhere in `supabase/functions` that creates a user. Approving wrote a word into
a column. The screen even said so, in small grey text under each request:

> Once approved, create their login in Supabase Auth, then set their role on the
> Crew screen.

So "approve" meant "an owner must now open the Supabase dashboard and create the
account by hand". That is the whole of the reported failure.

### Why it is a password and not an emailed invitation

Supabase's Auth admin API can invite by email, and that would normally be the
right answer. Measured against this project it is not:

```
smtp_admin_email      : null          (no mail sender configured)
rate_limit_email_sent : 2             (per hour, on Supabase's shared sender)
mailer_autoconfirm    : false         (so a new account needs a confirmation email)
site_url              : http://localhost:3000
uri_allow_list        : (empty)
```

An invitation would either not arrive or would land on `localhost:3000`. So the
new function does what the owner was already doing by hand, minus the hand: it
creates the account **pre-confirmed** with a generated password and returns that
password once, on screen, to the supervisor who approved. No mail is involved at
any point.

### What was built

**`supabase/functions/approve-access-request/`** (service role, `verify_jwt =
true`, deployed to production). Given a request id it:

1. re-verifies the caller's JWT, then reads **`profiles.role`** for that caller
   and refuses anything below supervisor — the same `roleRank` ladder the UI
   uses, copied with its legacy aliases so the two cannot disagree;
2. refuses a denied request, and refuses a request with no email;
3. refuses an email that **already** has an account, rather than resetting that
   account's password — otherwise this endpoint would be a way for a supervisor
   to take over the owner's login;
4. creates the user with `email_confirm: true` and a 14-character password from
   the platform CSPRNG (a 32-symbol alphabet with no `0/O/1/l/I`, rejection
   sampled, ~70 bits — readable down a phone line);
5. inserts their `profiles` row with the name the approver saw. **`role` is not
   sent**, so the column default `installer` applies. The role somebody asked for
   on a form they filled in themselves is not evidence; an owner lifts them on
   the Crew screen;
6. rolls the auth user back if the profile insert fails, so there is never a
   half-made account;
7. marks the request approved and records who approved it.

**Frontend:** `Admin.tsx`'s Approve button calls it and shows the email and
one-time password with a Copy button and a plain note that it is shown once.
Deny is unchanged. `SignIn.tsx` now requires the email on the request form —
it is the login, and a request without one cannot become an account, which is
how approvals used to end in nothing happening.

### Proof

`scripts/prove-onboarding.py`, run against production. It submits a real request
as a signed-out visitor, approves it as the real owner, signs in as the person it
just created, deletes everything it made, and asserts the roster is back to what
it was before it exits. The owner session is a one-time magic link minted with
the admin API — no mail is sent and his password is not touched.

```
=== onboarding proof against czprjcskmzzagdztqonm
  roster before: Ammon=owner, Chris=installer, Dave=installer, Maria=installer, Sam=installer, Taylor=owner
  A0   PASS  a stranger self-signup is refused: {"code": 422, "error_code": "signup_disabled", "msg": "Signups not allowed for this instance"}
  E1   PASS  a signed-out visitor submitted an access request (3268887a-3081-42b5-b8a9-b95858d65cd4)
  E2   PASS  Taylor (owner) approved it: HTTP 200 {"ok": true, "user_id": "67cc1b2b-...", "email": "qa.onboarding.probe@horizonsolarusa.com", "display_name": "QA Onboarding Probe", "role": "installer"}
  E3   PASS  the new person signed in with the one-time password - session issued
  E4   PASS  they land as an installer on the crew list: {"display_name": "QA Onboarding Probe", "role": "installer", "active": true}
  E5   PASS  the new installer tried to approve someone else: HTTP 403 {"error": "only a supervisor or the owner can approve access"}
  E6   PASS  a second approval works: HTTP 200
  E7   PASS  approving the same person twice is refused: HTTP 409
  C1   PASS  roster is back to what it was: Ammon=owner, Chris=installer, Dave=installer, Maria=installer, Sam=installer, Taylor=owner
  C2   PASS  no test access request left behind

ALL CHECKS PASSED: an owner can onboard a new crew member, and a stranger cannot.
```

E3 is the step that matters: the account is not merely created, it **authenticates**.

---

## 2. Email self-signup is off (gap 3, part two)

Only after the above passed. One setting on the project's auth config:

```
disable_signup: false  ->  true
```

`external_email_enabled` stays `true`, because that is what lets existing crew
sign in with a password; `disable_signup` is what stops a stranger creating an
account.

The same proof script measures this rather than assuming it, and the measurement
was taken **before and after** so the test is not vacuous:

| When | A stranger POSTs `/auth/v1/signup` |
| --- | --- |
| Before | `SUCCEEDED - user created` (the test account was deleted immediately) |
| After | `422 signup_disabled — "Signups not allowed for this instance"` |

The whole onboarding proof was then re-run **with signup disabled**, because
`admin.createUser` refusing under `disable_signup` would have been a quiet way to
break the only remaining way in. It does not: all ten steps pass, as shown above.

`SignIn.tsx` also loses its "Create Owner account" button, which would now only
ever show everyone "Signups not allowed for this instance". Both founder emails
already hold `owner`, and `claim_owner_bootstrap()` is untouched.

---

## 3. Clients can no longer `TRUNCATE` (gap 1)

`TRUNCATE` is the one write row-level security does not see. Every policy in this
database filters rows; `TRUNCATE` does not touch rows one at a time, it empties
the file. So a table can have a perfect set of policies and still be wiped by
anybody holding the privilege — and on 2026-07-29 that was `anon` on 70 relations
and `authenticated` on 75, everything except `profiles`.

**Nobody granted it.** Supabase ships an `ALTER DEFAULT PRIVILEGES` rule that
hands `anon`, `authenticated` and `service_role` every privilege on each new
table in `public`. The grant arrives with each `create table`, which is why
revoking only the current instances would have decayed on the next migration.
Nothing in `supabase/migrations/` grants it; the only `grant all` statements
there are to `service_role`, which is correct and untouched.

So the migration does both:

```sql
revoke truncate on all tables in schema public from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke truncate on tables from anon, authenticated;
```

Every table and view in `public` is owned by `postgres` (74 tables, 3 views), and
the default privileges that apply to a new object are the ones belonging to the
role that creates it, so that second statement covers everything this repo will
ever create. There is a second rule in `public` owned by `supabase_admin`; it
**cannot** be altered from a migration (`42501 permission denied to change
default privileges` — `postgres` is not a member of that role) and does not need
to be, because nothing in this project creates objects as `supabase_admin`. That
is recorded here rather than pretended away.

Behaviour-neutral: PostgREST has no way to issue a `TRUNCATE` — there is no REST
verb for it and `.rpc()` only reaches functions — and nothing in `app/src`,
`supabase/functions` or `supabase/migrations` issues one. `service_role` and the
table owner keep it.

---

## 4. Two cheap ones (gaps 5 and 8)

**Seven `SECURITY DEFINER` functions had no pinned `search_path`** —
`assign_issue`, `lead_add_shift`, `lead_edit_shift`, `open_service_case`,
`reject_shift`, `set_issue_fault`, `undo_install`. All were added after the
2026-07-18 migration that pinned everything existing at the time. Without a
pinned path the caller chooses which schema an unqualified name resolves in, so
somebody who can create a schema can shadow a name and have it executed with
owner privileges. `alter function … set search_path = public` on each, written as
a loop rather than seven hard-coded names because this is the second time the
list has gone stale, with an assertion that zero are left.

**`_naive_probe` is gone** — with a correction to the earlier note, which said it
held zero rows. It held one:

```json
{"user_id": "958d3bfc-946e-46b3-a84c-a84d5f586a2e", "calls": 10}
```

The owner's own id with a counter of 10: the tally left behind by a concurrency
experiment, not anybody's data. No foreign key referenced it and no file in the
repo mentions it. The migration refuses to run if it meets any other content.

The two functions went with it. `_atomic_probe(uuid,int)` and
`_naive_reserve(uuid,int)` are the two halves of that experiment — both write
only to `_naive_probe` and both call `pg_sleep(0.4)` to widen the race window.
Dropping the table alone would have left two `SECURITY DEFINER` functions that
any signed-in caller can invoke, that sleep for four tenths of a second a call,
and that now fail on a missing table. They are removed as one unit.

`public` now has **no** table with row-level security switched off.

---

## 5. Proof, and how to roll each change back

### Proof

Re-runnable from `docs/security-followups-proof-2026-07-29.sql`, wrapped in a
transaction that is rolled back, plus `scripts/prove-onboarding.py` for the
onboarding half. Impersonation is the same shape `auth.uid()` sees for a real
signed-in request: a `request.jwt.claims` GUC carrying the real production `sub`,
plus `set local role authenticated`. Chris is
`88e9158c-c299-4abf-86e2-4d6c1134d0be`, a plain installer.

Every attack step asserts its own **effect**. That is not pedantry: row-level
security makes a forbidden write match zero rows and return *success*, so "no
error was raised" would have been a meaningless pass. **T0 exists to prove the
`TRUNCATE` test is not vacuous** — hand the privilege back by hand and the same
statement wipes 26 rows.

| # | Actor | Attempt | Result |
| --- | --- | --- | --- |
| T0 | installer | `TRUNCATE project_windows` **after handing the privilege back** (control) | **ALLOWED — went from 26 rows to 0**, so the tests below are real |
| T1 | installer | `TRUNCATE public.projects` | REJECTED `42501` permission denied for table projects |
| T2 | installer | `TRUNCATE public.time_shifts` (everyone's hours) | REJECTED `42501` permission denied for table time_shifts |
| T3 | **anon** | `TRUNCATE public.access_requests` while signed out | REJECTED `42501` permission denied for table access_requests |
| T4 | n/a | relations in `public` still granting TRUNCATE to anon/authenticated | **NONE** |
| T5 | n/a | default privileges for new tables in `public` (role postgres) | no TRUNCATE for anon/authenticated |
| T6 | service role | service_role can still TRUNCATE | ALLOWED — unchanged |
| S1 | n/a | `SECURITY DEFINER` functions in `public` with no pinned `search_path` | **NONE** |
| P1 | n/a | `_naive_probe` and its two probe functions | GONE |
| P2 | n/a | tables in `public` with row-level security off | **NONE** |
| L1 | installer | read my own profile | ALLOWED |
| L2 | installer | read the crew list | ALLOWED — all 6 |
| L3 | owner | read the access-request queue (Admin screen) | ALLOWED — 3 rows |
| L4 | owner | mark an access request approved | ALLOWED |
| L5 | service role | edge functions read `profiles.role` on the service key | ALLOWED — all 6 |
| L6 | installer | call a re-pinned function (`undo_install`) | RAN — refused as before: `P0001` only a foreman-level user or above can undo an install |
| R1 | n/a | roster | Ammon=owner, Chris=installer, Dave=installer, Maria=installer, Sam=installer, Taylor=owner |
| R2 | n/a | accounts in `auth.users` | **6** |

`project_windows` was re-counted after the run: still 26 rows. Nothing the proof
did survived the rollback.

`T1` uses `projects`, which is referenced by foreign keys — with the privilege
handed back it would fail with `0A000` rather than `42501`, for reasons that have
nothing to do with permissions. That is exactly why the control uses
`project_windows`, a table with rows that nothing references.

### App checks

`npm run build` (`tsc -b && vite build`) passes. `npm test` — **1331 tests in 105
files pass** (1321 in 104 before, +10 from the new onboarding contract test).
`npm run lint` exits 0 with the same pre-existing warnings as `master`.

### How this was applied

Directly through the Management API, not with `db push`, which still refuses
while production carries phantom rows in `supabase_migrations.schema_migrations`
— see [`docs/db-push-readiness.md`](./db-push-readiness.md). Each file ran in its
own transaction with the assertions above inside it, then was recorded in
`schema_migrations` under its **own filename version**, so none of the three is a
phantom and `db push` will treat them as applied.

`scripts/cleanup-migration-phantoms.sh` had to move with it: **76 files on disk,
113 history rows, 38 phantoms**, and its defaults are updated in this PR so the
cleanup still runs. Only 3 of those are ours (+3 files, +3 rows, **0 phantoms**);
`20260729200000_ask_question_log.sql` merged the same afternoon and accounts for
the other new file. The 38th phantom is `20260729220000 staging_bays_guaranteed`,
applied to production from somebody else's unmerged branch; when that file
reaches `master` the right numbers become 77 / 113 / 37.

### Rollback

Each is independent — run only the one you need.

**Re-open self-signup** (do this first if anything about onboarding goes wrong;
it is the change that could leave people locked out):

```bash
curl -X PATCH "https://api.supabase.com/v1/projects/czprjcskmzzagdztqonm/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"disable_signup": false}'
```

**Undo the approval flow.** Revert the frontend commit; `Admin.tsx` goes back to
`decideAccessRequest(id, "approved")`, which marks the row and creates no
account. The edge function can be left deployed — nothing calls it — or removed
with `supabase functions delete approve-access-request --project-ref
czprjcskmzzagdztqonm`. Note that reverting puts the original problem back: an
approval that does not produce a login.

**Give TRUNCATE back to the browser roles** (restores the hole):

```sql
grant truncate on all tables in schema public to anon, authenticated;
alter default privileges for role postgres in schema public
  grant truncate on tables to anon, authenticated;
```

**Unpin the seven search paths** (restores the escalation route). There is no
reason to run this; it is written down for completeness:

```sql
alter function public.assign_issue(uuid, uuid) reset search_path;
alter function public.lead_add_shift(uuid, uuid, uuid, timestamptz, timestamptz, integer, text) reset search_path;
alter function public.lead_edit_shift(uuid, uuid, uuid, timestamptz, timestamptz, integer, text) reset search_path;
alter function public.open_service_case(uuid, text, text, text) reset search_path;
alter function public.reject_shift(uuid, text) reset search_path;
alter function public.set_issue_fault(uuid, uuid) reset search_path;
alter function public.undo_install(uuid, text) reset search_path;
```

**Recreate the experiment**, row and all:

```sql
create table public._naive_probe (user_id uuid primary key, calls integer);
insert into public._naive_probe (user_id, calls)
values ('958d3bfc-946e-46b3-a84c-a84d5f586a2e', 10);

create function public._naive_reserve(p_uid uuid, p_limit integer) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_calls int;
begin
  select coalesce(calls, 0) into v_calls from _naive_probe where user_id = p_uid;
  v_calls := coalesce(v_calls, 0);
  perform pg_sleep(0.4);
  if v_calls >= p_limit then
    return jsonb_build_object('allowed', false, 'reason', 'user_daily');
  end if;
  insert into _naive_probe (user_id, calls) values (p_uid, 1)
    on conflict (user_id) do update set calls = _naive_probe.calls + 1;
  return jsonb_build_object('allowed', true);
end $$;

create function public._atomic_probe(p_uid uuid, p_limit integer) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_calls int;
begin
  perform pg_sleep(0.4);
  insert into _naive_probe (user_id, calls) values (p_uid, 1)
  on conflict (user_id) do update
    set calls = _naive_probe.calls + 1
    where _naive_probe.calls < p_limit
  returning calls into v_calls;
  if v_calls is null then
    return jsonb_build_object('allowed', false, 'reason', 'user_daily');
  end if;
  return jsonb_build_object('allowed', true, 'calls', v_calls);
end $$;
```

---

## 6. Planned, deliberately not applied

These four are gaps 2, 4, 6 and 7 from the earlier list. Each one can lock a crew
member out of a screen they use today, so each gets a plan and a proof run of its
own rather than a blind apply. Everything below was re-measured against
production, and several of the numbers in the earlier document have moved.

### 6a. 49 tables still hand every signed-in user full control

**Measured today:** 49 of the 74 base tables in `public` carry exactly one
policy — `authenticated full access`, `cmd = ALL`, `using true`, `with check
true`. Four more have a `true` clause that is *not* the blanket shape
(`profiles`, `project_mark_specs`, `project_mark_elevation_views`,
`project_spec_discrepancies` — all SELECT-only and deliberate), giving 53 with
`true` somewhere. The 49 hold 449 rows; the biggest are `project_openings` 151,
`window_types` 149, `locations` 44, `project_windows` 26. **Two examples in the
earlier list are now stale:** the AI-spend tables and the project-chat tables are
no longer in the blanket set. No policy anywhere in `public` grants anything to
`anon`.

**Risk, in one plain sentence:** any one of the crew, on their own phone, can
change or delete anybody else's timecard, job costs, photos, issues, plan sets
and the whole window catalogue — not because a screen offers it, but because the
database never asks who they are.

**Intended fix:** one migration per table family, smallest and highest-value
first, and no family touched until the previous one has a green proof run. Per
table: drop the blanket policy, create four per-command policies (never a single
`ALL`, so a wrong `with check` cannot also break reads) using the helpers that
already exist — `my_role_rank()` and `can_access_project_chat()`. Deliberately no
new `SECURITY DEFINER` helper, because a new one lands straight back in 6b. Each
family is reversible on its own with a single `create policy … for all …
using (true)`.

| Family | Tables | Recommended shape | Blast radius if wrong |
| --- | --- | --- | --- |
| **Money & approvals** (5) | `job_costs`, `time_shifts`, `cost_codes`, `points_ledger`, `change_orders` | SELECT `profile_id = auth.uid() or my_role_rank() >= 1`; INSERT/UPDATE self; rates and approvals `>= 2` | High — installers lose their own hours view or cannot clock in; `/costing` goes blank for the owner |
| **Identity & access** (2) | `access_requests`, `installer_clearance` | `my_role_rank() >= 2` throughout; no self-approval | 4 rows, high value. Wrong = the approvals list empties and nobody new can be let in |
| **Per-person records** (3) | `learn_progress`, `safety_acks`, `toolbox_completions` | SELECT self or `>= 1`; INSERT/UPDATE `profile_id = auth.uid()` | High — the toolbox-talk signature gates clock-in, so a wrong INSERT check stops the whole crew starting the day |
| **Plan sets & knowledge** (4) | `project_plansets`, `project_planset_pages`, `knowledge_docs`, `knowledge_chunks` | SELECT open; writes `>= 1`, knowledge writes `>= 2` | Medium — the plan-set viewer is installer-reachable; ingest runs on the service key and is unaffected |
| **Per-project field work** (12) | `projects`, `project_openings`, `install_events`, `task_sessions`, `job_notes`, `qc_checks`, `issues`, `service_cases`, `incidents`, `project_marks`, `project_plan_outlines`, `attachments` | SELECT stays `true` in pass 1; INSERT `created_by = auth.uid()`; UPDATE own or `>= 1` | Highest — this is the daily install flow |
| **Reference & catalogue** (7) | `window_types`, `locations`, `supplies`, `tools`, `safety_talks`, `window_id_counters`, `learn_priority_terms` | SELECT `true`; writes `>= 1`, catalogue edits `>= 2` | Medium — scan, warehouse, labels and learn read these constantly |
| **Inventory & movement** (5) | `windows`, `movements`, `cycle_counts`, `supply_orders`, `project_windows` | SELECT `true`; scan-driven writes stay open, receive/load/unload `>= 1` | Medium — most of that path already runs through definer functions and bypasses RLS |
| **Scheduling & fleet** (11) | `schedule_events`, `schedule_assignments`, `schedule_assignment_members`, `vehicles`, `vehicle_devices`, `vehicle_drivers`, `vehicle_locations_history`, `vehicle_locations_latest`, `vehicle_project_assignments`, `vehicle_service_records`, `vehicle_service_schedules` | SELECT `true`; writes `>= 2` to match the nav gates | All 11 are empty, so this is the cheapest family to practise on |

**What could break for a crew member.** The single most dangerous measurement
here: **`schedule_assignment_members` has 0 rows.** Any read policy phrased as
"only people assigned to this job" would therefore hide **every job from every
installer**. That is why reads stay `true` in the first pass for anything
installer-reachable, and tightening reads is a separate exercise. Beyond that:
`time_shifts` read scoped too tightly shows an installer an empty week, which
they will read as "the app lost my hours"; a wrong INSERT check on
`toolbox_completions` blocks the whole crew from clocking in at 7am, so that
family ships on a day somebody is watching; and `window_id_counters` is written
inside definer functions, so a client-facing lockdown there is invisible until
unit allocation is tested on a real project. One family per PR, proof re-run
after each.

Worth knowing before it gets blamed on this work: `SignIn.tsx` submits an access
request while the visitor is still `anon`, and the `anon can request` INSERT
policy is what makes that work. Do not fold `access_requests` into a blanket
"supervisor only" tightening without keeping that policy — and do not widen it
either; it is an unauthenticated write endpoint and deserves its own decision.

### 6b. Signed-out visitors can call 31 owner-privileged functions

**Measured today:** **31**, not 38 — the profile and PIN functions were revoked
in the earlier lockdown and the two probe functions were dropped today. All 31
are executable by `authenticated` too. Reading each source, they fall into three
groups:

* **Genuinely acts for a signed-out caller — 2.** `create_issue(...)` has **no
  role check at all**; being a definer it bypasses RLS and inserts an issue with
  `created_by = auth.uid()`, which is NULL for `anon`. `resolve_issue(p_id)`
  likewise has no check and will close any issue whose uuid you know.
* **Leaks a boolean to a signed-out caller — 4.** `is_foreman_plus(p_uid)`,
  `can_read_ask_log(p_uid)`, `can_access_project_chat(p_project_id, p_uid)` take
  the id as an *argument* instead of reading `auth.uid()`, so a stranger can ask
  "is this person a boss". `vault_pin_is_set()` reveals whether the vault PIN is
  configured. Booleans only, no data.
* **No-op for a signed-out caller — 25.** Every one opens with a role read keyed
  on `auth.uid()` and raises when it is null: `approve_shift`, `assign_issue`,
  `undo_install`, `load_units`, `set_clearance` and twenty others.

**Risk, in one plain sentence:** two of these work for a complete stranger who
has never signed in — they can file junk issues into the app and close real ones
— and four more let a stranger confirm who the bosses are.

**Intended fix, in this order,** because the first step is the actual hole and
the blanket revoke is hygiene: (1) add `if auth.uid() is null then raise` to
`create_issue` — gated on *signed in*, not on rank — and the full role check to
`resolve_issue`; (2) change the four id-argument helpers to read `auth.uid()`;
(3) only then `revoke execute … from anon` across the rest, plus
`alter default privileges` so the next function added does not repeat it.
Before that revoke, re-check `pg_policies` for any policy scoped to `anon` or
`public` whose expression calls one of these helpers — policy expressions run
with the caller's privileges, so revoking `EXECUTE` on a helper a policy needs
turns a clean "no rows" into a hard `42501`. Every policy in `public` and
`storage` is `{authenticated}` today, so this is currently safe, but it must be
re-checked at apply time rather than assumed.

**What could break for a crew member.** `create_issue` is the one function here
an installer genuinely needs — reporting a problem from an opening is the most
important thing the lowest rung does. If the new guard copies the house pattern
verbatim (`v_role = 'installer'` → raise), every installer silently loses it.
And `can_access_project_chat` / `can_read_ask_log` are **policy helpers**:
changing their signature without changing every policy that calls them in the
same migration reads to a crew member as "project chat is empty" or "Ask stopped
answering". Do not lead with the blanket revoke — it looks like the safe one, but
it is the one that can knock over a policy helper.

### 6c. One plan-set folder, four keys, everybody has all of them

**Measured today:** 4 buckets, all `public: false` — `install-media`,
`plansets`, `toolbox-records`, `trip-attachments`. 4 policies, all on
`storage.objects`, all to `authenticated`, three of them bucket-wide `ALL`.
**Correcting the earlier note:** `install-media` *does* have a policy — it shares
`authenticated install buckets` with `plansets` — so it is reachable from the
client after all. `storage.buckets` has no policy and is therefore closed.
`anon` and `authenticated` hold `TRUNCATE` on `storage.objects` and
`storage.buckets`; today's revoke covered `public` only, not the `storage`
schema.

The fix is cheap because **the paths already carry the right owner**:
`plansets` is `{projectId}/{ts}-{file}` (7 objects, 3 prefixes, all confirmed
real `projects.id`), `toolbox-records` is `{profileId}/{talkId}/{date}-{ts}`
(2 objects, prefix confirmed a real `profiles.id`), `install-media` is
`{projectId | "unassigned"}/feed/…` and `trip-attachments` is `{tripId}/…`
(both empty today).

**Risk, in one plain sentence:** every signed-in person holds a key to every
folder — any crew member can open, overwrite or delete any job's plan sets, any
install photo and anyone's signed safety record, including jobs they have never
been on.

**Intended fix:** replace the bucket-wide `ALL` policies with per-command
policies that also test the first path segment via
`(storage.foldername(name))[1]`, one bucket per migration, in ascending order of
how much the crew depend on it: `toolbox-records` (2 objects) →
`trip-attachments` (0) → `install-media` (0) → `plansets` (7) last. Add
`revoke truncate, trigger on storage.objects, storage.buckets from anon,
authenticated` — the same one-liner as today's, in the schema that was missed.

**What could break for a crew member.** Two specific traps. First, the photo
path is `${projectId ?? "unassigned"}/feed/…`, so a policy that casts the first
segment to `uuid` hard-fails with `22P02` on the literal `unassigned` and every
job-less photo stops uploading; either allow that prefix explicitly or ship the
client change first. Second, **uploads go through the offline outbox**, so a
rejected upload is not an error the crew member sees at capture time — it becomes
a stuck queue item that presents days later as "my photos from Tuesday never
arrived". Watch outbox depth for a day after applying. And the same 0-row
`schedule_assignment_members` problem applies: a membership-based read predicate
on `plansets` would take the plan set away from an installer standing in front of
the building.

### 6d. The unlock PIN can be guessed 10,000 times without anyone noticing

**Measured today:** `check_my_pin(p_pin text)` is `SECURITY DEFINER`,
`authenticated` only (`anon` has no execute — confirmed), and its whole body
reads the hash for `auth.uid()` and compares. There is **no attempt counter, no
lockout, no logging**, and no rate-limit table anywhere in `public`. **0 of 6
profiles have a PIN set**, so this changes nothing for anyone today.
`PinGate.tsx` submits automatically the instant a fourth digit lands, keeps no
failure count, and caches success in `sessionStorage`.

**Risk, in one plain sentence:** if somebody gets hold of an unlocked phone that
is already signed in, they can sit there trying PINs forever and nothing slows
them down or tells anyone — though that same phone can be opened faster by other
means anyway.

**Intended fix:** add `pin_failed_count` and `pin_locked_until` to `profiles`
with **no client grant on either column**, the same pattern as `pin_hash`, so
they are reachable only through the definer functions; increment on a wrong PIN,
lock after N failures, reset on success and on `set_my_pin`.

**What could break for a crew member.** One hazard dominates, and it would be
worse than the problem: `checkMyPin()` in `api.ts` does
`return data ? { ok: true } : …`. If `check_my_pin` is changed to return `jsonb`
— the obvious way to say "locked, try again in 12 minutes" — then
`{"allowed": false}` is a **truthy** JavaScript object and the PIN gate opens on
*any* four digits. Keep the boolean signature, or ship the client change first,
never the other way round. Second: there is no "unlock this person" control on
any screen, and a locked-out crew member cannot clear their own PIN because the
gate is what stands between them and the screen where the PIN control lives —
ship the reset path first. Third: the pad auto-submits, so a pocket-tap burns an
attempt; five is too tight for that UI. This sits last of the four precisely
because it hardens a convenience lock on top of a session the person already
holds, not a credential.

---

## 7. Two things found on the way that are not fixed here

**`site_url` is `http://localhost:3000` and `uri_allow_list` is empty.** So the
"Reset password" button on the sign-in screen sends a link that points at a
developer's laptop. It does not affect onboarding — the new approval flow needs
no email at all — but it means a crew member who forgets their password cannot
help themselves, and an owner has to re-approve or reset them by hand. The fix is
one config change once somebody confirms the production frontend URL, and it is
left out of this PR only because guessing that URL wrong would break sign-in
redirects for everyone.

**`TRIGGER` is still granted to `anon` and `authenticated`** on almost every
table, from the same Supabase default that granted `TRUNCATE`. `profiles` had it
revoked in the earlier lockdown. It is a much smaller hole than `TRUNCATE` — a
client would also need `CREATE` on the schema to have anything worth attaching —
and revoking it is a one-line addition to the same migration. It is named here
rather than folded in silently, because a change that touches every table in the
database should be the change the PR is about.
