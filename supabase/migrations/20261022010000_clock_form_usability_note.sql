insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-22-easier-clock-and-forms','2026-09-22',array[0,1,2,3],'improvement',
 'Easier clock controls and unit forms','Reloj y formularios más fáciles de usar',
 'The clock panel uses more room on a computer. Keyboard navigation stays inside the panel without jumping during timer updates. Labels line up more clearly when entering unit details.',
 'El panel del reloj usa más espacio en la computadora. La navegación con teclado permanece dentro del panel sin saltos al actualizar el reloj. Las etiquetas están mejor alineadas al ingresar los detalles de una unidad.',null) on conflict(id) do nothing;
