-- Operational rollback for the owner pilot. No historical choices or work
-- records are changed; the next admission read returns false for everybody.
begin;
update public.redesign_pilot_accounts set enabled=false where enabled;
commit;
