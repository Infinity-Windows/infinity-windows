-- Camera and library photos both use PostgREST ON CONFLICT (client_id).
-- The old partial index cannot be inferred without its WHERE predicate, which
-- PostgREST does not supply. Every attachment upsert failed with 42P10, leaving
-- its original file in the phone's outbox (and sometimes already in storage).
-- A normal unique index still allows multiple NULLs for legacy attachments,
-- while supporting the client's stable retry key. No rows or files change.
drop index if exists public.attachments_client_id_key;
create unique index attachments_client_id_key on public.attachments (client_id);

notify pgrst, 'reload schema';
