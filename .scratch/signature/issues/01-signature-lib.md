# 01 — Pure signature library

Status: resolved
Type: task

Build `app/src/lib/estimate/signature.ts`: `computeSignature(config: UnitConfig, facts: { story: number | null; insetOutset: "inset" | "outset" | null }): { signature: SignatureV1; sigKey: string }` with the canonical encoding from `.scratch/signature/spec.md` (sorted keys, no whitespace, `v: 1`).

- Mechanism tally keys: `fixed`, `slider`, `sliderx2`…`sliderx8` (via `slideCountOf`), `casement`, `hung`, `bifold`. Direction excluded.
- `corner` collapses to `"none" | "corner"`.
- Unit tests: window 16 fixture reproduces the spec's worked example key; XO vs OX identical; left vs right corner identical; widths irrelevant; slide counts split the tally; null story and null insetOutset serialize as null.

## Comments

2026-08-16 — Built as `app/src/lib/estimate/signature.ts` (computeSignature + canonicalJson) with 8 tests in `signature.test.ts`: the spec's window-16 key reproduced verbatim, XO=OX, corner sides merge, widths irrelevant, slide counts split the tally, nulls honest, doors carry kind. Corner validity reuses `cornerLegs` so the signature and the geometry can never disagree about what counts as a corner.
