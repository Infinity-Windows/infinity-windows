-- Quality: install points are pending until QC signs off; quiz points confirm immediately.
alter table points_ledger
  add column if not exists status text not null default 'confirmed'
    check (status in ('pending','confirmed','void'));

create index if not exists points_ledger_ref_idx on points_ledger (ref);
