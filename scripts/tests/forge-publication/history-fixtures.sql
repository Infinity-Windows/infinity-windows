-- Empty synthetic history tables; no copied records or application schema.
create table public.ask_question_log (asker_id uuid);
create table public.capability_badges (installer_id uuid);
create table public.certifications (profile_id uuid);
create table public.daily_logs (filed_by uuid);
create table public.education_credits (profile_id uuid);
create table public.flash_run_assignments (assigned_by uuid, profile_id uuid);
create table public.install_events (credited_to uuid, installer_id uuid);
create table public.installer_clearance (installer_id uuid);
create table public.learn_progress (profile_id uuid);
create table public.learning_video_quiz_attempts (profile_id uuid);
create table public.opening_phases (started_by uuid, submitted_by uuid);
create table public.overtime_rules (profile_id uuid);
create table public.pay_rates (profile_id uuid);
create table public.points_ledger (profile_id uuid);
create table public.project_messages (author_id uuid);
create table public.receipts (uploaded_by uuid);
create table public.safety_acks (profile_id uuid);
create table public.summon_declines (profile_id uuid);
create table public.summon_helpers (profile_id uuid);
create table public.summons (requested_by uuid);
create table public.task_sessions (profile_id uuid);
create table public.time_shift_edits (edited_by uuid);
create table public.time_shifts (profile_id uuid);
create table public.timecard_periods (profile_id uuid);
create table public.toolbox_completions (profile_id uuid);
create table public.unit_redos (pressed_by uuid);
create table public.unit_sessions (profile_id uuid);
create table public.vehicle_drivers (profile_id uuid);

-- Match Supabase defaults: the migration must revoke these explicitly.
alter default privileges in schema public grant all on tables to anon,authenticated;
