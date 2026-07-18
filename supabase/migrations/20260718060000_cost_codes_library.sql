-- Global cost-code library: richer management fields on the existing
-- cost_codes table (from 20260717001000_time_clock.sql). Everything here is
-- idempotent so it's safe to re-run. No behaviour change for clock-in — it
-- already reads active cost_codes; this just adds an optional description, an
-- explicit sort order for the picker/management list, and audit timestamps.

alter table cost_codes
  add column if not exists description text,
  add column if not exists sort_order int not null default 0,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- Seed a sensible initial order for any rows that predate sort_order (all 0):
-- keep them in code order so the library reads top-to-bottom the same as before.
with ordered as (
  select id, row_number() over (order by code) * 10 as rn
  from cost_codes
)
update cost_codes c
set sort_order = ordered.rn
from ordered
where c.id = ordered.id
  and c.sort_order = 0;

-- Keep updated_at fresh on edits (used by the management UI's "last changed").
create or replace function set_cost_codes_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_cost_codes_updated on cost_codes;
create trigger trg_cost_codes_updated
  before update on cost_codes
  for each row execute function set_cost_codes_updated_at();

-- Helpful index for the ordered library/picker reads.
create index if not exists cost_codes_sort_idx on cost_codes (sort_order, code);
