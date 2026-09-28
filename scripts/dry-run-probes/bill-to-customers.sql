-- Per-job "Bills to" (20261035000000_bill_to_customers.sql and its note,
-- 20261035010000_bill_to_note.sql). Proves on the real schema, as the people
-- who will call them:
--   * the list is seeded with the two names only and every existing job
--     defaults to STG Windows and Doors (COUNTS only: this log is public);
--   * a supervisor can add a customer, change the sandbox job's bill-to (one
--     log line with who), retire and bring back, and is refused a retired
--     customer, retiring the default and any direct table write;
--   * a job a supervisor creates the way the Jobs screen does is born with
--     the default;
--   * the QA foreman and the QA installer read nothing and change nothing;
--   * a "Sees costs" grant opens reading and nothing more;
--   * the supervisor/owner note is stored as written for audiences 2 and 3.
-- Writes happen on the sandbox job only (plus one throwaway job and one
-- throwaway customer); everything is rolled back.

-- 1. The seed and the backfill, read as the system.
do $$
declare
  v_job uuid;
  v_n int;
begin
  perform pg_temp.dry_run_as_system();
  v_job := pg_temp.dry_run_sandbox_job();

  select count(*) into v_n from public.bill_to_customers;
  perform pg_temp.dry_run_check('the list holds the two seeded customers', v_n = 2,
    format('expected 2 rows, got %s', v_n));

  select count(*) into v_n from public.bill_to_customers
   where name in ('STG Windows and Doors', 'Strata')
     and billing_email is null and quickbooks_customer_id is null and retired_at is null;
  perform pg_temp.dry_run_check('seeded by name only: no email, no QuickBooks id', v_n = 2,
    format('expected 2 bare rows, got %s', v_n));

  select count(*) into v_n from public.bill_to_customers
   where is_default and name = 'STG Windows and Doors';
  perform pg_temp.dry_run_check('STG Windows and Doors is the one default', v_n = 1,
    format('expected 1, got %s', v_n));

  select count(*) into v_n from public.projects p
   where not exists (select 1 from public.project_bill_to b where b.project_id = p.id);
  perform pg_temp.dry_run_check('every existing job has a bill-to', v_n = 0,
    format('%s job(s) without one', v_n));

  select count(*) into v_n from public.project_bill_to b
    join public.bill_to_customers c on c.id = b.bill_to_customer_id
   where not c.is_default;
  perform pg_temp.dry_run_check('every existing job bills to the default', v_n = 0,
    format('%s job(s) on another customer', v_n));

  select count(*) into v_n from public.project_bill_to;
  perform pg_temp.dry_run_check('existing jobs defaulted (count)', v_n > 0,
    format('%s job(s) defaulted to STG Windows and Doors', v_n));

  select count(*) into v_n from public.project_bill_to where project_id = v_job;
  perform pg_temp.dry_run_check('the sandbox job has its bill-to row', v_n = 1,
    format('expected 1, got %s', v_n));

  select count(*) into v_n from public.project_bill_to_history;
  perform pg_temp.dry_run_check('nothing logged before anybody changed anything', v_n = 0,
    format('expected 0, got %s', v_n));

  select count(*) into v_n from public.app_release_notes
   where id = '2026-09-27-bill-to' and audience = array[2,3] and kind = 'improvement'
     and published_on = date '2026-09-27' and withdrawn_at is null and href = '/cost-codes'
     and title_en = 'Each job now says who it bills to'
     and title_es = 'Cada trabajo ahora dice a quién se le cobra'
     and length(body_en) > 0 and length(body_es) > 0;
  perform pg_temp.dry_run_check('the supervisor/owner note is stored as written', v_n = 1,
    format('expected 1 row for audiences 2 and 3, got %s', v_n));

  perform pg_temp.dry_run_as_system();
end $$;

-- 2. A supervisor (or the owner) runs the list and changes the sandbox job. The live
--    database may have nobody whose role is exactly "supervisor" (the first
--    run on 2026-09-28 stopped on that), so the legacy "admin" and then the
--    owner stand in: the same door, can_manage_bill_to(), lets all three in.
do $$
declare
  v_sup uuid;
  v_as text;
  v_job uuid;
  v_stg uuid;
  v_strata uuid;
  v_new public.bill_to_customers;
  v_row public.project_bill_to;
  v_n int;
  v_new_job uuid;
begin
  perform pg_temp.dry_run_as_system();
  foreach v_as in array array['supervisor', 'admin', 'owner'] loop
    begin
      v_sup := pg_temp.dry_run_pick(v_as);
    exception when others then
      v_sup := null;
    end;
    exit when v_sup is not null;
  end loop;
  if v_sup is null then
    raise exception 'dry run: nobody is a supervisor, an admin or an owner to act as';
  end if;
  perform pg_temp.dry_run_check(format('acting as a manager: role %s', v_as), true, null);
  v_job := pg_temp.dry_run_sandbox_job();
  select id into v_stg from public.bill_to_customers where is_default;
  select id into v_strata from public.bill_to_customers where name = 'Strata';

  perform pg_temp.dry_run_act_as(v_sup);
  perform pg_temp.dry_run_check('the manager may see and change bill-to',
    public.can_see_bill_to(auth.uid()) and public.can_manage_bill_to(auth.uid()), null);

  select count(*) into v_n from public.bill_to_customers;
  perform pg_temp.dry_run_check('the manager reads the list', v_n = 2,
    format('expected 2, got %s', v_n));
  select count(*) into v_n from public.project_bill_to where project_id = v_job;
  perform pg_temp.dry_run_check('the manager reads the sandbox job''s bill-to', v_n = 1,
    format('expected 1, got %s', v_n));

  -- Add a customer, the way the Cost codes card does.
  select * into v_new from public.save_bill_to_customer(null, '  Dry Run Billing Co ', '', '999999999');
  perform pg_temp.dry_run_check('save_bill_to_customer: adds a trimmed customer with its id',
    v_new.name = 'Dry Run Billing Co' and v_new.quickbooks_customer_id = '999999999'
      and v_new.billing_email is null and v_new.created_by = v_sup and not v_new.is_default,
    null);
  perform pg_temp.dry_run_expect_error('save_bill_to_customer: a second "strata" is refused',
    'select public.save_bill_to_customer(null, ''strata'', null, null)', 'already on the list');
  perform pg_temp.dry_run_expect_error('save_bill_to_customer: a QuickBooks id with letters is refused',
    'select public.save_bill_to_customer(null, ''Other Dry Run Co'', null, ''4a'')', 'digits only');

  -- Change the sandbox job to Strata: one row, one log line with who.
  v_row := public.set_project_bill_to(v_job, v_strata);
  perform pg_temp.dry_run_check('set_project_bill_to: the sandbox job now bills to Strata',
    v_row.bill_to_customer_id = v_strata and v_row.updated_by = v_sup, null);
  select count(*) into v_n from public.project_bill_to_history
   where project_id = v_job and from_customer_id = v_stg and to_customer_id = v_strata
     and changed_by = v_sup;
  perform pg_temp.dry_run_check('set_project_bill_to: logs who changed it, from and to', v_n = 1,
    format('expected 1 log line, got %s', v_n));

  -- The same choice again changes and logs nothing.
  perform public.set_project_bill_to(v_job, v_strata);
  select count(*) into v_n from public.project_bill_to_history where project_id = v_job;
  perform pg_temp.dry_run_check('set_project_bill_to: choosing the same customer logs nothing', v_n = 1,
    format('expected 1 log line, got %s', v_n));

  -- Retire the new customer: it can no longer be picked; bring it back.
  select * into v_new from public.set_bill_to_customer_retired(v_new.id, true);
  perform pg_temp.dry_run_check('set_bill_to_customer_retired: retires, never deletes',
    v_new.retired_at is not null and v_new.retired_by = v_sup, null);
  perform pg_temp.dry_run_expect_error('set_project_bill_to: a retired customer is refused',
    format('select public.set_project_bill_to(%L::uuid, %L::uuid)', v_job, v_new.id), 'retired');
  select * into v_new from public.set_bill_to_customer_retired(v_new.id, false);
  perform pg_temp.dry_run_check('set_bill_to_customer_retired: brings it back',
    v_new.retired_at is null, null);
  perform pg_temp.dry_run_expect_error('set_bill_to_customer_retired: the default cannot be retired',
    format('select public.set_bill_to_customer_retired(%L::uuid, true)', v_stg), 'cannot be retired');

  -- No direct writes, even for a supervisor.
  perform pg_temp.dry_run_expect_error('the manager cannot write the list directly',
    'insert into public.bill_to_customers (name) values (''Direct Dry Run Co'')', 'permission denied');
  perform pg_temp.dry_run_expect_error('the manager cannot write a job''s bill-to directly',
    format('update public.project_bill_to set bill_to_customer_id = %L::uuid where project_id = %L::uuid', v_stg, v_job),
    'permission denied');
  perform pg_temp.dry_run_expect_error('nobody deletes a customer',
    format('delete from public.bill_to_customers where id = %L::uuid', v_strata), 'permission denied');

  -- Back to the default: a second log line.
  perform public.set_project_bill_to(v_job, v_stg);
  select count(*) into v_n from public.project_bill_to_history where project_id = v_job;
  perform pg_temp.dry_run_check('set_project_bill_to: back to STG logs a second line', v_n = 2,
    format('expected 2 log lines, got %s', v_n));

  -- A job made the way the Jobs screen makes one is born on the default.
  insert into public.projects (job_code, name)
  values ('ZZDRYRUNBILLTO', 'Dry run bill-to job')
  returning id into v_new_job;
  select count(*) into v_n from public.project_bill_to
   where project_id = v_new_job and bill_to_customer_id = v_stg and updated_by is null;
  perform pg_temp.dry_run_check('a new job is born billing to STG Windows and Doors', v_n = 1,
    format('expected 1, got %s', v_n));

  perform pg_temp.dry_run_as_system();
end $$;

-- 3. The QA foreman and the QA installer: nothing to read, nothing to change.
do $$
declare
  v_person uuid;
  v_job uuid;
  v_strata uuid;
  v_role text;
  v_n int;
begin
  perform pg_temp.dry_run_as_system();
  v_job := pg_temp.dry_run_sandbox_job();
  select id into v_strata from public.bill_to_customers where name = 'Strata';

  foreach v_role in array array['foreman', 'installer'] loop
    perform pg_temp.dry_run_as_system();
    v_person := pg_temp.dry_run_pick(v_role);
    perform pg_temp.dry_run_act_as(v_person);

    select count(*) into v_n from public.bill_to_customers;
    perform pg_temp.dry_run_check(format('the QA %s reads no customers', v_role), v_n = 0,
      format('expected 0, got %s', v_n));
    select count(*) into v_n from public.project_bill_to;
    perform pg_temp.dry_run_check(format('the QA %s reads no job''s bill-to', v_role), v_n = 0,
      format('expected 0, got %s', v_n));
    select count(*) into v_n from public.project_bill_to_history;
    perform pg_temp.dry_run_check(format('the QA %s reads no change log', v_role), v_n = 0,
      format('expected 0, got %s', v_n));

    perform pg_temp.dry_run_expect_error(format('set_project_bill_to: the QA %s is refused', v_role),
      format('select public.set_project_bill_to(%L::uuid, %L::uuid)', v_job, v_strata),
      'supervisor or the owner');
    perform pg_temp.dry_run_expect_error(format('save_bill_to_customer: the QA %s is refused', v_role),
      'select public.save_bill_to_customer(null, ''QA Dry Run Co'', null, null)',
      'supervisor or the owner');
    perform pg_temp.dry_run_expect_error(format('set_bill_to_customer_retired: the QA %s is refused', v_role),
      format('select public.set_bill_to_customer_retired(%L::uuid, true)', v_strata),
      'supervisor or the owner');
  end loop;

  perform pg_temp.dry_run_as_system();
end $$;

-- 4. "Sees costs" opens reading, and nothing more. Granted to the QA foreman
--    inside this rolled-back batch only.
do $$
declare
  v_foreman uuid;
  v_job uuid;
  v_strata uuid;
  v_n int;
  v_had boolean;
  v_total int;
begin
  perform pg_temp.dry_run_as_system();
  v_foreman := pg_temp.dry_run_pick('foreman');
  v_job := pg_temp.dry_run_sandbox_job();
  select id into v_strata from public.bill_to_customers where name = 'Strata';
  select can_see_costs into v_had from public.profiles where id = v_foreman;
  -- Section 2 added one customer earlier in this same batch.
  select count(*) into v_total from public.bill_to_customers;
  update public.profiles set can_see_costs = true where id = v_foreman;

  perform pg_temp.dry_run_act_as(v_foreman);
  select count(*) into v_n from public.bill_to_customers;
  perform pg_temp.dry_run_check('with Sees costs, the QA foreman reads the list', v_n = v_total,
    format('expected %s, got %s', v_total, v_n));
  select count(*) into v_n from public.project_bill_to where project_id = v_job;
  perform pg_temp.dry_run_check('with Sees costs, the QA foreman reads the sandbox job''s bill-to', v_n = 1,
    format('expected 1, got %s', v_n));
  perform pg_temp.dry_run_expect_error('with Sees costs, the QA foreman still cannot change it',
    format('select public.set_project_bill_to(%L::uuid, %L::uuid)', v_job, v_strata),
    'supervisor or the owner');

  perform pg_temp.dry_run_as_system();
  update public.profiles set can_see_costs = v_had where id = v_foreman;
end $$;
