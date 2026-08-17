# 03 — Persistence + recompute RPC

Status: resolved
Type: task
Blocked by: 01

Migration: `project_openings` gains `signature jsonb`, `sig_key text`, `sig_computed_at timestamptz`. Security-definer RPC `recompute_signature(p_opening_id)` (house pattern: reads open, RPC-only writes) computing server-side from the stored spec row / studio-catalog config + story + `extra.inset_outset`, mirroring the client lib's canonical encoding (shared fixtures pin the two together).

Call sites: after spec upsert/confirm, after Re-read specs completes, after a Studio unit save or catalog link for a mark, after trace submit changes stories. Register the columns in `scripts/supabase_merge_lib.py` (no new table — no DEDUP_KEYS entry) and keep `scripts/test_supabase_merge.py` green.

## Comments

2026-08-16 — Built. One deviation from the ticket's letter, recorded honestly: full server-side recomputation isn't possible today because STORY is derived from client-side trace geometry. The no-drift guarantee lands where it matters instead — `set_unit_signature(p_opening_id, p_signature)` derives the canonical `sig_key` ITSELF via a plpgsql `canonical_jsonb` (alphabetical keys, "C" collation = byte order, matching the TS `canonicalJson`) and validates the v1 shape (version, kind, corner, tiers ≥ 1, insetOutset domain, numeric counts) — a client can never store a malformed or mislabeled signature. Client side: pure `planSignatureUpdates` (catalog-beats-spec priority, unchanged keys skipped, no config → no signature) + `syncProjectSignatures` fire-and-forget at all four moments: spec confirm (one + all), Re-read completion, Studio catalog save, trace submit.
