-- Wave A, A3: the AI badge on the board. schedule_assignments gains
-- created_via — 'ai' when wave A2's draft_assignments tool wrote the row,
-- null for everything a human created directly (the crew board, seeding,
-- Repeat/Copy week forward). Same migration file family as A1's saved_crews
-- (20260955000000): both wave A additions, numbered together.
--
-- The flag is permanent, not draft-only: publishing clears nothing (the
-- audit trail — "a human approved an AI plan" — should still be readable
-- after publish). The crew board only RENDERS the "AI proposed" chip while
-- status = 'draft'; that is a client-side display rule, not a data rule, so
-- it belongs in CrewBoard.tsx, not a column default or a trigger here.

alter table schedule_assignments
  add column if not exists created_via text
  check (created_via is null or created_via = 'ai');

comment on column schedule_assignments.created_via is
  'null = a human created this row directly; ''ai'' = wave A2''s draft_assignments tool did (CONTEXT.md: AI-proposed). Never cleared by publish — the audit trail outlives the draft.';
