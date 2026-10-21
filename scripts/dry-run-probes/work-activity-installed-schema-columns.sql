-- Exact schema shape only, after unchanged private0840 inside forced rollback.
-- No operational rows, sequence last values, routine bodies or raw proconfig.
-- Potential code-sensitive default/CHECK/index/view literals are hashed. Safe
-- simple PK/UNIQUE/FK and nonexpression/nonpartial index definitions are emitted.
-- This is reconstruction evidence, not a full-schema/runtime parity claim.
do $$
declare catalog jsonb; encoded text; checksum text; parts integer; i integer;
begin
  perform pg_temp.dry_run_as_system();
  with relations as (
    select c.*,n.nspname schema_name from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where (n.nspname='public' and c.relkind in ('r','p','v','m','f','c','S')) or c.oid='auth.users'::regclass
  ), user_types as (
    select t.*,n.nspname schema_name from pg_type t join pg_namespace n on n.oid=t.typnamespace
    where n.nspname='public' and (t.typtype in ('e','d','r','m') or (t.typtype='c' and exists(select 1 from pg_class c where c.oid=t.typrelid and c.relkind='c')))
  )
  select jsonb_build_object(
    'scope','All public relation/type structures plus auth.users; unchanged private0840 staged; no operational records.',
    'serverVersionNum',current_setting('server_version_num'),
    'schemas',(select jsonb_agg(jsonb_build_object('name',nspname,'owner',pg_get_userbyid(nspowner),'acl',nspacl) order by nspname)
      from pg_namespace where nspname in ('public','auth','extensions','storage')),
    'extensions',(select coalesce(jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,'schema',n.nspname,
      'relocatable',e.extrelocatable,'owner',pg_get_userbyid(e.extowner)) order by e.extname),'[]'::jsonb)
      from pg_extension e join pg_namespace n on n.oid=e.extnamespace),
    'relations',(select coalesce(jsonb_agg(jsonb_build_object('schema',r.schema_name,'name',r.relname,'kind',r.relkind,
      'owner',pg_get_userbyid(r.relowner),'acl',r.relacl,'rls',r.relrowsecurity,'forceRls',r.relforcerowsecurity,
      'persistence',r.relpersistence,'replicaIdentity',r.relreplident,'isPartition',r.relispartition,
      'partitionKeySha256',case when r.relkind='p' then encode(sha256(convert_to(pg_get_partkeydef(r.oid),'UTF8')),'hex') end,
      'partitionBoundSha256',case when r.relispartition then encode(sha256(convert_to(pg_get_expr(r.relpartbound,r.oid),'UTF8')),'hex') end,
      'viewDefinitionSha256',case when r.relkind in ('v','m') then encode(sha256(convert_to(pg_get_viewdef(r.oid,false),'UTF8')),'hex') end,
      'optionsSha256',case when r.reloptions is not null then encode(sha256(convert_to(r.reloptions::text,'UTF8')),'hex') end)
      order by r.schema_name,r.relname),'[]'::jsonb) from relations r),
    'columns',(select coalesce(jsonb_agg(jsonb_build_object('schema',r.schema_name,'relation',r.relname,'number',a.attnum,
      'name',a.attname,'dropped',a.attisdropped,'typeSchema',tn.nspname,'typeName',t.typname,'typeSql',format_type(a.atttypid,a.atttypmod),
      'typeModifier',a.atttypmod,'dimensions',a.attndims,'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
      'collationSchema',cn.nspname,'collation',co.collname,'acl',a.attacl,'storage',a.attstorage,'compression',a.attcompression,
      'hasDefault',a.atthasdef,'defaultSha256',case when d.oid is not null then encode(sha256(convert_to(pg_get_expr(d.adbin,d.adrelid,false),'UTF8')),'hex') end,
      'defaultCharacters',case when d.oid is not null then length(pg_get_expr(d.adbin,d.adrelid,false)) end)
      order by r.schema_name,r.relname,a.attnum),'[]'::jsonb)
      from relations r join pg_attribute a on a.attrelid=r.oid and a.attnum>0
      left join pg_type t on t.oid=a.atttypid left join pg_namespace tn on tn.oid=t.typnamespace
      left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      left join pg_collation co on co.oid=a.attcollation left join pg_namespace cn on cn.oid=co.collnamespace),
    'constraints',(select coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'relationSchema',r.schema_name,'relation',r.relname,
      'typeSchema',tn.nspname,'typeName',t.typname,'name',c.conname,'kind',c.contype,'deferrable',c.condeferrable,
      'initiallyDeferred',c.condeferred,'validated',c.convalidated,'local',c.conislocal,'inheritCount',c.coninhcount,'noInherit',c.connoinherit,
      'columns',c.conkey,'parentSchema',pn.nspname,'parentRelation',pr.relname,'parentColumns',c.confkey,
      'deleteAction',c.confdeltype,'updateAction',c.confupdtype,'matchType',c.confmatchtype,
      'definition',case when c.contype in ('p','u','f') then pg_get_constraintdef(c.oid,false) end,
      'definitionSha256',encode(sha256(convert_to(pg_get_constraintdef(c.oid,false),'UTF8')),'hex'),
      'definitionCharacters',length(pg_get_constraintdef(c.oid,false))) order by n.nspname,coalesce(r.relname,t.typname),c.conname),'[]'::jsonb)
      from pg_constraint c join pg_namespace n on n.oid=c.connamespace
      left join relations r on r.oid=c.conrelid left join pg_type t on t.oid=c.contypid left join pg_namespace tn on tn.oid=t.typnamespace
      left join pg_class pr on pr.oid=c.confrelid left join pg_namespace pn on pn.oid=pr.relnamespace
      where r.oid is not null or c.contypid in (select oid from user_types)),
    'indexes',(select coalesce(jsonb_agg(jsonb_build_object('schema',r.schema_name,'relation',r.relname,'name',ix.relname,
      'method',am.amname,'unique',x.indisunique,'nullsNotDistinct',x.indnullsnotdistinct,'primary',x.indisprimary,
      'exclusion',x.indisexclusion,'immediate',x.indimmediate,'valid',x.indisvalid,'ready',x.indisready,'live',x.indislive,
      'keyCount',x.indnkeyatts,'attributeCount',x.indnatts,'columns',x.indkey::smallint[],'options',x.indoption::smallint[],
      'collations',(select jsonb_agg(coalesce(ns.nspname||'.'||co.collname,'-') order by z.ordinality)
        from unnest(x.indcollation::oid[]) with ordinality z(oid,ordinality) left join pg_collation co on co.oid=z.oid left join pg_namespace ns on ns.oid=co.collnamespace),
      'operatorClasses',(select jsonb_agg(ns.nspname||'.'||oc.opcname order by z.ordinality)
        from unnest(x.indclass::oid[]) with ordinality z(oid,ordinality) join pg_opclass oc on oc.oid=z.oid join pg_namespace ns on ns.oid=oc.opcnamespace),
      'hasExpression',x.indexprs is not null,'hasPredicate',x.indpred is not null,
      'definition',case when x.indexprs is null and x.indpred is null and ix.reloptions is null then pg_get_indexdef(x.indexrelid,0,false) end,
      'definitionSha256',encode(sha256(convert_to(pg_get_indexdef(x.indexrelid,0,false),'UTF8')),'hex'),
      'expressionSha256',case when x.indexprs is not null then encode(sha256(convert_to(pg_get_expr(x.indexprs,x.indrelid,false),'UTF8')),'hex') end,
      'predicateSha256',case when x.indpred is not null then encode(sha256(convert_to(pg_get_expr(x.indpred,x.indrelid,false),'UTF8')),'hex') end)
      order by r.schema_name,r.relname,ix.relname),'[]'::jsonb)
      from pg_index x join relations r on r.oid=x.indrelid join pg_class ix on ix.oid=x.indexrelid join pg_am am on am.oid=ix.relam),
    'types',(select coalesce(jsonb_agg(jsonb_build_object('schema',t.schema_name,'name',t.typname,'kind',t.typtype,
      'owner',pg_get_userbyid(t.typowner),'acl',t.typacl,'notNull',t.typnotnull,'baseType',case when t.typbasetype<>0 then format_type(t.typbasetype,t.typtypmod) end,
      'defaultSha256',case when t.typdefaultbin is not null then encode(sha256(convert_to(pg_get_expr(t.typdefaultbin,0,false),'UTF8')),'hex') end,
      'enumLabels',(select jsonb_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid),
      'rangeSubtype',case when rg.rngsubtype is not null then format_type(rg.rngsubtype,null) end,
      'rangeMultirangeType',case when rg.rngmultitypid is not null then format_type(rg.rngmultitypid,null) end,
      'rangeCanonical',case when rg.rngcanonical<>0 then rg.rngcanonical::regproc::text end,
      'rangeSubtypeDiff',case when rg.rngsubdiff<>0 then rg.rngsubdiff::regproc::text end)
      order by t.schema_name,t.typname),'[]'::jsonb) from user_types t left join pg_range rg on rg.rngtypid=t.oid),
    'sequences',(select coalesce(jsonb_agg(jsonb_build_object('schema',r.schema_name,'name',r.relname,'dataType',format_type(s.seqtypid,null),
      'start',s.seqstart,'increment',s.seqincrement,'minimum',s.seqmin,'maximum',s.seqmax,'cache',s.seqcache,'cycle',s.seqcycle,
      'ownedBy',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'relation',c.relname,'column',a.attname,'dependencyKind',d.deptype) order by n.nspname,c.relname,a.attnum)
        from pg_depend d join pg_class c on c.oid=d.refobjid join pg_namespace n on n.oid=c.relnamespace
        join pg_attribute a on a.attrelid=c.oid and a.attnum=d.refobjsubid
        where d.classid='pg_class'::regclass and d.objid=r.oid and d.refclassid='pg_class'::regclass and d.deptype in ('a','i')))
      order by r.schema_name,r.relname),'[]'::jsonb) from relations r join pg_sequence s on s.seqrelid=r.oid),
    'policies',(select coalesce(jsonb_agg(jsonb_build_object('schema',r.schema_name,'relation',r.relname,'name',p.polname,
      'command',p.polcmd,'permissive',p.polpermissive,'roles',(select jsonb_agg(case when x=0 then 'PUBLIC' else pg_get_userbyid(x) end order by x) from unnest(p.polroles) x),
      'usingSha256',case when p.polqual is not null then encode(sha256(convert_to(pg_get_expr(p.polqual,p.polrelid,false),'UTF8')),'hex') end,
      'checkSha256',case when p.polwithcheck is not null then encode(sha256(convert_to(pg_get_expr(p.polwithcheck,p.polrelid,false),'UTF8')),'hex') end)
      order by r.schema_name,r.relname,p.polname),'[]'::jsonb) from pg_policy p join relations r on r.oid=p.polrelid)
  ) into catalog;
  encoded:=catalog::text; checksum:=encode(sha256(convert_to(encoded,'UTF8')),'hex'); parts:=ceil(length(encoded)/450.0)::integer;
  perform pg_temp.dry_run_check('schemaShapeHeader',true,jsonb_build_object('sha256',checksum,'characters',length(encoded),'parts',parts,
    'relations',jsonb_array_length(catalog->'relations'),'columns',jsonb_array_length(catalog->'columns'),
    'constraints',jsonb_array_length(catalog->'constraints'),'indexes',jsonb_array_length(catalog->'indexes'),
    'types',jsonb_array_length(catalog->'types'),'sequences',jsonb_array_length(catalog->'sequences'),'policies',jsonb_array_length(catalog->'policies'))::text);
  for i in 1..parts loop
    perform pg_temp.dry_run_check('schemaShapePart/'||lpad(i::text,6,'0'),true,substring(encoded from (i-1)*450+1 for 450));
  end loop;
end $$;
