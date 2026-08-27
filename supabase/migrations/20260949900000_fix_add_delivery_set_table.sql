-- add_delivery_set (20260938000000) guards that the delivery really exists
-- before forwarding to create_delivery_set — but the guard checked a table
-- named `deliveries`, which has never existed. The trucks live in
-- package_deliveries (20260814000000_storage_tracking.sql), the table every
-- other delivery RPC uses. So every call died with `relation "deliveries"
-- does not exist` before it could do anything. Same function, same rules —
-- the guard just looks at the real table now.

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
  if not exists (select 1 from package_deliveries where id = p_delivery) then
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
