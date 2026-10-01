-- Visible only to clients including this immutable announcement ID.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values
  ('2026-10-01-receipt-viewer', '2026-10-01', array[0,1,2,3], 'fix',
   'Open receipts full screen', 'Ver recibos en pantalla completa',
   'Tap a receipt image to view it full screen. Use Zoom in to read small print, and Close to return. PDF receipts still offer Open original for all pages.',
   'Toca la imagen de un recibo para verla en pantalla completa. Usa Ampliar para leer la letra pequeña y Cerrar para volver. Los recibos PDF siguen ofreciendo Abrir original para ver todas las páginas.',
   '/photos')
on conflict (id) do nothing;
