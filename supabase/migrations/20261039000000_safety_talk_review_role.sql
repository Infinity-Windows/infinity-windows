-- Illustration approval and safety talk edits are lead decisions. The existing
-- broad safety_talks policy remains for crew reads; this restrictive UPDATE
-- policy is combined with it so a direct API caller cannot approve an image
-- by editing visual_aids_json without the foreman floor.
create policy "foreman updates safety talks"
  on public.safety_talks
  as restrictive
  for update
  to authenticated
  using (not public.is_partner_user() and public.my_role_rank() >= 1)
  with check (not public.is_partner_user() and public.my_role_rank() >= 1);
