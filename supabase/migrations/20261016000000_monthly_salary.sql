-- Pay stays dated and private. Salary is a calendar-month amount, never an
-- hourly rate; a new month must not reprice an older month's job records.
begin;
alter table public.pay_rates add column if not exists pay_basis text not null default 'hourly';
alter table public.pay_rates add column if not exists monthly_cents integer;
drop policy if exists pay_rates_select on public.pay_rates;
create policy pay_rates_select on public.pay_rates for select to authenticated using (
  not public.is_partner_user() and public.can_see_pay(auth.uid())
  and exists (select 1 from profiles where id = auth.uid()
    and access_revoked_at is null and retired_at is null)
);
alter table public.pay_rates drop constraint if exists pay_rates_basis_amount_check;
alter table public.pay_rates add constraint pay_rates_basis_amount_check check (
  (pay_basis = 'hourly' and monthly_cents is null)
  or (pay_basis = 'salary_monthly' and monthly_cents is not null and monthly_cents >= 0
      and hourly_cents = 0 and extract(day from effective_from) = 1)
);

create or replace function public.set_compensation(
  p_profile_id uuid, p_pay_basis text, p_amount_cents integer,
  p_effective_from date default null
) returns public.pay_rates language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_row pay_rates; v_from date;
begin
  if coalesce(public.my_role_rank(), -1) < 3 or public.is_partner_user()
     or not exists (select 1 from profiles where id = auth.uid()
       and access_revoked_at is null and retired_at is null) then
    raise exception 'Only a current owner can set pay.' using errcode = '42501';
  end if;
  if p_pay_basis is null or p_pay_basis not in ('hourly', 'salary_monthly')
     or p_amount_cents is null or p_amount_cents < 0 then
    raise exception 'Choose hourly or monthly salary and enter a valid amount.';
  end if;
  -- Lock the person so simultaneous changes cannot miss one another's dates.
  perform 1 from profiles where id = p_profile_id and retired_at is null
    and not coalesce(is_partner, false) for update;
  if not found then raise exception 'Choose a current crew member.'; end if;
  v_from := coalesce(p_effective_from, case when p_pay_basis = 'salary_monthly'
    then date_trunc('month', current_date)::date else current_date end);
  if p_pay_basis = 'salary_monthly' and extract(day from v_from) <> 1 then
    raise exception 'Salary changes start on the first day of a month.';
  end if;
  insert into pay_rates(profile_id, hourly_cents, pay_basis, monthly_cents, effective_from, set_by)
    values(p_profile_id, case when p_pay_basis = 'hourly' then p_amount_cents else 0 end,
      p_pay_basis, case when p_pay_basis = 'salary_monthly' then p_amount_cents else null end,
      v_from, auth.uid())
    on conflict(profile_id, effective_from) do update set
      hourly_cents = excluded.hourly_cents, pay_basis = excluded.pay_basis,
      monthly_cents = excluded.monthly_cents, set_by = excluded.set_by, created_at = now()
    returning * into v_row;
  -- Check both neighbors, including future rates and backdated edits. The
  -- initial version deliberately has no hidden mid-month proration rule.
  if exists (select 1 from (
      select effective_from, pay_basis,
        lag(pay_basis) over(order by effective_from) as previous_basis
      from pay_rates where profile_id = p_profile_id
    ) history where (pay_basis = 'salary_monthly' or previous_basis = 'salary_monthly')
      and extract(day from effective_from) <> 1) then
    raise exception 'Switching to or from salary must start on the first day of a month. Check later rates too.';
  end if;
  return v_row;
end;
$$;
revoke all on function public.set_compensation(uuid, text, integer, date) from public, anon;
grant execute on function public.set_compensation(uuid, text, integer, date) to authenticated;

-- Older clients must pass the same salary boundary check.
create or replace function public.set_pay_rate(p_profile_id uuid, p_hourly_cents integer,
  p_effective_from date default current_date)
returns public.pay_rates language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  return public.set_compensation(p_profile_id, 'hourly', p_hourly_cents, p_effective_from);
end;
$$;
revoke all on function public.set_pay_rate(uuid, integer, date) from public, anon;
grant execute on function public.set_pay_rate(uuid, integer, date) to authenticated;
comment on table public.pay_rates is 'Private dated compensation history: hourly pay or fixed calendar-month salary. Owners set rates; existing pay visibility grants control reads.';
commit;
