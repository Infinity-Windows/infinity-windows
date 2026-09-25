-- Let a test login save files in its own folder, so it can sign the toolbox
-- talk and record a voice memo like any crew member — still never on a real job.
--
-- WHY. 20260730220000 fenced test logins (profiles.is_test) so every storage
-- write they make must sit inside a sandbox project's folder: the first path
-- segment must be a job on the sandbox list. That is right for job files, but
-- some files are filed under the PERSON, not the job:
--   toolbox-records   <profile id>/<talk id>/<stamp>-signature.png and .pdf
--   ai-field-memos    <user id>/<request id>/memo.webm
--   credentials       <profile id>/<id>.<ext>
-- so a test login could never sign today's toolbox talk (and so never clock
-- in), nor save an Ask voice memo. Found 2026-09-24 when the owner's phone
-- drill with qa.installer stopped at "new row violates row-level security
-- policy" on "Sign today's talk".
--
-- WHAT. The three restrictive policies gain one alternative: the object's first
-- path segment is the caller's own user id. A test login's own folder holds only
-- its own records' files; no real job or real person's record points there, so
-- the fence's promise — a test login cannot change a real job — still holds.
-- Real people are untouched: for them the condition was already `not false`.
-- Each bucket's own policies (e.g. ai-field-memos' own-folder boundary) still
-- apply on top, since restrictive policies are ANDed.

drop policy if exists "test logins write only their sandbox (insert)" on storage.objects;
create policy "test logins write only their sandbox (insert)" on storage.objects
  as restrictive for insert to authenticated
  with check (
    not public.is_test_profile(auth.uid())
    or public.is_sandbox_storage_path(name)
    or split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists "test logins write only their sandbox (update)" on storage.objects;
create policy "test logins write only their sandbox (update)" on storage.objects
  as restrictive for update to authenticated
  using (
    not public.is_test_profile(auth.uid())
    or public.is_sandbox_storage_path(name)
    or split_part(name, '/', 1) = auth.uid()::text
  )
  with check (
    not public.is_test_profile(auth.uid())
    or public.is_sandbox_storage_path(name)
    or split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists "test logins write only their sandbox (delete)" on storage.objects;
create policy "test logins write only their sandbox (delete)" on storage.objects
  as restrictive for delete to authenticated
  using (
    not public.is_test_profile(auth.uid())
    or public.is_sandbox_storage_path(name)
    or split_part(name, '/', 1) = auth.uid()::text
  );
