# 02 — Inset/outset capture

Status: ready-for-agent
Type: task

New spec field, captured exactly like the panel-widths round (PR #280 pattern):

- `supabase/functions/extract-specs`: `VISION_SCHEMA` gains `inset_outset` ("inset" | "outset" per mark, read from the drawings/notes); add to `RawVisionMark` + `cleanVisionMark` (fixed shape — new fields must be added there).
- `app/src/lib/install/specsVision.ts` `prepVisionSpec`: carry validated value into `extra.inset_outset`.
- Spec review UI: show + confirmable alongside the other fields; never defaulted — blank stays blank.
- Rollout via the existing per-job "Re-read specs" button; confirmed rows untouched, as always.

## Comments
