-- The new design is for everyone (Matt, 2026-11-21).
--
-- profiles.ui_design was added with default 'classic' (20261031000000), so a
-- person who never opened Settings stayed on the classic screens. The column
-- cannot tell "never chose" from "chose classic", so everybody is moved to the
-- new design once, here. Nothing is taken away: Settings still offers the
-- switch back (set_my_ui_design), and the owner's master switch
-- (company_settings.new_design_r1_enabled) still sends everyone to classic at
-- once if it is ever needed.
--
-- New people start on the new design from now on.
alter table public.profiles alter column ui_design set default 'new';

update public.profiles
   set ui_design = 'new', updated_at = now()
 where ui_design = 'classic';

comment on column public.profiles.ui_design is
  'Which front door this person uses: ''new'' (the default since 20261130190000) or ''classic''. Written only through set_my_ui_design(); the authenticated role holds SELECT but not UPDATE on it, matching language, role and pin_hash. The owner''s master switch (company_settings.new_design_r1_enabled) overrides it app-wide.';
