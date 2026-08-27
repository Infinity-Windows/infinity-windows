-- Wave T, T5: zero-gap unit switching.
--
-- CONTEXT.md's "Chain": "finishing a unit hands the running clock to the
-- next unit... rather than stopping it." The spec asks to VERIFY the
-- close+open already share one timestamp, and to add the invariant as a
-- test + comment if it already holds rather than building anything new.
--
-- It already holds, and it holds for a structural reason rather than by
-- coincidence: `start_unit_session` (20260820000000) does
--
--     perform _end_open_session(v_uid, 'handoff');   -- ended_at = now()
--     insert into unit_sessions (...) ...             -- started_at default now()
--
-- as two statements inside ONE plpgsql function body, called as ONE RPC —
-- i.e. one Postgres transaction. Postgres's `now()` is the transaction
-- timestamp, not the statement timestamp: it returns the exact same value
-- every time it is evaluated for the life of a transaction (this is
-- documented Postgres behaviour, not something this repo configures). So
-- `ended_at` on the outgoing session and `started_at` on the incoming one
-- are the same instant by construction, with no gap and no overlap to
-- reconcile. `finish_unit` and `block_unit`'s chain hand-offs go through
-- the same `start_unit_session` call, so the same guarantee covers Finish
-- and Block, exactly as CONTEXT.md's "Block hands off exactly the same
-- way" says it should.
--
-- The one thing that WOULD break this silently is any future edit that
-- swaps `now()` for `clock_timestamp()` (the statement-time equivalent)
-- anywhere in that path, or that splits the close and the open across two
-- separate transactions. Nothing here can catch that kind of edit ahead of
-- time without exercising `start_unit_session` itself end to end, which
-- needs a real authenticated session and real opening/profile rows this
-- migration does not have. What this DOES check, at every future deploy,
-- is the one primitive the whole guarantee rests on:

do $$
declare
  v1 timestamptz := now();
  v2 timestamptz;
begin
  perform pg_sleep(0.05);
  v2 := now();
  if v1 <> v2 then
    raise exception 'now() is no longer transaction-stable on this Postgres — the zero-gap chain invariant (Wave T, T5) depends on start_unit_session''s close and open sharing one now() value, and that assumption just broke.';
  end if;
end;
$$;
