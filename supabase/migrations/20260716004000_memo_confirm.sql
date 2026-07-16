-- Phase A6: human-in-the-loop confirmation of AI-filled memo fields.
-- Raises training-data quality (installers correct the AI split), and lets us
-- surface a "review AI memos" queue.

alter table install_events
  add column if not exists ai_confirmed boolean not null default false;

-- Mark which events still need a human glance: has a transcript (AI ran) but
-- not yet confirmed.
create index if not exists install_events_unconfirmed_idx
  on install_events (installer_id)
  where transcript_raw is not null and ai_confirmed = false;
