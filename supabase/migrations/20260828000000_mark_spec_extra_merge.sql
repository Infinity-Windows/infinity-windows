-- Two spec-review fields could silently erase each other's work.
--
-- `project_mark_specs.extra` is one jsonb blob holding several independent
-- fields. The size-code box and the Inset/Outset dropdown each read the blob
-- as it stood when their row was drawn, changed ONE key, and wrote the WHOLE
-- blob back — an UPDATE is a full column replace, not a merge. So fixing a
-- size code and then picking Inset/Outset before the first save landed made
-- the second save (built from a stale copy) wipe out the first. No error, no
-- sign. Inset/Outset feeds the signature a unit's cohort is keyed by and is
-- never recalculated anywhere else, so a dropped pick just stayed dropped.
--
-- The client was made to re-read fresh state right before saving, which
-- NARROWS the window but cannot close it: two saves can still interleave
-- between the read and the write. Only the database can make it atomic, which
-- is what this does — read, merge and write happen inside one statement, so
-- concurrent edits to DIFFERENT keys both survive by construction.

/**
 * Merge a patch into a mark spec's `extra`, atomically.
 *
 * `||` is jsonb's shallow merge: keys in the patch win, every other key is
 * left exactly as it was. That is the whole point — a field that knows about
 * one key can no longer speak for the others.
 *
 * `p_drop` names keys to REMOVE. The two callers need it: clearing the size
 * mismatch, or setting Inset/Outset back to blank, means the key should be
 * gone rather than present-and-null, because `hasAnySpec` and the signature
 * builder both read a present key as a value.
 *
 * Marks the row `source = 'manual'` like the plain update it replaces — a
 * human touched this, so a re-extract must not silently overwrite it.
 *
 * SECURITY DEFINER, so it must re-check the role ITSELF. The table's update
 * policy is foreman+ (`mark_specs_update_foreman`), and a definer function
 * bypasses RLS entirely — checking only "are you signed in" would quietly hand
 * every installer the ability to edit mark specs, which is exactly the gate
 * this table sets. The check below mirrors the policy it stands in for.
 */
create or replace function merge_mark_spec_extra(
  p_id uuid,
  p_patch jsonb default '{}'::jsonb,
  p_drop text[] default '{}'::text[]
)
returns project_mark_specs
language plpgsql
security definer
as $$
declare
  v_row project_mark_specs;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  if not public.is_foreman_plus(auth.uid()) then
    raise exception 'only a foreman-level user or above can edit mark specs';
  end if;

  update project_mark_specs
  set extra = (coalesce(extra, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb))
              - coalesce(p_drop, '{}'::text[]),
      source = 'manual'
  where id = p_id
  returning * into v_row;

  if not found then
    raise exception 'that mark spec no longer exists';
  end if;
  return v_row;
end;
$$;

comment on function merge_mark_spec_extra(uuid, jsonb, text[]) is
  'Atomically merge keys into project_mark_specs.extra. Replaces a read-modify-write from the client, where two fields sharing the blob could overwrite each other.';
