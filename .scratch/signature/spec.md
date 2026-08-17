# Spec: the Signature — the computed key units are grouped by

Status: ready-for-agent
Produced by Session 3 (grill on ticket 1, 2026-08-16). Vocabulary per `CONTEXT.md` — terms are used, not re-explained. Decisions below were grilled and confirmed by the owner; sources of record are named per field.

## What this is

The **signature** is a structured, computed key describing what kind of install job a unit is. All units sharing a signature form a **cohort**; cohort evidence (sessions) feeds the estimating model. Never typed by a human; recomputed whenever its inputs change.

## The shape (v1)

```jsonc
{
  "v": 1,                          // signature version — see Versioning
  "kind": "window",                // "window" | "door"
  "tiers": [                        // v1: exactly ONE tier (Studio can't model more yet)
    {
      "story": 2,                   // int ≥ 1, or null when untraced — null is its own honest value
      "mix": {                      // unordered tally of panels by mechanism(+slide count)
        "fixed": 3,                 // direction NEVER appears: mirror images share a cohort
        "slider": 1,
        "sliderx2": 1               // multi-track slider, slideCount 2 (…x8)
      }
    }
  ],
  "panelCount": 5,                  // total panels across tiers
  "movingCount": 2,                 // panels with mechanism ≠ fixed
  "corner": "corner",              // "none" | "corner" — SIDE is recorded on the unit, not grouped
  "insetOutset": null               // "inset" | "outset" | null (uncaptured — its own cohort)
}
```

**Canonical encoding**: JSON serialized with keys sorted at every level, no whitespace. That string is the `sig_key` — the group-by value. It's deterministic and human-readable; no hash needed.

### Explicitly NOT in the signature

- **Panel widths / heights / weight** — sizes are continuous evidence, not cohort walls (ADR-0002). The per-panel cost scales with the panel's actual weight (from Strata, per panel where possible); the cohort answers "what kind of job", the weights answer "how big is this one".
- **Direction / handedness** — XO and OX are mirror images: same parts, same motions, same time. Splitting mirrors halves every cohort to learn nothing. Same logic collapses corner side into `corner: "corner"` (the side stays as a descriptive field on the unit).
- **Pane breaks / grids** (Studio `rows[]`, spec `grids`) — recorded elsewhere, excluded from v1. If rework/time data later shows gridded units run longer, they graduate to a *modifier*, never a signature field.
- **Free text of any kind** — style strings, names, colors. "Bifold 5 panel" and "5-panel bifold" must be one cohort.

## Source of record (one pipeline, no second parser)

The signature is computed from the unit's **`UnitConfig`-of-record** plus two unit facts — the exact priority "Pull from plans" already uses:

1. The refined **Studio/catalog unit** for the mark, when one exists (`catalogByMark` / placed `metadata.unitConfig`).
2. Else the **spec row** folded through the existing `specToUnitConfig` (`app/src/lib/modelstudio/units.ts`) — which already consumes the extractor's `extra.panels` (per-panel mechanism + widths) and `extra.corner`.

Unit facts joined in:

- **story** — the opening's story from the trace/pins (fitview `w.story`); v1 puts it on the single tier. Null when the job is untraced.
- **insetOutset** — NEW field. Captured exactly like every other spec field: the extractor reads it from the spec sheets (`VISION_SCHEMA` addition in `supabase/functions/extract-specs`), `prepVisionSpec` carries it into `extra`, and spec review confirms it. Null until captured; **never defaulted**.

Field-by-field derivation from `UnitConfig`:

| Signature field | From |
| --- | --- |
| `kind` | `UnitConfig.kind` |
| `tiers[0].mix` | tally of `panels[]` by `mechanism`, key suffixed `x{slideCount}` when `slideCountOf(panel) > 1` |
| `panelCount` | `panels.length` |
| `movingCount` | panels with `mechanism !== "fixed"` |
| `corner` | `cornerAfterPanel != null` → `"corner"`, else `"none"` (side = `cornerAfterPanel` position, stored on the unit only) |
| `tiers[0].story` | opening story fact |
| `insetOutset` | spec `extra.inset_outset` fact |

## Storage & recomputation

- New columns on `project_openings`: `signature jsonb`, `sig_key text`, `sig_computed_at timestamptz`. (A separate table adds a join for zero benefit — the signature is 1:1 with the opening/unit.)
- Written ONLY by a security-definer RPC `recompute_signature(p_opening_id)` (house pattern) called from the app after each event that can change an input:
  - spec upsert / confirm / Re-read specs
  - Studio unit save or catalog link for the mark
  - trace submit that changes the opening's story
- The pure computation lives client-side in a new `app/src/lib/estimate/signature.ts` (`computeSignature(config, facts)`) — unit-tested, and the RPC stores what the client computed *at confirm time*? **No** — the RPC recomputes server-side from stored rows so the client can't drift; the client lib exists for previews and tests. Both implement the same canonical encoding; the unit tests pin them together with shared fixtures.

## Versioning

`v` is part of the signature and the `sig_key`. Definition changes (e.g. tiers arriving when Studio can model them, grids graduating) bump `v` and recompute forward; old sessions keep their unit's current signature — cohorts never silently fracture across definition changes. A `v1` cohort and `v2` cohort are never mixed.

## Fallback ladder mapping (read model)

Exact `sig_key` → same `kind` + `panelCount` → same `kind` → global. A rung shows at n ≥ 5, always labelled with rung + count; below global n = 5: "no estimate yet · N installs recorded" + clearly-labelled manual estimate. Units with `insetOutset: null` exact-match only other nulls and otherwise resolve at the same-kind-and-panel-count rung, where the field doesn't apply.

## Worked example — window 16 (BLACK22)

Five fixed panels (30¼" | 88½" | 90" | 87¾" | 17"), 90° corner after panel 1, ground story, outset unknown:

```json
{"corner":"corner","insetOutset":null,"kind":"window","movingCount":0,"panelCount":5,"tiers":[{"mix":{"fixed":5},"story":1}],"v":1}
```

Every other 5-fixed-panel corner window on any job — either corner side, any widths — lands in this cohort.

## Acceptance

- `computeSignature` is pure, deterministic, and identical for XO/OX mirrors, either corner side, and any panel widths.
- Window 16's fixture (spec `extra.panels` + `extra.corner`) produces the example key above.
- Re-read specs on a job recomputes signatures; hand-editing a Studio catalog unit for a mark recomputes that mark's openings.
- No signature is ever written by a human or from free text.
