-- Proposal CRM is separate from the crew Schedule/Travel workflow plans.
-- Partners cannot query these tables. A later partner projection will expose
-- explicitly shared records; a money document never inherits crew job access.
create or replace function public.proposal_manager()
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select auth.uid() is not null and not public.is_partner_user() and exists (
  select 1 from public.profiles where id=auth.uid() and active
  and role in ('supervisor','owner','admin','big_boss'));
$$;
revoke all on function public.proposal_manager() from public,anon;
grant execute on function public.proposal_manager() to authenticated,service_role;

create table if not exists public.proposal_jobs (
 id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) between 1 and 200),
 contractor text not null default '', contact_name text not null default '', contact_email text not null default '', contact_phone text not null default '',
 address text not null default '', city text not null default '', state text not null default 'UT' check(state ~ '^[A-Z]{2}$'),
 kind text not null default 'installation' check(kind in ('service_call','service_work','installation','delivery')),
 stage text not null default 'intake' check(stage in ('intake','drafting','submitted','approved','scheduled','in_progress','complete','on_hold','lost')),
 scope text not null default '', notes text not null default '', project_id uuid references public.projects(id) on delete set null,
 start_precision text not null default 'unknown' check(start_precision in ('unknown','month','week','range','date')),
 target_start date, target_end date, confirmed_start date, confirmation_note text not null default '',
 follow_up_on date, version integer not null default 1,
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(target_end is null or (target_start is not null and target_end>=target_start)),
 check((start_precision='unknown' and target_start is null and target_end is null) or (start_precision<>'unknown' and target_start is not null)),
 check(start_precision<>'range' or target_end is not null),
 check(confirmed_start is null or length(trim(confirmation_note))>0),
 check(stage not in ('scheduled','in_progress') or confirmed_start is not null)
);
create table if not exists public.proposal_bids (
 id uuid primary key default gen_random_uuid(), job_id uuid not null references public.proposal_jobs(id),
 number text not null, revision integer not null check(revision>0), contractor text not null,
 amount numeric(14,2) not null check(amount>=0), scope text not null default '',
 line_items jsonb not null default '[]'::jsonb check(jsonb_typeof(line_items)='array'),
 submitted_at timestamptz, accepted_at timestamptz, accepted_amount numeric(14,2),
 accepted_scope text not null default '', acceptance_email text not null default '', signed_document_id uuid,
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 unique(job_id,contractor,number,revision),
 check(accepted_amount is null or (accepted_amount>=0 and accepted_amount<=amount)),
 check(accepted_at is null or (submitted_at is not null and accepted_amount is not null and length(trim(accepted_scope))>0 and length(trim(acceptance_email))>0 and signed_document_id is not null))
);
create table if not exists public.proposal_documents (
 id uuid primary key default gen_random_uuid(), job_id uuid not null references public.proposal_jobs(id),
 filename text not null, storage_path text not null unique, kind text not null default 'other'
 check(kind in ('proposal','signed_agreement','plans','cad','specification','photo','email','other')),
 bytes bigint not null check(bytes>=0), ready boolean not null default false,
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now(),
 check(storage_path=job_id::text||'/'||id::text)
);
alter table public.proposal_bids add constraint proposal_signed_document_fk foreign key(signed_document_id) references public.proposal_documents(id);
create table if not exists public.proposal_rates (
 id uuid primary key default gen_random_uuid(), category text not null check(category in ('service_call','service_work','installation','delivery')),
 name text not null check(length(trim(name))>0), contractor text not null default '',
 unit text not null default 'hour', amount numeric(14,2) check(amount>=0), minimum text not null default '',
 notes text not null default '', effective_on date not null default current_date,
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now()
);
create table if not exists public.proposal_activity (
 id uuid primary key default gen_random_uuid(), job_id uuid not null references public.proposal_jobs(id),
 kind text not null check(kind in ('note','sent','reply','stage','edit','bid','file')),
 detail text not null, previous_value jsonb, next_value jsonb,
 created_by uuid not null default auth.uid(), created_at timestamptz not null default now()
);
create index if not exists proposal_jobs_updated on public.proposal_jobs(updated_at desc);
create index if not exists proposal_bids_job on public.proposal_bids(job_id,created_at desc);
create index if not exists proposal_documents_job on public.proposal_documents(job_id,created_at desc);
create index if not exists proposal_activity_job on public.proposal_activity(job_id,created_at desc);

-- No direct client writes: every mutation goes through one checked transaction.
alter table public.proposal_jobs enable row level security;
alter table public.proposal_bids enable row level security;
alter table public.proposal_documents enable row level security;
alter table public.proposal_rates enable row level security;
alter table public.proposal_activity enable row level security;
create policy "proposal jobs internal read" on public.proposal_jobs for select to authenticated using(not public.is_partner_user() and public.proposal_manager());
create policy "proposal bids internal read" on public.proposal_bids for select to authenticated using(not public.is_partner_user() and public.proposal_manager());
create policy "proposal documents internal read" on public.proposal_documents for select to authenticated using(not public.is_partner_user() and public.proposal_manager());
create policy "proposal rates internal read" on public.proposal_rates for select to authenticated using(not public.is_partner_user() and public.proposal_manager());
create policy "proposal activity internal read" on public.proposal_activity for select to authenticated using(not public.is_partner_user() and public.proposal_manager());
revoke all on table public.proposal_jobs from anon,authenticated;
revoke all on table public.proposal_bids from anon,authenticated;
revoke all on table public.proposal_documents from anon,authenticated;
revoke all on table public.proposal_rates from anon,authenticated;
revoke all on table public.proposal_activity from anon,authenticated;
grant select on public.proposal_jobs,public.proposal_bids,public.proposal_documents,public.proposal_rates,public.proposal_activity to authenticated;
grant all on public.proposal_jobs,public.proposal_bids,public.proposal_documents,public.proposal_rates,public.proposal_activity to service_role;

insert into storage.buckets(id,name,public) values('proposal-files','proposal-files',false) on conflict(id) do nothing;
create policy "proposal file read" on storage.objects for select to authenticated using(
 bucket_id='proposal-files' and not public.is_partner_user() and public.proposal_manager() and exists(
 select 1 from public.proposal_documents d where d.storage_path=objects.name and d.ready));
create policy "proposal file upload" on storage.objects for insert to authenticated with check(
 bucket_id='proposal-files' and not public.is_partner_user() and public.proposal_manager() and exists(
 select 1 from public.proposal_documents d where d.storage_path=objects.name and not d.ready and d.created_by=auth.uid()));

create or replace function public.proposal_write(p_action text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.proposal_jobs; b public.proposal_bids; d public.proposal_documents; r public.proposal_rates;
 v_id uuid; v_stage text; v_detail text; v_kind text; v_result jsonb; v_before jsonb; v_now timestamptz:=now();
begin
 if not public.proposal_manager() then raise exception 'Only internal supervisors and owners can manage Workflow.' using errcode='42501'; end if;
 if p_action='rate' then
  insert into public.proposal_rates(category,name,contractor,unit,amount,minimum,notes,effective_on)
  values(p_data->>'category',trim(p_data->>'name'),coalesce(p_data->>'contractor',''),coalesce(p_data->>'unit','hour'),
  nullif(p_data->>'amount','')::numeric,coalesce(p_data->>'minimum',''),coalesce(p_data->>'notes',''),coalesce(nullif(p_data->>'effective_on','')::date,current_date)) returning * into r;
  return to_jsonb(r);
 end if;
 if p_action='create' then
  insert into public.proposal_jobs(name,contractor,kind) values(trim(p_data->>'name'),coalesce(p_data->>'contractor',''),coalesce(p_data->>'kind','installation')) returning * into j;
  insert into public.proposal_activity(job_id,kind,detail) values(j.id,'edit','Job created'); return to_jsonb(j);
 end if;
 select * into j from public.proposal_jobs where id=(p_data->>'job_id')::uuid for update;
 if not found then raise exception 'That Workflow job was not found.'; end if;
 if p_data->>'version' is null or j.version<>(p_data->>'version')::integer then raise exception 'This job changed. Refresh it before saving so nobody loses an edit.'; end if;
 v_before:=to_jsonb(j);
 if p_action='edit' then
  update public.proposal_jobs set name=trim(p_data->>'name'),contractor=coalesce(p_data->>'contractor',''),
  contact_name=coalesce(p_data->>'contact_name',''),contact_email=coalesce(p_data->>'contact_email',''),contact_phone=coalesce(p_data->>'contact_phone',''),
  address=coalesce(p_data->>'address',''),city=coalesce(p_data->>'city',''),state=p_data->>'state',kind=p_data->>'kind',
  scope=coalesce(p_data->>'scope',''),notes=coalesce(p_data->>'notes',''),project_id=nullif(p_data->>'project_id','')::uuid,
  start_precision=p_data->>'start_precision',target_start=nullif(p_data->>'target_start','')::date,target_end=nullif(p_data->>'target_end','')::date,
  confirmed_start=nullif(p_data->>'confirmed_start','')::date,confirmation_note=coalesce(p_data->>'confirmation_note',''),follow_up_on=nullif(p_data->>'follow_up_on','')::date
  where id=j.id returning * into j;
  v_kind:='edit'; v_detail:='Job details updated';
 elsif p_action='stage' then
  v_stage:=p_data->>'stage';
  if v_stage='submitted' and not exists(select 1 from public.proposal_bids where job_id=j.id and submitted_at is not null) then raise exception 'Record a submitted bid first.'; end if;
  if v_stage in ('approved','scheduled','in_progress','complete') and not exists(select 1 from public.proposal_bids where job_id=j.id and accepted_at is not null) then raise exception 'Attach a signed proposal and record its acceptance email first.'; end if;
  if v_stage in ('scheduled','in_progress') and j.confirmed_start is null then raise exception 'Record the contractor-confirmed start date first.'; end if;
  update public.proposal_jobs set stage=v_stage where id=j.id returning * into j;
  v_kind:='stage'; v_detail:='Moved from '||(v_before->>'stage')||' to '||v_stage;
 elsif p_action='bid' then
  if length(trim(coalesce(p_data->>'contractor','')))=0 or length(trim(coalesce(p_data->>'number','')))=0 then raise exception 'Add the recipient contractor and proposal number.'; end if;
  -- Snapshot rows are immutable; a correction is a newly numbered revision.
  insert into public.proposal_bids(job_id,number,revision,contractor,amount,scope,line_items,submitted_at)
  values(j.id,trim(p_data->>'number'),coalesce((select max(revision)+1 from public.proposal_bids where job_id=j.id and contractor=trim(p_data->>'contractor') and number=trim(p_data->>'number')),1),
  trim(p_data->>'contractor'),(p_data->>'amount')::numeric,coalesce(p_data->>'scope',''),coalesce(p_data->'line_items','[]'),nullif(p_data->>'submitted_at','')::timestamptz) returning * into b;
  if b.submitted_at>v_now then raise exception 'Submission cannot be in the future.'; end if;
  if b.submitted_at is not null then update public.proposal_jobs set follow_up_on=(b.submitted_at at time zone 'America/Denver')::date+4 where id=j.id; end if;
  v_kind:='bid'; v_detail:='Added proposal '||b.number||' revision '||b.revision; v_result:=to_jsonb(b);
 elsif p_action='submit' then
  update public.proposal_bids set submitted_at=v_now where id=(p_data->>'bid_id')::uuid and job_id=j.id and submitted_at is null and accepted_at is null returning * into b;
  if not found then raise exception 'That proposal is already submitted or no longer available.'; end if;
  update public.proposal_jobs set follow_up_on=(v_now at time zone 'America/Denver')::date+4 where id=j.id;
  v_kind:='bid'; v_detail:='Recorded submission of '||b.number||' revision '||b.revision; v_result:=to_jsonb(b);
 elsif p_action='accept' then
  select * into b from public.proposal_bids where id=(p_data->>'bid_id')::uuid and job_id=j.id;
  if not found or b.accepted_at is not null then raise exception 'Choose a submitted proposal that has not already been accepted.'; end if;
  if b.submitted_at is null then raise exception 'Record the submission before acceptance.'; end if;
  select * into d from public.proposal_documents where id=(p_data->>'signed_document_id')::uuid and job_id=j.id and kind='signed_agreement' and ready;
  if not found then raise exception 'Choose an uploaded signed agreement from this job.'; end if;
  update public.proposal_bids set accepted_at=v_now,accepted_amount=(p_data->>'accepted_amount')::numeric,
  accepted_scope=trim(p_data->>'accepted_scope'),acceptance_email=trim(p_data->>'acceptance_email'),signed_document_id=d.id where id=b.id returning * into b;
  v_kind:='bid'; v_detail:='Recorded acceptance for '||b.number||' revision '||b.revision; v_result:=to_jsonb(b);
 elsif p_action='file' then
  v_id:=(p_data->>'id')::uuid;
  insert into public.proposal_documents(id,job_id,filename,storage_path,kind,bytes)
  values(v_id,j.id,p_data->>'filename',j.id::text||'/'||v_id::text,p_data->>'kind',(p_data->>'bytes')::bigint) returning * into d;
  v_kind:='file'; v_detail:='Started upload: '||d.filename; v_result:=to_jsonb(d);
 elsif p_action='file_ready' then
  select * into d from public.proposal_documents where id=(p_data->>'id')::uuid and job_id=j.id;
  if not found or not exists(select 1 from storage.objects where bucket_id='proposal-files' and name=d.storage_path) then raise exception 'The file upload has not finished. Retry it first.'; end if;
  update public.proposal_documents set ready=true where id=d.id returning * into d;
  v_kind:='file'; v_detail:='Attached: '||d.filename; v_result:=to_jsonb(d);
 elsif p_action='activity' then
  v_kind:=p_data->>'kind'; v_detail:=trim(p_data->>'detail');
  if v_kind not in ('note','sent','reply') or coalesce(length(v_detail),0)=0 then raise exception 'Add a note, an actual sent-message record, or a contractor response.'; end if;
  if v_kind='sent' then update public.proposal_jobs set follow_up_on=(v_now at time zone 'America/Denver')::date+4 where id=j.id; end if;
  if v_kind='reply' then update public.proposal_jobs set follow_up_on=null where id=j.id; end if;
 else raise exception 'That Workflow action is not supported.';
 end if;
 update public.proposal_jobs set version=version+1,updated_at=v_now where id=j.id returning * into j;
 insert into public.proposal_activity(job_id,kind,detail,previous_value,next_value) values(j.id,v_kind,v_detail,v_before,to_jsonb(j));
 return jsonb_build_object('job',to_jsonb(j),'record',v_result);
end;
$$;
revoke all on function public.proposal_write(text,jsonb) from public,anon;
grant execute on function public.proposal_write(text,jsonb) to authenticated,service_role;

-- Preserve the shared test-account sandbox boundary on linked execution jobs.
select public.attach_sandbox_guards();
