-- Owner decisions D08/D09/D22 (2026-09-22): installers use Forge AI for their own
-- field work, so the AI answer floor drops from its foreman default to installer.
--
-- Exactly one column moves, and only from the default: an owner who raised the
-- floor on purpose (supervisor/owner) keeps it. Daily per-person calls, the
-- monthly company cap, the content multiplier, the alert threshold, the
-- enforced switch and the time zone are untouched, so every installer request
-- still meters against the same caps and a disabled or exhausted budget still
-- refuses (docs/ai-spend-limits.md).
update public.ai_spend_limits
set min_role = 'installer', updated_at = now()
where id = 1 and min_role = 'foreman';
