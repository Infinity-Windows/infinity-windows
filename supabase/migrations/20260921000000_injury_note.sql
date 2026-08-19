-- Injury note on clock-out (owner ask, 2026-08-19): ticking "I was injured
-- this shift" now opens a "What happened?" box, and the answer lands on the
-- shift where the office reads it. The UI carries the plain warning "(If
-- this is an emergency immediately call 911)" — the app is a record, never
-- the emergency channel.
--
-- clock_out is rebuilt from its CURRENT body (20260718040000) with one new
-- defaulted arg; the old signature is dropped in the same migration (the
-- overload lesson) so stale bundles resolve to this one function.

alter table time_shifts add column if not exists injury_note text;

drop function if exists clock_out(uuid, text, boolean, boolean, int, double precision, double precision);

create or replace function clock_out(
  p_shift_id uuid,
  p_photo text default null,
  p_injured boolean default false,
  p_time_confirmed boolean default true,
  p_break_seconds int default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_injury_note text default null
)
returns time_shifts language plpgsql as $$
declare v_shift time_shifts;
begin
  update time_shifts
  set clock_out_at = now(),
      clock_out_photo = coalesce(p_photo, clock_out_photo),
      injured = p_injured,
      injury_note = case when p_injured then nullif(trim(coalesce(p_injury_note, '')), '') else null end,
      time_confirmed = p_time_confirmed,
      break_seconds = coalesce(p_break_seconds, break_seconds),
      break_started_at = null,
      break_type = null,
      clock_out_lat = coalesce(p_lat, clock_out_lat),
      clock_out_lng = coalesce(p_lng, clock_out_lng),
      signed_at = now(),
      status = 'submitted'
  where id = p_shift_id and profile_id = auth.uid()
  returning * into v_shift;
  if v_shift is null then raise exception 'no open shift %', p_shift_id; end if;
  return v_shift;
end;
$$;
