-- Closed-catalog guardrail: distinguish the ~100 real catalog products from
-- window_types rows created ad hoc from a job plan-set spec extract.
alter table window_types add column if not exists provisional boolean not null default false;

-- Backfill: anything that is not one of the closed catalog code families
-- (SH/DH/CAS/AWN/HOP/TRANS/SL/PIC/GAR/BAY/BOW + digits) was created ad hoc
-- from a plan-set spec extract. Flag it so it no longer masquerades as a
-- real catalog product in the brain/catalog surfaces.
update window_types
set provisional = true
where type_code !~ '^(SH|DH|CAS|AWN|HOP|TRANS|SL|PIC|GAR|BAY|BOW)[0-9]+$';

create index if not exists window_types_provisional_idx on window_types(provisional);

comment on column window_types.provisional is
  'true = created ad hoc from a job plan-set spec extract (not part of the closed ~100 catalog). Excluded from catalog/brain browsing.';
