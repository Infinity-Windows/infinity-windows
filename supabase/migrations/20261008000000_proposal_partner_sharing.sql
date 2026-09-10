-- Separate money/document grants from execution-job access. Every bid revision
-- and original file is selected explicitly; new revisions remain internal.
create table public.proposal_partner_shares (
 job_id uuid not null references public.proposal_jobs(id),
 partner_profile_id uuid not null references public.profiles(id) on delete cascade,
 bid_ids uuid[] not null default '{}', document_ids uuid[] not null default '{}',
 shared_by uuid not null default auth.uid(), updated_at timestamptz not null default now(),
 primary key(job_id,partner_profile_id)
);
alter table public.proposal_partner_shares enable row level security;
revoke all on table public.proposal_partner_shares from anon,authenticated;
grant select on public.proposal_partner_shares to authenticated;
grant all on public.proposal_partner_shares to service_role;
create policy "proposal sharing internal read" on public.proposal_partner_shares for select to authenticated
using(not public.is_partner_user() and public.proposal_manager());

create function public.proposal_share(p_job uuid,p_version integer,p_email text,p_bids uuid[],p_documents uuid[],p_remove boolean default false)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.proposal_jobs; partner uuid;
begin
 if not public.proposal_manager() then raise exception 'Only supervisors and owners can share Workflow.' using errcode='42501'; end if;
 select * into j from public.proposal_jobs where id=p_job for update;
 if not found or j.version is distinct from p_version then raise exception 'This job changed. Refresh before sharing.'; end if;
 select u.id into partner from auth.users u join public.profiles p on p.id=u.id
 where lower(u.email)=lower(trim(p_email)) and p.is_partner and p.active;
 if partner is null then raise exception 'No active partner login matches this email. An owner can add one in Account.'; end if;
 if p_remove then
  delete from public.proposal_partner_shares where job_id=p_job and partner_profile_id=partner;
 else
  if exists(select 1 from unnest(p_bids) x(id) where not exists(select 1 from public.proposal_bids b where b.id=x.id and b.job_id=p_job and b.submitted_at is not null)) then raise exception 'Only submitted bids from this job can be shared.'; end if;
  if exists(select 1 from unnest(p_documents) x(id) where not exists(select 1 from public.proposal_documents d where d.id=x.id and d.job_id=p_job and d.ready)) then raise exception 'Only completed files from this job can be shared.'; end if;
  insert into public.proposal_partner_shares(job_id,partner_profile_id,bid_ids,document_ids)
  values(p_job,partner,coalesce(p_bids,'{}'),coalesce(p_documents,'{}'))
  on conflict(job_id,partner_profile_id) do update set bid_ids=excluded.bid_ids,document_ids=excluded.document_ids,shared_by=auth.uid(),updated_at=now();
 end if;
 update public.proposal_jobs set version=version+1,updated_at=now() where id=p_job;
 insert into public.proposal_activity(job_id,kind,detail,next_value) values(p_job,'edit',
 case when p_remove then 'Removed Workflow access for ' else 'Updated Workflow access for ' end||trim(p_email),
 jsonb_build_object('partner',partner,'bid_ids',p_bids,'document_ids',p_documents));
end $$;
revoke all on function public.proposal_share(uuid,integer,text,uuid[],uuid[],boolean) from public,anon;
grant execute on function public.proposal_share(uuid,integer,text,uuid[],uuid[],boolean) to authenticated;

create function public.stg_workflow() returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object(
 'id',j.id,'name',j.name,'address',j.address,'city',j.city,'state',j.state,'kind',j.kind,'stage',j.stage,
 'start_precision',j.start_precision,'target_start',j.target_start,'target_end',j.target_end,'confirmed_start',j.confirmed_start,'version',j.version,
 'bids',(select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'number',b.number,'revision',b.revision,'amount',b.amount,'scope',b.scope,'line_items',b.line_items,'submitted_at',b.submitted_at,'accepted_at',b.accepted_at,'accepted_amount',b.accepted_amount,'accepted_scope',b.accepted_scope) order by b.created_at desc),'[]') from public.proposal_bids b where b.job_id=j.id and b.id=any(s.bid_ids)),
 'files',(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'filename',d.filename,'storage_path',d.storage_path,'kind',d.kind,'bytes',d.bytes) order by d.created_at desc),'[]') from public.proposal_documents d where d.job_id=j.id and d.ready and d.id=any(s.document_ids))
 ) order by j.updated_at desc),'[]') from public.proposal_partner_shares s join public.proposal_jobs j on j.id=s.job_id
 where s.partner_profile_id=auth.uid() and public.is_partner_user() and exists(select 1 from public.profiles p where p.id=auth.uid() and p.active);
$$;
revoke all on function public.stg_workflow() from public,anon;
grant execute on function public.stg_workflow() to authenticated;

-- Storage evaluates this narrow helper without granting partners table reads.
create function public.proposal_partner_file(p_path text) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select public.is_partner_user() and exists(select 1 from public.profiles p where p.id=auth.uid() and p.active)
 and exists(select 1 from public.proposal_partner_shares s join public.proposal_documents d on d.job_id=s.job_id and d.id=any(s.document_ids)
 where s.partner_profile_id=auth.uid() and d.ready and d.storage_path=p_path);
$$;
revoke all on function public.proposal_partner_file(text) from public,anon;
grant execute on function public.proposal_partner_file(text) to authenticated;
create policy "proposal shared file read" on storage.objects for select to authenticated
using(bucket_id='proposal-files' and public.is_partner_user() and public.proposal_partner_file(name));

create function public.stg_workflow_reply(p_job uuid,p_version integer,p_note text,p_confirm_date boolean default false)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.proposal_jobs;
begin
 if not public.is_partner_user() or not exists(select 1 from public.profiles where id=auth.uid() and active) then raise exception 'An active partner login is required.' using errcode='42501';end if;
 -- Serialize replies and sharing edits on the job; revoked access wins on retry.
 select * into j from public.proposal_jobs where id=p_job for update;
 if not exists(select 1 from public.proposal_partner_shares where job_id=p_job and partner_profile_id=auth.uid()) then raise exception 'This job is not shared with you.' using errcode='42501';end if;
 if j.version is distinct from p_version then raise exception 'The job changed. Refresh before responding.';end if;
 if length(trim(coalesce(p_note,''))) not between 1 and 4000 then raise exception 'Add a short response.';end if;
 if p_confirm_date and (j.start_precision<>'date' or j.target_start is null) then raise exception 'An exact proposed start date is needed before approval.';end if;
 update public.proposal_jobs set version=version+1,updated_at=now(),follow_up_on=null,
 confirmed_start=case when p_confirm_date then j.target_start else confirmed_start end,
 confirmation_note=case when p_confirm_date then trim(p_note) else confirmation_note end where id=p_job;
 insert into public.proposal_activity(job_id,kind,detail) values(p_job,'reply',case when p_confirm_date then 'Partner approved start date: '||j.target_start||'. ' else 'Partner response: ' end||trim(p_note));
end $$;
revoke all on function public.stg_workflow_reply(uuid,integer,text,boolean) from public,anon;
grant execute on function public.stg_workflow_reply(uuid,integer,text,boolean) to authenticated;
