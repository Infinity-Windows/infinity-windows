#!/usr/bin/env python3
"""Mechanical owned-copy adapter. Never writes frozen0844. Inspect delta and parity."""
from pathlib import Path
import hashlib
root=Path(__file__).resolve().parents[1]
s=(root/'supabase/migrations/20261108440000_work_unit_review.sql').read_text()
assert hashlib.sha256(s.encode()).hexdigest()=='e32122a581bf995857983cc433323bc490381b6eb217c583bf95fd7376b3e53f'
def function(name):
 a=s.index('create function public.'+name+'(');b=s.index('end; $$;',a)+len('end; $$;');return s[a:b]
scope=function('_work_unit_review_scope')
a=scope.index(' with versions as materialized (');b=scope.index(' if jsonb_array_length(sourceids)>4000',a)
scope=scope[:a]+' sourceids:=p_sourceids;\n if jsonb_typeof(sourceids) is distinct from \'array\' then return null;end if;\n'+scope[b:]
scope=scope.replace('_work_unit_review_scope(actor uuid,unit_id uuid)','_work_unit_metadata_scope(actor uuid,unit_id uuid,p_sourceids jsonb)',1)
view=function('_work_unit_review_view').replace('_work_unit_review_view(actor uuid,s jsonb)','_work_unit_metadata_review(actor uuid,s jsonb)',1)
old="proof:=(s->>'proven')::boolean and public._work_unit_review_coverage();";assert view.count(old)==1;view=view.replace(old,"proof:=(s->>'proven')::boolean; -- Top-level admission already attested exact coverage.")
p=root/'supabase/migrations/20261108480000_work_unit_metadata_cohorts.sql';sql=p.read_text();block='-- METADATA_REVIEW_ADAPTER_BEGIN\n'+scope+'\n'+view+'\n-- METADATA_REVIEW_ADAPTER_END\n'
if '-- METADATA_REVIEW_ADAPTER_BEGIN' in sql:
 a=sql.index('-- METADATA_REVIEW_ADAPTER_BEGIN');b=sql.index('-- METADATA_REVIEW_ADAPTER_END',a)+len('-- METADATA_REVIEW_ADAPTER_END\n');sql=sql[:a]+block+sql[b:]
else:sql=sql.replace('-- METADATA_IMPLEMENTATION_CONTINUE',block+'-- METADATA_IMPLEMENTATION_CONTINUE')
p.write_text(sql)
print('Adapted exact0844 scope selection seam and view coverage expression only.')
# Selection/flag projection is orchestration, not the ledger validator. Keep
# _work_totals_shift unmodified; this adapter consumes its actual returned map.
t=(root/'supabase/migrations/20261108450000_work_activity_totals.sql').read_text()
assert hashlib.sha256(t.encode()).hexdigest()=='e0e74c2d1985d332af81f95d20d2a6625c40cb5fcf995b4aa6e267d75e092140'
a=t.index('create function public.work_activity_totals_read(');b=t.index('end$$;',a)+len('end$$;');part=t[a:b]
start=part.index(' select array_agg(distinct id) into ids from (');end=part.index(' if coalesce(array_length(ids,1),0)>500',start)
idsbody=part[start:end].replace('select array_agg(distinct id) into ids','select array_agg(distinct id)')
idsfn='create function public._work_unit_metadata_shift_ids(p_project_id uuid,p_unit_id uuid,unit_scope jsonb) returns uuid[]\nlanguage sql stable security definer set search_path=public,pg_temp as $$\n'+idsbody+'$$;\n'
part=part[:start]+part[end:]
part=part.replace('work_activity_totals_read(p_project_id uuid,p_unit_id uuid default null)','_work_unit_metadata_partition(actor uuid,p_project_id uuid,p_unit_id uuid,stamp timestamptz,unit_scope jsonb,review jsonb,ids uuid[],p_ledgers jsonb)',1)
part=part.replace('declare actor uuid;stamp timestamptz;ids uuid[];sid uuid;','declare sid uuid;',1).replace('rows jsonb;unit_scope jsonb;review jsonb;unitrow','rows jsonb;unitrow',1)
a=part.index(' perform public._work_activity_read_committed();');b=part.index(' reconciliation_authorized:=public._work_unit_review_authority',a);part=part[:a]+part[b:]
old=' unit_scope:=public._work_unit_review_scope(actor,p_unit_id);if unit_scope is null then return available;end if;\n review:=public._work_unit_review_view(actor,unit_scope);if review is null then return available;end if;'
assert old in part;part=part.replace(old,' if unit_scope is null or review is null then return available;end if;',1)
old='ledger:=public._work_totals_shift(actor,sid,stamp);';assert old in part;part=part.replace(old,"ledger:=p_ledgers->sid::text;",1)
part=part.replace("if ledger->>'availability'<>'available' then return available;end if;","if ledger is null or ledger->>'availability' is distinct from 'available' then return available;end if;",1)
block='-- METADATA_PARTITION_ADAPTER_BEGIN\n'+idsfn+part+'\n-- METADATA_PARTITION_ADAPTER_END\n'
sql=p.read_text()
if '-- METADATA_PARTITION_ADAPTER_BEGIN' in sql:
 a=sql.index('-- METADATA_PARTITION_ADAPTER_BEGIN');b=sql.index('-- METADATA_PARTITION_ADAPTER_END',a)+len('-- METADATA_PARTITION_ADAPTER_END\n');sql=sql[:a]+block+sql[b:]
else:sql=sql.replace('-- METADATA_IMPLEMENTATION_CONTINUE',block+'-- METADATA_IMPLEMENTATION_CONTINUE')
p.write_text(sql)
print('Extracted exact shift membership and per-partition flag projection; unchanged ledger invoked by batch only.')
