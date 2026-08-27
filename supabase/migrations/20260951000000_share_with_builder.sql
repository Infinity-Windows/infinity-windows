-- Wave S, S2: share-with-builder on the crew side.
--
-- Q14: neither a log's text nor its photos reach a builder until a
-- supervisor shares that day's log — ONE GATE for everything crew-made.
-- daily_logs.customer_visible/_at/_by have existed since wave L
-- (20260949000000) but nothing set or read them; this is the "set" half.
-- S3's projection RPC is the "read" half, and is the ONLY place a partner
-- ever sees what this flips — daily_logs itself stays walled off to a
-- partner regardless (THE WALL, S1, explicitly leaves daily_logs alone: its
-- existing my_role_rank() >= 1 policy already excludes a partner's pinned
-- installer rank, and a partner never gets any row from it either way).
--
-- Supervisor+, not foreman — a foreman may WRITE the log (file_daily_log),
-- but deciding whether an outside party reads it is a step up the ladder,
-- same rank _is_supervisor() already gates elsewhere (team timecard edits,
-- toolbox library management).

create or replace function public.set_log_customer_visible(p_log uuid, p_visible boolean)
returns daily_logs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row daily_logs;
begin
  if not _is_supervisor(auth.uid()) then
    raise exception 'only a supervisor or above can share a log with the builder';
  end if;

  -- Stamp _at/_by on the transition TO visible; leave them alone on hide, so
  -- a log shared and later hidden still remembers when it was last shared
  -- rather than losing that the moment it's pulled back.
  update daily_logs
     set customer_visible = p_visible,
         customer_visible_at = case when p_visible then now() else customer_visible_at end,
         customer_visible_by = case when p_visible then auth.uid() else customer_visible_by end
   where id = p_log
  returning * into v_row;

  if v_row.id is null then
    raise exception 'that log does not exist';
  end if;

  return v_row;
end;
$$;

comment on function public.set_log_customer_visible(uuid, boolean) is
  'Supervisor+: shares (or un-shares) one daily log with the builder login granted that job (Q14). The only writer of daily_logs.customer_visible/_at/_by — those columns have no direct-write grant, same house rule as file_daily_log for the rest of the row.';

revoke all on function public.set_log_customer_visible(uuid, boolean) from public, anon;
grant execute on function public.set_log_customer_visible(uuid, boolean) to authenticated;
