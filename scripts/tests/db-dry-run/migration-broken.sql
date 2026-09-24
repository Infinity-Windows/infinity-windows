-- The shape of the two incidents: a migration that applies its DDL fine and
-- then, in its own data step, hits a constraint only the real database has.
-- Here the constraint is the one migration.sql created a moment earlier.
insert into public.demo_notes (author, project_id, body)
values ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000090',
        'this body is longer than twenty characters');
