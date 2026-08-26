-- Add a mark to a delivery that already exists (owner, 2026-08-26, from the
-- tailgate mid-pilot): the truck brings a set the manifest never listed, and
-- the crew adds it right there instead of logging a second delivery.
--
-- create_delivery_set already knows how to mint an expected set (it is what
-- the log-a-delivery wizard drives) but is deliberately not granted to
-- clients — it trusts its caller. This wrapper is the client door: it checks
-- the delivery really exists, holds the same foreman+ line the other
-- manifest edits hold (delete_packages), and forwards. Piece labels stay
-- skeleton-first: the boxes decide at the tailgate, same as the wizard.

create or replace function add_delivery_set(
  p_delivery uuid,
  p_project uuid,
  p_job_name text,
  p_mark text,
  p_kind text,
  p_package_count int,
  p_crate_name text default null,
  p_crate_pieces int default null,
  p_crate_part_type text default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'Only a foreman or above can add sets to a delivery.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from deliveries where id = p_delivery) then
    raise exception 'That delivery does not exist.';
  end if;
  if p_kind not in ('window', 'door') then
    raise exception 'A set is a window or a door.';
  end if;

  return public.create_delivery_set(
    p_delivery, p_project, p_mark, p_kind, p_package_count,
    p_crate_name, p_crate_pieces, p_crate_part_type,
    1, p_job_name, null
  );
end;
$$;

grant execute on function add_delivery_set(uuid, uuid, text, text, text, int, text, int, text) to authenticated;
