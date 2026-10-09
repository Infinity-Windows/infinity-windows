# Linux staging source checkpoint 1 — held for exact review

Outcome: reviewable source/helpers and a deterministic local content package are staged. No app build, dependency install, config/list, server, browser, cloud publication, workflow dispatch, provider or DB action was performed. This is source preparation, not runtime enrollment or evidence that Linux works.

In plain language: the package carries the exact old/new app files already used in the failing test, plus the four small replacement workers. It refuses changed or missing files instead of rebuilding the app. The proposed Linux runner keeps a test assertion failure separate from missing or broken diagnostic evidence, so a failed test cannot be mislabeled as a successful capture.

## Exact artifacts

- `payload/frozen/PWA-RESPONSE-EXPERIMENT-RUNTIME-ENROLLMENT-2`: byte-exact frozen33 source, manifest SHA f9a6acc93ca66e3d9a329567fc62a0c42db4406fc1fc5d1ce11ace6daa96741c.
- `payload/PWA-RESPONSE-EXPERIMENT-RUNTIME-ENROLLMENT-2`: new source33 copy; exactly two existing files changed, shown in RUNTIME-SOURCE-DIFF.patch. POSIX exec prefixes the single existing server command. Adapter records parentSignalObserved and childExitSignal and computes interrupted only after successful after-attestation. No validator change, new adapter wait or extra adapter signal.
- Runtime pins remain byte-exact in this local source copy. Future bind-execution changes only playwrightCLI and seven runtimeSources keys, with eight explicit diffs, unchanged hash values and all other JSON values unchanged.
- `payload.tar`: **21,585,920 bytes**, 754 regular files, raw SHA **4a4da653a872ddc8dbf3ec1d75e2f5e2b1b2133dd9f641f0af4d3c8c694508af**. Payload bytes21,006,386, including original/delta minimum20,193,746. No symlinks/hardlinks/extended tar entries. Sorted USTAR, uid/gid/mtime0, mode0444. TRANSPORT-MANIFEST SHA **d0a8a7fee0c0d88e770d39371b7037210bde52cae7a9461f21507bc32c0ad5c0**.
- Exact A703 package/lock and seven supplemental sources were read using git show from project-pwa-diagnostic; Git object IDs/commit/SHA receipts are in payload/provenance/GIT-OBJECTS.json. No repository mutation occurred.
- New external transport/reconstruction/binding/preflight/Node receipt/resolution/driver source plus PACKAGE-RECIPE.md and PROPOSED-WORKFLOW.yml.txt. No workflow was enrolled.

## Source boundary and lifetime

The frozen33 copy stays separate and never gains a dependency link. Future execution33 first proves SOURCE-FILES, then receives only the permitted pin path transformation. New reviewed additions are explicitly recorded outside the runtime in EXECUTION-ADDITIONS: exactly one runtime/app/node_modules link to scratch/dependencies/app/node_modules, and one copied runtime/app/resolution-probe.mjs with an exact helper hash. The probe stays through after-checks. Every other new helper/receipt is external. verify-stage independently enforces this set; it does not treat arbitrary runtime extras as allowed.

Historical44 Mac path occurrences are transported unchanged with the exact prior inventory. Executable rebinding is limited to eight pin fields; Linux path/source/trace bindings and the new run plan are external. No /Users aliases or paths were created on Linux. Off is verified through transport pins and is never added to runtime variants or executed as an arm.

## Checks and evidence

VALIDATION.json records actual commands and exits. **55 Node tests +6 Python tests passed** (45 inherited runtime tests,7 staging/driver,3 actual-adapter-body lifecycle,4 transport,2 reconstruction). All new MJS syntax and Python AST checks passed. Tests never import config or Playwright runtime. Fake child tests cover exit failure, executable refusal and process-group timeout. Real adapter body is evaluated with substituted I/O to exercise signal fact ordering and failed-after refusal. Synthetic reconstruction checks independent inodes/read-only bytes, exact originals, all four330+330 pairs and nonworker-edit refusal. This is not a Linux test.

The unchanged original strict verifier passed against both the existing original660 and the transported copy. INPUTS-BEFORE/AFTER are identical: frozen runtime33, original660, existing derived2640, and delta files. Transport tar's full names/sizes/hashes/types are checked. No preexisting file was changed. New copied source initially retained read-only modes; only owned copies were made writable for source edits. A Mac /tmp symlink was correctly rejected by a fixture and the test moved to its canonical path. A timer-edit typo was caught by the fake-child test and fixed; final all61 pass. These test-development corrections did not change runtime source scope.

## Held gates and recommendation

Recommend root review the two-file patch first, then the new transport/binding/driver boundaries with actual Opus5.5 and Fable. Those exact-source reviews are **PENDING**; neither peer was contacted by this worker and no participation/agreement is claimed. Earlier actual Plan1/Plan2 source-scope receipts do not approve this checkpoint's new code or execution. Parent owns peer routing; no recursive delegation occurred.

Stop at this source/package checkpoint. Concrete remaining work before cloud execution:

1. Independent exact implementation review and root receipt, including dependency resolution probe lifetime and driver stop classifications.
2. Immutable checkout/upload action SHA and approved source/publication commit. Proposed workflow is held text with unresolved pins and a deliberate failing setup step.
3. Reviewed orchestration for root-manifest verification, official Node/cloud npm/Chromium setup, concrete staged-browser executable path/hash metadata recording, READY creation and always-upload evidence/clock handling. PACKAGE-RECIPE defines these acceptance requirements; these orchestration pieces are not fully authored or tested here.
4. Actual Linux availability/install/source-resolution/binary receipts and browser five-field/category gates. Node v22.23.1 binary differs from Mac; A703 patch is UNKNOWN. No protocol parity claim.

The driver reserves100 seconds (65 teardown +35 validation) within its25-minute monotonic block, and recipe requires GNU timeout1495s plus5s forced termination to bound synchronous checks. Setup30 + block25 + upload10 fits under proposed job70. A complete assertion failure may continue; launch/pin/capture/validation/incomplete/timeout aborts all later arms. Every arm retains zero retries and all original assertions. No engine mechanism or public-worker identity conclusion is established.

Ownership ends at this frozen output folder. Parent may coordinate routine source-gate completion and actual peer review; do not publish or execute from this receipt alone.
