# Synthetic staging-evidence projection (held design prototype)

**Scope: synthetic. runtimeAuthority: none.** This is a pure, unloaded design
model plus its acceptance tests. It is not a queue, API, migration, production
mount, capture path or permission grant. No app source loads it. The full
Work/Data redesign remains held; this closes only the historical
immutable-projection and conservation gap named in
`STAGING-EVIDENCE-SYNTHETIC-CONTRACT.md`.

- Model: `scripts/design-prototypes/staging-evidence/model.mjs`
- Acceptance: `scripts/design-prototypes/staging-evidence/model.test.mjs` (`node --test`, groups S01–S12)

Every approval, admission and restore fence in the input is a **supplied
external fixture assumption**. A projection that passes means the supplied
evidence is structurally consistent, never that a person was authenticated,
a permission was verified or a restore was safe. The four open owner policies
(live unverified clock boundary, additional paid waiting budget,
different-verified-session original unattempted action, unreadable
allocation history / cross-generation safety) are not chosen here.

## What the model decides, and what it refuses to decide

| It does | It never does |
|---|---|
| Checks one pool's contributions add up exactly | Derive a total, remainder or missing zero |
| Projects each selected allocation line as `project_bound` only under an exact external assertion | Treat a newer intake link as approval or as a retarget |
| Keeps every accepted link target of an intake as a retained origin | Let unlink, relink or an older head drop a dependency |
| Uses the explicitly selected head for each contribution and intake | Choose a head by recency, array order, counter or time |
| Returns one shared generic refusal | Explain which check failed, or expose a label, ID, count or total |

There are no percentages and no time arithmetic. Amounts are opaque
non-negative safe-integer units supplied by the fixture.

## Strict input schema

Every object has exactly the listed keys: an unknown key (for example
`approved`, `role`) or a missing key refuses. There is no coercion: `"1000"`
is not `1000`. Plain objects and arrays only. Accessors, symbols, cycles,
sparse arrays, non-finite numbers and an own `__proto__` key all refuse.
Getters are never invoked. A non-cyclic object referenced from several places
is **not** refused: each occurrence is copied separately, counted against the
node bound, so the private copy shares no nodes (S12).

- **UUID**: canonical lowercase version 1–8, RFC variant (the nil UUID refuses).
- **Token**: `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` and not all zeros.
- **Units**: safe integer ≥ 0 (no `-0`). Line and assertion units must be ≥ 1.
- **Every running sum** is checked to stay a safe integer.
- **Labels**: 1–200 UTF-16 units, kept verbatim (no trimming, no
  normalisation, no identity by name).
- **Bounds**: 500 contributions, 500 intakes, 5000 revisions of each kind,
  64 lines per revision, 5000 assertions, 5000 entries per cover list,
  nesting depth 12, 200000 nodes.

```text
Input = {
  scope: "synthetic",
  restoreFenceAssumption: Token,
  pool: { poolId: UUID, totalUnits: Units },              // must equal Σ contribution units
  contributions: [ { contributionId: UUID, personId: UUID, units: Units, allocationRootRevisionId: UUID } ],   // ≥1, one per person
  intakes: [ { intakeId: UUID, originalLabel: Label, originContext: ProjectProof|null, rootRevisionId: UUID } ],
  resolutionRevisions: [ { revisionId: UUID, intakeId: UUID, parentRevisionId: UUID|null,
                           action: "root"|"link"|"unlink", target: ProjectProof|null } ],
  allocationRevisions: [ { revisionId: UUID, contributionId: UUID, parentRevisionId: UUID|null,
                           lines: [ { lineId: UUID, intakeId: UUID, units: Units≥1 } ], unallocatedUnits: Units } ],
  projectionAssertions: [ { assertionId: UUID, contributionId: UUID, allocationRevisionId: UUID, lineId: UUID,
                            intakeId: UUID, units: Units≥1, resolutionRevisionId: UUID, target: ProjectProof } ],
  selection: { allocationHeads: [ { contributionId, revisionId } ], resolutionHeads: [ { intakeId, revisionId } ],
               projectionAssertionIds: [UUID] },                   // required; unique; [] is a valid explicit choice
  admission: { kind: "supplied_disclosure_assertion", status: "admitted", poolId: UUID, restoreFence: Token,
               selection: <same shape as selection>,
               covers: { contributionIds: [UUID], personIds: [UUID], intakeIds: [UUID], projects: [ProjectProof] } }
}
ProjectProof = { projectId: UUID, domain: "live"|"test", sourceVersion: Token, rootId: Token,
                 eventId: Token, incarnation: Token, restoreFence: Token }
```

### Rules

1. **Identity.** Pool, contribution, person, intake, revision (both kinds) and
   assertion UUIDs share one namespace and must all be distinct. A person has
   exactly one contribution. A line ID is unique within its revision and may
   be reused by a later correction of the same line. Two intakes with the same
   label are two intakes.
2. **Conservation.** In every allocation revision, not only the selected one,
   the line units plus `unallocatedUnits` must equal the contribution's units.
   Σ contribution units must equal `pool.totalUnits`.
3. **Chains.** For each intake and each contribution, the revisions form one
   complete single-parent chain from the declared root:
   - only the root has a `null` parent, and only a resolution root has action `root`;
   - a missing parent, a parent belonging to another owner, two accepted
     children of one parent (a fork), a second root or a cycle refuses.

   Nothing is repaired or rebased.
4. **Selection.** There is exactly one head for every contribution and every
   intake, and it must belong to that owner. Any revision in the chain may be
   chosen, including an older one. `projectionAssertionIds` lists exactly
   which assertions apply. It is compared as a set, and input order never
   matters. The selection is the caller's explicit recipe; it approves
   nothing.
5. **Projection assertions** (I19 / DESIGN-CHECKPOINT-2 DESIGN.md:53).
   - **Every provided assertion, selected or not, is structurally
     validated.** It must name an existing line of that contribution's
     allocation revision, with the same intake and units. It must name a
     `link` revision of the same intake whose target tuple equals the
     assertion's target exactly.
   - At most one provided assertion may occupy each (revision, line) slot,
     even if none of them is selected. A malformed or slot-duplicating
     unselected assertion refuses the whole evaluation. A valid unselected
     assertion may reference an unselected allocation or resolution revision.
   - **Only selected assertions bind.** Each selected ID must exist and sit on
     the selected allocation head. Its link revision must be the selected
     resolution head or an ancestor of it. A dangling, unknown, duplicate or
     out-of-ancestry ID refuses.
   - A line with no selected assertion stays **pending**. A newer link, or a
     newly appended assertion that is not selected, never approves or
     retargets labor. Approved labor keeps its asserted target even when the
     intake is later relinked.
   - An explicit allocation correction (a new child revision with its own
     selected assertions) produces a new projection. Re-selecting the earlier
     head and earlier assertion IDs reproduces the earlier export byte for
     byte. A correction never inherits an earlier revision's assertion.
6. **Retained origins.** For each intake, these are its `originContext` plus
   every `link` target anywhere in its accepted history, independent of the
   selected head.
7. **Admission.** The supplied disclosure assertion must:
   - be `admitted`;
   - bind the same pool, fence and (order-independent) selection, including
     the same assertion ID set;
   - cover every contribution, person and intake, and every retained-origin
     project tuple.

   `role`, `approved`, labels and visible UUIDs are not admission. Any
   failure is the generic refusal.
8. **Project proof.** The full tuple is compared exactly; a UUID alone is
   never enough.
   - A changed root, event, incarnation, source version or domain under the
     same project UUID refuses.
   - An absent field, an unknown domain or an all-zero token refuses.
   - Every proof must carry `restoreFence === restoreFenceAssumption`, so a
     changed external fence makes every older binding stale.

## Output

The output is deterministic, deep-frozen and built from a private copy, so it
never aliases the input. The input is never written. It has two separate
pieces:

- **`historicalExport`**: depends only on the explicit selection and the
  records it names. Its `JSON.stringify` is the only canonical historical
  export.
- **`disclosureAssessment`**: the current full-history dependencies that the
  supplied admission had to cover. This piece may grow as later records
  arrive; the export does not.

```text
{ kind: "synthetic_projection_assessment", runtimeAuthority: "none", scope: "synthetic", confirmationBasis: "supplied_fixture_assertion",
  historicalExport: {
    kind: "synthetic_projection", runtimeAuthority: "none", scope: "synthetic", confirmationBasis: "supplied_fixture_assertion",
    poolId, totalUnits,
    selection: { allocationHeads, resolutionHeads, projectionAssertionIds },   // canonical, sorted
    originalIntakes: [ { intakeId, originalLabel, originContext, rootRevisionId } ],
    totals: { projectBoundUnits, pendingUnits, unallocatedUnits },            // sums to totalUnits
    contributions: [ { contributionId, personId, units, allocationRevisionId,
                       projectBoundUnits, pendingUnits, unallocatedUnits,     // sums to units
                       shares: [ { lineId, intakeId, intakeOriginalLabel, units,
                                   state: "project_bound"|"pending", assertionId|null, resolutionRevisionId|null, target|null } ] } ],
    projects: [ { target: ProjectProof, projectBoundUnits } ] },              // one bucket per exact tuple
  disclosureAssessment: {
    basis: "supplied_disclosure_assertion",
    retainedOrigins: [ { intakeId, originalLabel, rootRevisionId, selectedResolutionRevisionId, origins: [ProjectProof] } ] } }
```

The export carries no current coverage, ledger digest, count or unselected
later record. Every admission check runs before either piece is built. A
refusal is always the same frozen `{ kind: "refused" }`, with no partial
export and no dependency fields. Arrays are sorted by ID (or by the exact
tuple), never by input position. Neither piece has an `authenticated`,
`permissionsVerified` or `restoreSafe` field.

## Worked example (the S01 fixture)

IDs are `00000000-0000-4000-8000-0000000000NN`, written here as `#NN`. Proof
X is project `#100` with tokens `src-7`, `root-100`, `event-100`, `inc-100`
and `fence-1`, in the live domain.

| Input | Value |
|---|---|
| Pool `#01` | 9000 units |
| Person `#20` (contribution `#10`) | 5400 units. Revision `#30`: 3000 → intake `#40`, 1400 → intake `#42`, 1000 unallocated |
| Person `#21` (contribution `#11`) | 3600 units. Revision `#31`: 2600 → intake `#41`, 1000 unallocated |
| Intakes `#40` and `#41` | Both labelled "Smith residence (pending)"; both linked to X (revisions `#52`, `#53`) |
| Intake `#42` | "Warehouse rework — unnamed"; root revision only (unlinked) |
| Assertions | `#70` binds revision `#30` line `#60` (3000) to link `#52`/X. `#71` binds revision `#31` line `#62` (2600) to link `#53`/X. Selected IDs: `#70`, `#71` |
| Admission | Binds the same selection (including IDs `#70`, `#71`) and covers both people, all three intakes and X |

Result:
- totals: 5600 project-bound, 1400 pending, 2000 unallocated (= 9000);
- person `#20`: 3000 / 1400 / 1000; person `#21`: 2600 / 0 / 1000;
- projects: one X bucket of 5600;
- disclosure assessment retained origins: `#40` → [X], `#41` → [X], `#42` → [].

## Acceptance groups

Positive fixtures select `#70`, `#71` (base and relinked) and `#71`, `#72`,
`#73` (corrected). Restoring allocation head `#30` explicitly re-selects
`#70`, `#71`. No helper auto-selects provided assertions.

| Group | Witness |
|---|---|
| S01 | Two contributions totalling 9000 split exactly per person and per pool. The outer and nested markers and exact key sets are checked; the export has no `retainedOrigins` or coverage. A wrong pool total refuses. |
| S02 | Two same-named intakes resolving to X count once (5600). Both originals are kept. Deselecting one assertion (with re-admission) makes only that share pending. A dangling selected ID refuses. |
| S03 | Linking `#42` to Y and relinking `#40` to W changes no total. `#60` stays bound to X via `#52`. W is retained as an origin in the disclosure assessment. |
| S04 | (a) Later link → unlink → relink records under the original heads and IDs with full X/Y/Z coverage reproduce the old export bytes, while the assessment gains Y and Z. Omitting Z refuses. A later link child of the selected head to V also leaves the export byte-identical. (b) An appended unselected `#74` changes nothing (1400 pending). Selecting `#70`, `#71`, `#74` with matching admission gives 7000 / 0 / 2000. Restoring `#70`, `#71` returns the old bytes. Changing the selection without matching admission refuses. (c) Correction `#32` changes the export. Head `#30` with IDs `#70`, `#71` returns the old bytes. A correction without its own selected assertion stays pending. |
| S05 | An earlier head is honoured. Reversing every array and key order, or only the selected IDs, or only the admission lists, gives an identical export and assessment. Base with a later link `#55`/Y and assertion `#74` under head `#54` keeps the base export; selecting `#74` there refuses. The following refuse: a missing, non-array, malformed, duplicate or unknown ID; an ID off the selected allocation head; an ID outside the selected ancestry; admission binding different IDs; a malformed unselected assertion; a duplicate slot even when unselected; a missing, duplicate or foreign head. An explicit empty ID list is valid. |
| S06 | Missing parent, cycle, cross-intake parent, link fork, allocation fork and second root all refuse with the identical object. A linear extension is accepted. |
| S07 | Duplicate contribution, person or line; reused revision ID; fractional, string, negative or unsafe amounts; zero line; missing `unallocatedUnits`; `approved` key; overflow; nonconservation — all refuse. The exact `MAX_SAFE_INTEGER` pool is accepted. |
| S08 | Unlink/relink history `#42`: Y → (unlink) → Z. Without Y covered, every head (`#58`, `#57`, `#54`) refuses, and selecting fewer assertions never shrinks the required coverage. An anchored origin context is also required and appears in `originalIntakes`. |
| S09 | Missing, denied, stale-fence, other pool, other selection, other assertion IDs, partial cover, `role: "Owner"`, `approved: true` and wrong kind all return the same refusal, with no export or assessment. |
| S10 | A changed root, event, incarnation, version or domain under the same project UUID (in the assertion or the link), an unknown domain, a zero incarnation, an absent field or a UUID-only target cannot confirm. |
| S11 | Byte-identical restored inputs are indistinguishable. A new fence with old proofs refuses. Rebinding every proof to the new fence passes: the limitation witness. |
| S12 | Repeatable on deep-frozen inputs. Inputs and earlier outputs are unchanged. Output is frozen and shares no references with the input. A proof object shared by three input positions is copied per occurrence and projects like unaliased input. Object and array cycles refuse. Getters are never read. An own `__proto__` key refuses. The model source has no module loading, wall time, randomness, crypto, network, storage, timers, globals, console or percentage. |

## Limitations (explicit)

- **No real authority.** Admission, projection assertions and the fence are
  supplied fixture assumptions. The model checks their structural consistency
  only: no authentication, no permission check, no grant.
- **Restore is indistinguishable.** Byte-identical restored inputs produce
  identical output. A changed supplied fence rejects old bindings, but the
  model cannot attest that a fence is genuine, current or correctly derived
  (S11).
- **Reproducibility is conditional.** Byte-identical historical export
  assumes the selected records are unchanged and immutable, with the same
  pool, contribution and intake scope. The pure model cannot attest
  append-only storage or where the external fence came from. The selection
  is a caller recipe and approves nothing.
- **No lifecycle policy.** It has no terminal closure, domain A→B→A detection,
  purge, relink or restore recovery policy. Unknown or contradictory lifecycle
  evidence refuses; nothing is inferred or repaired.
- **Conservative fence rule.** Every proof, including historical origins, must
  carry the current fence, so any fence change refuses the whole evaluation.
  A finer rule would need an owner-reviewed policy.
- **Unsupplied project/pending split.** The project-bound versus pending split
  is derived from assertions, never supplied by the caller. A supplied
  "project units" figure would itself be an unverified approval claim. Lines
  and `unallocatedUnits` are explicit inputs.
- **Not covered.** Payroll mapping, multi-job grants, epochs, production
  intake, notifications, CI enrollment and release all remain held. Root owns
  test execution and enrollment.
