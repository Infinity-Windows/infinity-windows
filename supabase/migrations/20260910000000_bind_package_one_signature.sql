-- HOTFIX, same day as 20260908 (ticket 17), found by probing production.
--
-- `create or replace` only replaces a function with the IDENTICAL argument
-- list. Adding p_boneyard (with a default) created an OVERLOAD instead: the
-- 10-argument bind_package from 20260825 and the 11-argument one from
-- 20260908 both live, and any call that names neither more nor fewer than
-- the shared arguments matches BOTH. Postgres refuses to pick
-- ("Could not choose the best candidate function") — so every phone still
-- running the pre-boneyard bundle had tagging BROKEN, failing with an
-- overload error instead of binding.
--
-- 20260823 knew this rule and dropped its 6-arg predecessor. 20260902 knew
-- it and dropped the 6-arg save_storage_container. 20260908 forgot, and the
-- probe caught it within the hour.
--
-- The fix is the same as both precedents: exactly one signature survives.
-- With the 10-arg gone, a stale bundle's 10-named-argument call resolves
-- onto the 11-arg function through p_boneyard's default — the same
-- resolution the ticket-12 probe already proved works for
-- save_storage_container.
drop function if exists bind_package(
  uuid, uuid, text, text, text[], uuid, int, int, text, text
);
