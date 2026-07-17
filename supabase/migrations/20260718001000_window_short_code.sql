-- Wave 1: hybrid identification. Every physical window keeps its QR + serial
-- license plate (W-<TYPE>-<SEQ>), and ALSO gets a short, hand-writable code so a
-- worker can scan the QR OR just write/type the code on the unit with a marker.
--
-- The code uses a no-ambiguous alphabet (no O/0/I/1) and is 6 chars long
-- (~1.07B combinations), unique per unit.

alter table windows add column if not exists short_code text;
create unique index if not exists windows_short_code_idx
  on windows(short_code) where short_code is not null;

-- Random 6-char code from a human-safe alphabet.
create or replace function gen_short_code(p_len int default 6)
returns text
language plpgsql
as $$
declare
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_out text := '';
  i int;
begin
  for i in 1..p_len loop
    v_out := v_out || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
  end loop;
  return v_out;
end;
$$;

-- Issue a code not already used by any unit.
create or replace function issue_window_short_code()
returns text
language plpgsql
as $$
declare v_code text;
begin
  loop
    v_code := gen_short_code(6);
    exit when not exists (select 1 from windows where short_code = v_code);
  end loop;
  return v_code;
end;
$$;

-- Backfill existing units.
do $$
declare r record;
begin
  for r in select id from windows where short_code is null loop
    update windows set short_code = issue_window_short_code() where id = r.id;
  end loop;
end;
$$;

-- Receive now also stamps a short code (retry on the rare unique collision).
create or replace function receive_window(
  p_type_id uuid,
  p_project_id uuid default null,
  p_actor text default null
)
returns windows
language plpgsql
as $$
declare
  v_window windows;
begin
  loop
    begin
      insert into windows (window_id, short_code, window_type_id, status, project_id)
      values (issue_window_id(p_type_id), issue_window_short_code(), p_type_id, 'inbound', p_project_id)
      returning * into v_window;
      exit;
    exception when unique_violation then
      -- extremely rare short_code collision; try again
    end;
  end loop;

  insert into movements (window_id, event, project_id, actor)
  values (v_window.id, 'received', p_project_id, p_actor);

  return v_window;
end;
$$;

-- Resolve a unit by its hand-writable short code OR its serial window_id.
create or replace function find_window_by_code(p_code text)
returns windows
language sql
stable
as $$
  select * from windows
  where upper(short_code) = upper(trim(p_code))
     or upper(window_id) = upper(trim(p_code))
  limit 1;
$$;
