# 01 — Pure signature library

Status: ready-for-agent
Type: task

Build `app/src/lib/estimate/signature.ts`: `computeSignature(config: UnitConfig, facts: { story: number | null; insetOutset: "inset" | "outset" | null }): { signature: SignatureV1; sigKey: string }` with the canonical encoding from `.scratch/signature/spec.md` (sorted keys, no whitespace, `v: 1`).

- Mechanism tally keys: `fixed`, `slider`, `sliderx2`…`sliderx8` (via `slideCountOf`), `casement`, `hung`, `bifold`. Direction excluded.
- `corner` collapses to `"none" | "corner"`.
- Unit tests: window 16 fixture reproduces the spec's worked example key; XO vs OX identical; left vs right corner identical; widths irrelevant; slide counts split the tally; null story and null insetOutset serialize as null.

## Comments
