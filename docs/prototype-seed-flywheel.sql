-- Demo data for the learning flywheel + training: attribute the seeded install
-- events to real profiles (so leaderboard + skill matrix populate) and add a
-- sample clearance so training visibly changes dispatch. Safe to re-run.

update install_events e set installer_id = p.id
from profiles p
where e.installer_id is null and (
  (e.installer = 'jamie@crew' and p.display_name = 'Maria') or
  (e.installer = 'alex@crew'  and p.display_name = 'Ammon') or
  (e.installer = 'sam@crew'   and p.display_name = 'Sam')
);

-- Recompute rollups + golden picks for affected types.
do $$ declare r record; begin
  for r in select distinct window_type_id from install_events where window_type_id is not null loop
    perform recompute_window_type_rollups(r.window_type_id);
    perform pick_golden_install(r.window_type_id);
  end loop;
end; $$;

-- Clear the apprentice (Chris) on CAS3050 so dispatch can route him there.
insert into installer_clearance (installer_id, window_type_id, cleared_by)
select (select id from profiles where display_name = 'Chris'),
       (select id from window_types where type_code = 'CAS3050'),
       (select id from profiles where display_name = 'Taylor')
where exists (select 1 from profiles where display_name = 'Chris')
on conflict do nothing;
