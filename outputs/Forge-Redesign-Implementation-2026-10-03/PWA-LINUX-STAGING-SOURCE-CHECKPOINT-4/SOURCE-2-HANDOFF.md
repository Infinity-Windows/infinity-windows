# Linux staging source checkpoint 2 — peer corrections, held

This checkpoint fixes both required Opus findings and all three Fable hardening recommendations in new external helper/test source. Checkpoint1 remains byte-exact. No app build, config/list, server, browser, installation, Git mutation, cloud dispatch, provider or DB action occurred.

Plain summary: an environment switch that could split Playwright into two loaded copies is now refused. The driver counts its entire process lifetime against the time limit and writes a permanent failed/incomplete receipt when the watchdog stops it. The archive extractor uses the exact bytes it already checked, so replacing the archive file cannot redirect extraction outside its folder.

## Changes and evidence

- Both cleanEnvironment and the app resolution probe refuse NODE_PRESERVE_SYMLINKS even if empty and record it as null. Existing NODE_PATH/NODE_OPTIONS/execArgv checks remain.
- Driver deadline is **1470 seconds from Node process timeOrigin**, including driver startup and preflight. Child-group TERM at1370s and KILL at1435s preserve65 seconds teardown plus35 seconds validation before that deadline. Proposed outer GNU watchdog remains TERM1495s/KILL1500s, leaving25/30 seconds margin. Cloud install/setup remains outside the driver. The threshold to start an arm remains100 seconds before the internal deadline, so a late arm can fail closed; successful completion is never promised.
- A driver-level SIGTERM/SIGINT handler is installed before environment/plan/Python/source validation and remains installed until process exit. Its terminal receipt is sticky: watchdog records completed:false and stopReason:watchdog immediately; all later save/finally attempts are ignored. Async validation subprocesses keep the signal handler active. An event-loop turn before acceptance allows pending signals to be processed. Budget exhaustion after the fourth result still cannot claim completion.
- Transport reads a single bounded immutable snapshot, hashes/validates it before any destination writes, then extracts that same buffer. Names, membership, sizes and hashes are also checked immediately before each write. The payload/tar are unchanged.
- Reconstruction tests assert exact old330, new329 nonworker and replacement-worker bytes for each of four synthetic pairs, as well as independent inodes and preserved originals. New Node/Python scratch tests clean their owned directories with cleanup hooks; no scratch litter remains.
- Nonblocking Opus points: the Linux plan now receives realpathSync(node). Exact pinned metadata for playwright, playwright-core and @playwright/test1.62.0 was read offline and SHA-checked; all three export ./package.json. OFFLINE-PACKAGE-EXPORTS.json records this. No package imports or Linux resolution execution occurred.

DIFF-FROM-SOURCE-1.patch and SOURCE-CHANGES.json show11 changed external source/test/recipe files. Runtime source copies and RUNTIME-SOURCE-DIFF.patch are untouched; the two original runtime fixes remain exactly as source1. The frozen33/source33 distinction, eight future pin path changes, one app dependency link and explicitly inventoried app resolution-probe lifetime remain intact. Changing the external probe updates the future copied-probe hash; it does not mutate the held runtime33 or transport.

## Verification and immutable material

**60 Node +8 Python tests passed**, all new MJS syntax/Python AST checks passed. Tests include a real self-SIGTERM in a fake child while its fake validation is awaiting, followed by attempted success writes; the saved terminal watchdog receipt remains incomplete. Fake histories cover startup consuming the budget, no arm after preflight budget exhaustion, late fourth-arm completion refusal, and watchdog before/during validation. The archive replacement test swaps the file after full validation and proves only original validated content is written, with no escape path. These are offline helper tests, not a Linux experiment.

The unchanged strict verifier passed against existing and staged original660. Source1 preservation independently re-hashes all793 listed files and its manifest, verifies no extra files, and compares both payload trees. Source1 root manifest remains **e525f4e245d12ad9efd8bd300b0996c65c3ceffe6c98e3f68ec1a3b148778628**. Original660, existing derived2640 and frozen runtime33 before/after inventories still match. SOURCE-1-PRESERVATION.json and VALIDATION.json are current; SOURCE-1-* documents retain historical source1 receipts separately.

Transport remains **754 entries**, **21,585,920 bytes**, SHA **4a4da653a872ddc8dbf3ec1d75e2f5e2b1b2133dd9f641f0af4d3c8c694508af**. TRANSPORT-MANIFEST SHA remains **d0a8a7fee0c0d88e770d39371b7037210bde52cae7a9461f21507bc32c0ad5c0**. Both package/tar inventories and all payload/runtime bytes are identical to source1.

## Review boundary and next action

Actual source1 receipts are copied with precise scopes: Opus claude-opus-5-5 session26f107f9-3a41-4e06-b5c4-bbcd187d44f1 required the two fixes; Fable claude-fable-5-1 session8e799e3b-b34a-4b7d-9fbb-ac541c947bcc approved held transport/reconstruction and recommended the three hardenings. They reviewed source1, not these corrected source2 bytes; neither executed/hashes-verified the package. PEER-RECONCILIATION.json records implemented findings and pending source2 review. No worker peer contact or delegation occurred.

Recommend parent review the exact external helper diff and route bounded confirmation to actual peers. Cloud setup/READY/browser-executable metadata source, immutable workflow/action/source pins, publication and runtime remain separate unimplemented gates. No such missing orchestration was authored here. PROPOSED-WORKFLOW.yml.txt remains held with unresolved pins and a deliberate failing setup step. Nothing in this checkpoint authorizes running it.
