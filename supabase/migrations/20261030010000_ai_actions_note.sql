-- Crew announcements for Release 2 of the crew redesign ("the AI",
-- docs/app-updates.md): the daily log built in Ask, and the action cards,
-- receipts, one-tap clock buttons and context tag. Every role can use both,
-- so both name all four audiences. Nothing here announces Take supplies,
-- Crew status or Units completed — those are later releases and the cards
-- say so honestly.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-23-ai-daily-log','2026-09-23',array[0,1,2,3],'improvement',
 'Build today''s daily log in Ask','Haz el registro del día en Ask',
 'Say or type what you got done; Forge AI fills the log and you check it. Your part is added under what others wrote — nothing is replaced. Add photos; each shows its own upload status.',
 'Di o escribe lo que hiciste; Forge AI llena el registro y tú lo revisas. Tu parte se agrega debajo de lo que otros escribieron; no se reemplaza nada. Agrega fotos; cada una muestra su propio estado.',
 '/ask') on conflict(id) do nothing;
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-23-ask-actions','2026-09-23',array[0,1,2,3],'improvement',
 'Ask shows what it can do, and says when nothing was saved','Ask muestra lo que puede hacer y avisa cuando no se guardó nada',
 'Ask opens with action cards for your role, and All actions says which things still live on a screen. Every change shows a receipt: Saved in Forge, Needs your choice, or Nothing changed; if a reply only sounds done, Ask says Nothing was saved yet. Forge AI never changes your clock or breaks — say you are going to lunch and it shows a Start break button you tap. Open Ask from a job or unit and it already knows which one you mean.',
 'Ask abre con tarjetas de acciones para tu función, y Todas las acciones dice qué cosas siguen en una pantalla. Cada cambio muestra un recibo: Guardado en Forge, Necesita tu decisión o No cambió nada; si una respuesta solo suena a hecha, Ask dice Todavía no se guardó nada. Forge AI nunca cambia tu reloj ni tus descansos: di que vas a comer y muestra un botón de Empezar descanso que tú tocas. Abre Ask desde una obra o unidad y ya sabe a cuál te refieres.',
 '/ask') on conflict(id) do nothing;
