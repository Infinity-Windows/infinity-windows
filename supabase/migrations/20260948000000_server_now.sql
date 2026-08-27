-- Wave T, T9: wrong-clock banner. A cheap RPC returning the server's clock,
-- for the client to diff against its own Date.now() — every timestamp this
-- whole wave writes (clock_in_at, edited_at, voided_at, signed_at, ...) is
-- `now()` on THIS server, never the device's clock, so a phone with a wrong
-- clock cannot actually corrupt a recorded time — but it can still make the
-- live timer on screen lie to the person looking at it, which is worth a
-- warning on its own.

create or replace function server_now()
returns timestamptz
language sql
stable
as $$
  select now();
$$;

grant execute on function server_now() to authenticated;
