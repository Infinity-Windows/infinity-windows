-- All internal roles can use the retained custom-work queue. This notice is
-- narrowly about its account-binding correction; new capture remains inactive.
insert into public.app_release_notes
  (id,published_on,audience,kind,title_en,title_es,body_en,body_es,href)
values
  ('2026-10-03-custom-work-account-binding','2026-10-03',array[0,1,2,3],'improvement',
   'Queued custom work stays with its account','El trabajo personalizado pendiente conserva su cuenta',
   'Custom work queued on a device is sent with the same verified account that recorded it. If the account changes while sending, the reply cannot update the new account''s screen or remove the original queued request. The original account can retry using the same request ID. Clock and payroll rules are unchanged. The new activity-capture controls are still being built.',
   'El trabajo personalizado pendiente en un dispositivo se envía con la misma cuenta verificada que lo registró. Si la cuenta cambia durante el envío, la respuesta no puede actualizar la pantalla de la nueva cuenta ni eliminar la solicitud pendiente original. La cuenta original puede reintentar con el mismo identificador. Las reglas del reloj y la nómina no cambian. Los nuevos controles de captura de actividades siguen en desarrollo.',
   '/work')
on conflict(id) do nothing;
