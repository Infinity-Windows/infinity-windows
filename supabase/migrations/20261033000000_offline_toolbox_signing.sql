-- Offline toolbox signing (owner go, 2026-09-25: "yes start offline toolbox
-- signing").
--
-- WHAT WAS WRONG. Today's toolbox talk could only be signed with signal. The
-- phone uploaded the signature and the PDF and inserted the completion row in
-- one online call (lib/toolbox.ts, submitToolboxCompletion), and with no signal
-- that call failed. clock_in refuses the day's first punch without that row
-- (the toolbox gate, 20261028000000), so somebody standing on a site with no
-- bars could not sign, and so could not clock in either. The owner hit it in
-- the field.
--
-- WHAT THIS DOES. The phone now keeps the signature in its outbox (op
-- toolbox_sign, sent ahead of any clock-in queued behind it) and files it here
-- once there is signal. A signature can therefore arrive twice (a reply lost to
-- a dead zone) and hours after it was made, so:
--   1. toolbox_completions.client_id: the phone's one-time id for this
--      signature, unique per signer. A resend is the same signature.
--   2. sign_toolbox_talk(...): the one way the app files a signature now. The
--      signer must be the caller; a repeat of the client id answers with the row
--      it already made; a talk deleted since the phone kept it files with no
--      talk (the snapshot says what was signed); and the phone's signing time is
--      judged by the rule below.
--   3. phone_signed_at / signed_at_note: what the phone said, and why
--      signed_at differs from it or deserves a look.
-- The table's own policy is unchanged, so a phone still running the old build
-- keeps inserting its row directly until it updates.
--
-- THE SIGN-TIME RULE. signed_at is what clock_in's gate reads (its
-- America/Denver day must be the day the clock-in arrives), so it is the time
-- that matters. The bounds are the ones the tap-time rule uses for phone times
-- (20261028000000, _clock_pick_time): nothing after arrival beyond a small
-- skew, and a day as the edge of "recent". What falls outside them is never
-- refused — a refused signature would hold its clock-in on the phone for good:
--   * the phone's time, when it is no later than the moment the signature
--     reached Forge. A phone up to 2 minutes fast is clamped to arrival:
--     ordinary drift, no note.
--   * ARRIVAL, when the phone's time is more than 2 minutes after arrival. A
--     signature cannot have been made after it arrived, so the phone's clock is
--     ahead. Noted 'phone_clock_ahead', the claim kept in phone_signed_at. This
--     cannot block a clock-in: arrival is today.
--   * the phone's time, noted 'arrived_late', when it is more than 24 hours
--     before arrival. The signature is real and stays on the day it was signed.
--     It never opens a LATER day's clock-in, because that day has its own talk
--     the person has not read. Using arrival here (the tap-time rule's answer
--     for a stale punch) would let Friday's signature, sent Monday morning,
--     sign Monday's talk for them. The phone asks for the new day's talk the
--     same way: it counts a signature still on the phone only for the day it
--     was made (lib/useToolboxGate.ts).
--   * no phone time at all: signing now.
--
-- AFTER MIDNIGHT. clock_in judges its gate by the day the clock-in ARRIVES,
-- and that is unchanged here. A signature made at 11:50 PM and a clock-in
-- tapped at 11:55 PM, both sent after midnight, file the signature for the day
-- it was signed and then refuse the clock-in: that day is over, and the new
-- day's talk is not signed yet. The clock-in stays on the phone with the
-- refusal (Stuck writes) and goes through with Try again once the new day's
-- talk is signed, because a signature always leaves the phone before a punch.
-- That is how a queued clock-in that crosses midnight has always behaved; only
-- the signature is new.

alter table public.toolbox_completions add column if not exists client_id uuid;
alter table public.toolbox_completions add column if not exists phone_signed_at timestamptz;
alter table public.toolbox_completions add column if not exists signed_at_note text;

alter table public.toolbox_completions drop constraint if exists toolbox_completions_signed_at_note_check;
alter table public.toolbox_completions add constraint toolbox_completions_signed_at_note_check
  check (signed_at_note is null or signed_at_note in ('phone_clock_ahead', 'arrived_late'));

create unique index if not exists toolbox_completions_client_id_key
  on public.toolbox_completions (profile_id, client_id)
  where client_id is not null;

comment on column public.toolbox_completions.client_id is
  'The phone''s one-time id for this signature (20261033000000). Unique per signer: a signature sent twice from the outbox is one row. Null on rows filed before offline signing, and on group sign-ins.';
comment on column public.toolbox_completions.phone_signed_at is
  'When the signing phone said the talk was signed, by its own clock (20261033000000). signed_at is the time the gate uses; see signed_at_note for why the two differ.';
comment on column public.toolbox_completions.signed_at_note is
  'Why signed_at deserves a look (20261033000000): ''phone_clock_ahead'' = the phone''s time was more than 2 minutes after the signature arrived, so signed_at is the arrival time; ''arrived_late'' = the signature arrived more than 24 hours after the phone''s time, and signed_at keeps the phone''s time, so it counts only for the day it was signed. Null when signed_at is simply the phone''s time.';

create or replace function public.sign_toolbox_talk(
  p_client_id uuid,
  p_profile_id uuid,
  p_talk_id uuid,
  p_typed_name text,
  p_signature_path text,
  p_pdf_path text,
  p_talk_snapshot text,
  p_signed_at timestamptz
)
returns public.toolbox_completions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_name text := nullif(btrim(coalesce(p_typed_name, '')), '');
  v_folder text;
  v_row public.toolbox_completions;
  v_talk uuid;
  v_at timestamptz;
  v_note text;
begin
  if v_uid is null then
    raise exception 'Sign in to send your toolbox talk signature.' using errcode = '42501';
  end if;
  if public.is_partner_user() then
    raise exception 'Not available for your account.' using errcode = '42501';
  end if;
  -- Nobody files a signature for somebody else, whoever is signed in on the
  -- phone that happens to send it.
  if p_profile_id is distinct from v_uid then
    raise exception 'This toolbox talk signature belongs to someone else on this phone. Sign in as the person who signed it to send it.'
      using errcode = '42501';
  end if;
  if p_client_id is null then
    raise exception 'This toolbox talk signature is missing its id. Sign today''s talk again.' using errcode = '22023';
  end if;
  if v_name is null then
    raise exception 'Type your name to sign the toolbox talk.' using errcode = '22023';
  end if;
  -- The files live under the signer's own folder in toolbox-records, the
  -- folder a test login may write (20261027020000). A record pointing
  -- anywhere else would be pointing at somebody else's signature.
  v_folder := v_uid::text || '/';
  if (p_signature_path is not null and left(p_signature_path, length(v_folder)) <> v_folder)
     or (p_pdf_path is not null and left(p_pdf_path, length(v_folder)) <> v_folder) then
    raise exception 'A toolbox talk signature can only point at files in the signer''s own folder.'
      using errcode = '22023';
  end if;

  -- One signature at a time per person, until this transaction ends: the same
  -- signature sent twice at once must find the first, not race it.
  perform pg_advisory_xact_lock(hashtextextended('toolbox_sign:' || v_uid::text, 0));

  select * into v_row from public.toolbox_completions
   where profile_id = v_uid and client_id = p_client_id;
  if v_row.id is not null then
    return v_row;
  end if;

  -- A lead can re-point a day's talk after the phone kept it (assignTalk
  -- deletes an unsigned instance). The person signed what the phone showed
  -- them; the snapshot says what that was.
  select st.id into v_talk from public.safety_talks st where st.id = p_talk_id;

  if p_signed_at is null then
    v_at := v_now;
  elsif p_signed_at > v_now + interval '2 minutes' then
    v_at := v_now;
    v_note := 'phone_clock_ahead';
  elsif p_signed_at < v_now - interval '24 hours' then
    v_at := p_signed_at;
    v_note := 'arrived_late';
  else
    v_at := least(p_signed_at, v_now);
  end if;

  insert into public.toolbox_completions
    (talk_id, profile_id, signed_at, typed_name, signature_path, talk_snapshot, pdf_path,
     signed_via, signed_by, client_id, phone_signed_at, signed_at_note)
  values
    (v_talk, v_uid, v_at, v_name, p_signature_path, p_talk_snapshot, p_pdf_path,
     'self', null, p_client_id, p_signed_at, v_note)
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.sign_toolbox_talk(uuid, uuid, uuid, text, text, text, text, timestamptz) from public, anon;
grant execute on function public.sign_toolbox_talk(uuid, uuid, uuid, text, text, text, text, timestamptz) to authenticated;

comment on function public.sign_toolbox_talk(uuid, uuid, uuid, text, text, text, text, timestamptz) is
  'File a toolbox talk signature from the phone''s outbox (20261033000000). The caller must be the signer; a repeat of the client id returns the signature already filed; a talk deleted since the phone kept it files with talk_id null. signed_at: the phone''s time, clamped to arrival; arrival if the phone''s time is more than 2 minutes ahead (signed_at_note phone_clock_ahead); the phone''s time, noted arrived_late, if it arrived more than 24 hours later.';
