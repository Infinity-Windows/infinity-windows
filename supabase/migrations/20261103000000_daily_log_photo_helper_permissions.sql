-- Keep the photo namespace classifier private without breaking Storage's
-- SECURITY INVOKER row guard during privileged completion/timestamp updates.
-- No policy, trigger trust, function body or lifecycle permission changes.
begin;
revoke execute on function public._is_daily_log_photo_name(text) from public, anon;
grant execute on function public._is_daily_log_photo_name(text)
  to authenticated, service_role, supabase_storage_admin;
commit;
