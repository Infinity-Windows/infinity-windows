# 02 — Inset/outset capture

Status: resolved
Type: task

New spec field, captured exactly like the panel-widths round (PR #280 pattern):

- `supabase/functions/extract-specs`: `VISION_SCHEMA` gains `inset_outset` ("inset" | "outset" per mark, read from the drawings/notes); add to `RawVisionMark` + `cleanVisionMark` (fixed shape — new fields must be added there).
- `app/src/lib/install/specsVision.ts` `prepVisionSpec`: carry validated value into `extra.inset_outset`.
- Spec review UI: show + confirmable alongside the other fields; never defaulted — blank stays blank.
- Rollout via the existing per-job "Re-read specs" button; confirmed rows untouched, as always.

## Comments

2026-08-16 — Built: `VISION_SCHEMA` + `cleanInsetOutset` in extract-specs (null unless the sheet literally says — never guessed), `prepVisionSpec` → `extra.inset_outset` validated, and a "Mounts inset or outset" select on each spec-review row (blank = "— not stated —", clearing deletes the key). Rolls out through the existing Re-read specs button.
