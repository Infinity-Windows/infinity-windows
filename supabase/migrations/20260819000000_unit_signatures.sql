-- The SIGNATURE (spec: .scratch/signature/spec.md, ADR-0002): the
-- computed cohort key each unit is grouped by for estimating. Stored on
-- the opening (1:1 — a separate table would add a join for nothing).
--
-- Drift control: the client computes the signature (story is derived from
-- client-side trace geometry, so full server recomputation isn't possible
-- today) — but the SERVER owns the canonical encoding and the shape
-- validation. A client can hand over a signature object; it can never
-- hand over a malformed one or a mislabeled key.

alter table project_openings
  add column if not exists signature jsonb,
  add column if not exists sig_key text,
  add column if not exists sig_computed_at timestamptz;

create index if not exists project_openings_sig_key_idx
  on project_openings (sig_key) where sig_key is not null;

-- Canonical JSON: keys sorted alphabetically at every level, no
-- whitespace, arrays in order. MUST match canonicalJson in
-- app/src/lib/estimate/signature.ts — the shared window-16 fixture in
-- that file's tests is the cross-implementation pin.
create or replace function canonical_jsonb(j jsonb)
returns text
language plpgsql
immutable
as $$
declare
  k text;
  parts text[] := '{}';
  elem jsonb;
begin
  case jsonb_typeof(j)
    when 'object' then
      for k in select key from jsonb_object_keys(j) as key order by key collate "C" loop
        parts := parts || (to_jsonb(k)::text || ':' || canonical_jsonb(j -> k));
      end loop;
      return '{' || array_to_string(parts, ',') || '}';
    when 'array' then
      for elem in select value from jsonb_array_elements(j) as value loop
        parts := parts || canonical_jsonb(elem);
      end loop;
      return '[' || array_to_string(parts, ',') || ']';
    else
      -- scalars (string, number, boolean, null): jsonb's own compact text
      return j::text;
  end case;
end;
$$;

-- Store a unit's signature. The server derives sig_key itself from the
-- object (never trusts a client-sent key) and validates the v1 shape.
create or replace function set_unit_signature(p_opening_id uuid, p_signature jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  -- v1 shape gates: versioned, computed, categorical — never free text.
  if (p_signature ->> 'v') is distinct from '1' then
    raise exception 'unknown signature version';
  end if;
  if (p_signature ->> 'kind') not in ('window', 'door') then
    raise exception 'kind must be window or door';
  end if;
  if (p_signature ->> 'corner') not in ('none', 'corner') then
    raise exception 'corner must be none or corner';
  end if;
  if jsonb_typeof(p_signature -> 'tiers') is distinct from 'array'
     or jsonb_array_length(p_signature -> 'tiers') < 1 then
    raise exception 'signature needs at least one tier';
  end if;
  if (p_signature ->> 'insetOutset') is not null
     and (p_signature ->> 'insetOutset') not in ('inset', 'outset') then
    raise exception 'insetOutset must be inset, outset or null';
  end if;
  if jsonb_typeof(p_signature -> 'panelCount') is distinct from 'number'
     or jsonb_typeof(p_signature -> 'movingCount') is distinct from 'number' then
    raise exception 'panelCount and movingCount must be numbers';
  end if;

  v_key := canonical_jsonb(p_signature);

  update project_openings
  set signature = p_signature,
      sig_key = v_key,
      sig_computed_at = now()
  where id = p_opening_id;
  if not found then
    raise exception 'opening not found';
  end if;
end;
$$;

grant execute on function set_unit_signature(uuid, jsonb) to authenticated;
