-- Original successful keyed setup request identity, including paid-only fallback.
-- Deliberately retained without profile/shift/operation FKs or cascade rewriting.
create table public.work_cross_job_clock_requests (
 client_id uuid primary key,
 profile_id uuid not null,
 shift_id uuid not null,
 operation_id uuid not null,
 setup_version integer not null check(setup_version in(1,2)),
 receipt_sha256 text not null check(receipt_sha256 ~ '^[0-9a-f]{64}$')
);
create index work_cross_job_clock_requests_profile on public.work_cross_job_clock_requests(profile_id);
revoke all on table public.work_cross_job_clock_requests from public,anon,authenticated,service_role;
alter table public.work_cross_job_clock_requests enable row level security;
-- Canonical receipt fingerprint v1. All 15 retained fields in fixed order;
-- timestamptz values are exact numeric epoch microseconds, never session text.
create function public._work_cross_job_clock_receipt_fingerprint(p_receipt public.work_activity_clock_receipts) returns text
language sql immutable strict security definer set search_path=public,pg_temp as $$
 select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
  'work_clock_receipt_fingerprint_v1'::text,
  p_receipt.client_id,p_receipt.profile_id,p_receipt.shift_id,p_receipt.action,p_receipt.outcome,
  extract(epoch from p_receipt.tapped_at)*1000000::numeric,
  extract(epoch from p_receipt.arrived_at)*1000000::numeric,
  extract(epoch from p_receipt.clock_checked_at)*1000000::numeric,
  p_receipt.clock_skew_ms,p_receipt.used_tap_time,p_receipt.review_reason,
  extract(epoch from p_receipt.source_created_at)*1000000::numeric,
  p_receipt.receipt_protocol,p_receipt.setup_payload_digest,
  extract(epoch from p_receipt.recorded_at)*1000000::numeric
 )::text,'UTF8')),'hex')
$$;
revoke all on function public._work_cross_job_clock_receipt_fingerprint(public.work_activity_clock_receipts) from public,anon,authenticated,service_role;
create function public._work_cross_job_clock_request_admit() returns trigger
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare o public.work_activity_operations;r public.work_activity_clock_receipts;
begin
 perform pg_catalog.pg_advisory_xact_lock(7712,0);
 o:=public._work_activity_operation();
 select * into r from public.work_activity_clock_receipts where client_id=new.client_id;
 if o.id is null or o.route is distinct from 'clock_in_setup' or not o.clock_entry_claimed
  or o.actor_id is null or o.actor_id is distinct from auth.uid() or o.actor_id is distinct from new.profile_id
  or o.request_id is distinct from new.client_id or o.id is distinct from new.operation_id
  or o.top_xid is distinct from pg_current_xact_id() or o.backend_pid is distinct from pg_backend_pid() or o.command_id is not null
  or o.arguments->>'setupVersion' is distinct from new.setup_version::text
  or r.client_id is null or r.profile_id is distinct from new.profile_id or r.shift_id is distinct from new.shift_id
  or r.action is distinct from 'clock_in' or r.receipt_protocol is distinct from 'setup_v1'
  or r.setup_payload_digest is distinct from o.arguments->>'clockPayloadDigest'
  or new.receipt_sha256 is distinct from public._work_cross_job_clock_receipt_fingerprint(r) then
   raise exception using errcode='42501',message='Clock receipt unavailable.';
 end if;
 return new;
end$$;
create function public._work_cross_job_clock_request_stamp() returns trigger
language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare o public.work_activity_operations;
begin
 if new.action<>'clock_in' or new.receipt_protocol<>'setup_v1' then return new;end if;
 o:=public._work_activity_operation();
 if o.id is null or o.route is distinct from 'clock_in_setup'
  or o.arguments->>'setupVersion' is null or o.arguments->>'setupVersion' not in('1','2') then
  raise exception using errcode='42501',message='Clock receipt unavailable.';
 end if;
 insert into public.work_cross_job_clock_requests(client_id,profile_id,shift_id,operation_id,setup_version,receipt_sha256)
 values(new.client_id,new.profile_id,new.shift_id,o.id,(o.arguments->>'setupVersion')::integer,public._work_cross_job_clock_receipt_fingerprint(new));
 return new;
end$$;
revoke all on function public._work_cross_job_clock_request_admit() from public,anon,authenticated,service_role;
revoke all on function public._work_cross_job_clock_request_stamp() from public,anon,authenticated,service_role;
create trigger work_cross_job_clock_requests_admit before insert on public.work_cross_job_clock_requests for each row execute function public._work_cross_job_clock_request_admit();
create trigger work_cross_job_clock_requests_immutable before update or delete on public.work_cross_job_clock_requests for each row execute function public.work_capture_immutable_record();
create trigger work_cross_job_clock_requests_no_truncate before truncate on public.work_cross_job_clock_requests for each statement execute function public.work_capture_immutable_record();
create trigger work_cross_job_clock_request_stamp after insert on public.work_activity_clock_receipts for each row execute function public._work_cross_job_clock_request_stamp();
