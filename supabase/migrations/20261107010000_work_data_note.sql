-- Supervisor/owner-only notice for the read-only report slice. Capture,
-- versioned configuration and field verification remain separate work.
insert into public.app_release_notes
  (id, published_on, audience, kind, title_en, title_es, body_en, body_es, href)
values
  ('2026-10-03-work-data-evidence', '2026-10-03', array[2,3], 'improvement',
   'Follow work evidence in Data', 'Consulta la evidencia del trabajo en Datos',
   'In the new design, Data connects a job''s recorded payroll to original work sources, showing classified, unknown and conflicted time. Activity hours explain the same paid time and never add pay. Unit-area exclusions show missing verification or final QC instead of guessing an average. Older breaks without exact positions keep the paid shift unknown. The existing reports and filters remain in Summary. Classic keeps its current Data page.',
   'En el diseño nuevo, Datos conecta la nómina registrada de una obra con las fuentes originales del trabajo, mostrando tiempo clasificado, desconocido y en conflicto. Las horas de actividades explican el mismo tiempo pagado y nunca añaden pago. Las exclusiones de área muestran verificaciones o aceptación final de calidad faltantes, sin adivinar un promedio. Los descansos anteriores sin posición exacta dejan el turno pagado como desconocido. Los informes y filtros existentes siguen en Resumen. Clásico conserva su página actual de Datos.',
   '/data')
on conflict (id) do nothing;
