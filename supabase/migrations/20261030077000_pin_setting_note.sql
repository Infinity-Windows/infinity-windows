-- Crew announcement for setting your own PIN on Settings (docs/app-updates.md),
-- in the same change as the move. It sat on the Roster, which only supervisors
-- and owners can open (#610), so installers and foremen could not set, change
-- or remove a PIN at all. All four audiences: supervisors and owners find it
-- in a new place too. Words quoted as the phone prints them: the PIN card's
-- remove button is pin.setter.clear (Clear, Quitar PIN) and the page title is
-- settings.pageTitle (Ajustes) in lib/i18n/catalog.ts. The menu row reads
-- Settings in both languages (lib/nav.ts labels are English), which is why the
-- Spanish names both; it sits under Help for installers and under Account for
-- everyone else, so the note says "in the menu" and no more. "dueños" is the
-- catalog's own word for owners (joinCrew.role.owner).
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-25-pin-setting','2026-09-25',array[0,1,2,3],'improvement',
 'Set or change your Forge PIN in Settings','Pon o cambia tu PIN de Forge en Ajustes',
 'In Settings, in the menu, you can set a 4-digit PIN, change it, or remove it with Clear. It used to be on the Roster, which only supervisors and owners can open. With a PIN, Forge asks for it each time it opens.',
 'En Ajustes puedes poner un PIN de 4 dígitos, cambiarlo o quitarlo con Quitar PIN. En el menú aparece como Settings. Antes estaba en el Roster, que solo abren los supervisores y los dueños. Con un PIN, Forge te lo pide cada vez que se abre.',
 '/settings') on conflict(id) do nothing;
