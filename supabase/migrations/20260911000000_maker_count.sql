-- Ticket 20 (second half): the maker's label disagrees, on the record.
--
-- Ticket 15 settled the policy — the maker's printed "of M" WINS a
-- disagreement with the declared N — but gave the fact nowhere to live: the
-- truck saw "2/3" printed on the box while our sticker said "2 of 4", and the
-- only trace was a toast telling somebody to mention it. A fact that matters
-- gets a column.
--
-- mfr_part_total is what the maker's own label claims the window ships as.
-- Null means "label agrees or nobody looked" — the overwhelmingly common
-- case. When set and different from part_total, the parts math surfaces it
-- everywhere parts already show (the window's spec page, the plan panel, the
-- warehouse Find answer), which is where a foreman settles it: burn the wrong
-- labels, mint the right count.
alter table packages add column if not exists mfr_part_total int;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'packages_mfr_part_total_ck') then
    alter table packages add constraint packages_mfr_part_total_ck
      check (mfr_part_total is null or mfr_part_total >= 1);
  end if;
end;
$$;

-- Any signed-in crew: whoever is at the truck is who saw the label (the same
-- rule tagging and receiving follow). Null clears it — a misread happens.
-- No movement row: recording what a label says is not moving anything, the
-- same reasoning areas used (ADR-0006).
create or replace function report_maker_count(p_package uuid, p_total int)
returns packages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row packages;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if p_total is not null and p_total < 1 then
    raise exception 'a package count starts at 1';
  end if;

  update packages set mfr_part_total = p_total
  where id = p_package and status <> 'blank'
  returning * into v_row;
  if not found then
    raise exception 'that sticker is not on a package yet';
  end if;
  return v_row;
end;
$$;
