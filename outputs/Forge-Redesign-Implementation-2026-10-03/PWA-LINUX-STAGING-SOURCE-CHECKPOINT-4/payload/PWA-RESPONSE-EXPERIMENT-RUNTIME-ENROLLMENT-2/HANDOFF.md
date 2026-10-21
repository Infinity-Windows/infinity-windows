# Runtime enrollment correction 2 — source only; held for actual dual-peer review

The experiment preparation now chooses the intended test correctly, lets the local server shut down cleanly, and checks the evidence after shutdown. If tracing fails, the original test failure stays visible. The arm is separately marked invalid. These changes make the proposed experiment more trustworthy; they do not fix the app or show what caused its failure.

Ownership: Astra authored only this new output package. Root owns actual Fable/Opus review, dependency enrollment and any later runtime decision. No peers contacted or delegated from this task. No app/worker build, config load, Playwright list, server, browser, installation, CI or provider action occurred.

## Reconciliation of actual reviews

Actual Fable 5.1 session 370d71dc-eb10-4451-8f8f-3673f6a29219 (39 turns) and actual Opus 5.5 resumed session 26f107f9-3a41-4e06-b5c4-bbcd187d44f1 (19 turns) both required corrections to enrollment 1. Their complete receipt result text was read. They have NOT reviewed or approved this new package yet.

- Config imports a file-and-title anchored regex tested against Playwright's joined titlePath, including empty root/project titles. The future runner saves JSON `--list` output and refuses anything other than exactly one unchanged interrupted-download test before starting the arm. No list preflight was run here.
- Config uses shell-quoted process.execPath and a shell-quoted absolute adapter path. webServer adds gracefulShutdown SIGTERM with 60 seconds; reuseExistingServer remains false. Archive reuse is separate and mandatory. No fallback build exists on the proposed path.
- The existing spec and all its assertions are byte-identical A703. finish() records incomplete capture with ARM-INVALID and never throws observation errors through the spec's finally. It attempts browser-session detach even after observation failure, so the subsequent existing page CDP detach remains reachable. Missing/unwritable attachments cannot become a pass: the post-run gate requires the independent receipts and exact trace length.
- run-arm.mjs really invokes validate-run.mjs after Playwright returns, including assertion failure. It keeps test-report.json, test-exit.json and originalTestExit separate from validationExit. Every before/after original and derivative receipt plus harness-exit is mandatory. A SIGKILL or missing shutdown receipt invalidates the arm.
- Both launcher and engine helper independently hash the derivative manifest against its pin and verify the expected new worker hash.
- Output shape, protected overlap (including ancestor/symlink), and exclusive runner/harness locks are extracted and covered by no-contact tests.

## Accepted interpretations, still bounded

Opus accepted no ADDED debugger pause/attachment relative to pinned Playwright. A703's committed package-lock.json and the installed @playwright/test, playwright and playwright-core versions are 1.62.0. The runner pins relevant installed implementation bytes. Playwright's existing Target.setAutoAttach(waitForDebuggerOnStart:true), Runtime.enable and runIfWaitingForDebugger remain declared shared instrumentation in every arm. No core patches or new startup hooks were added.

The exact saved 12-category array, in order, is accepted and preserved in RUNTIME-PINS.json. Browser.getVersion still requires all five exact A703 values, including the Linux x86_64 user agent and Chromium revision. Category names are not expanded from event labels. Wrong browser identity refuses before old-worker registration.

Worker object identity is not engine request identity. targetId and engineRequestId remain null. Early console coverage remains UNKNOWN because Playwright can drop messages before execution-context creation. Capture-valid means only that required evidence exists; it explicitly leaves mechanism and baseline signature UNASSESSED. Missing console pairs or post-clone fallback invalidate evidence eligibility. No absent event is treated as proof of absence.

## Checks and preservation

- 45/45 enrollment tests passed: all prior 26 plus 19 correction tests. Tests use fabricated JSON/temporary files to test refusal and cleanup contracts; these are not runtime proof.
- 43/43 response helper tests passed. Copied TypeScript passes noEmit; all MJS files pass Node syntax checks.
- Original interrupted test, pwa.ts, pwaSlowReloadEvidence.ts and package.json stay byte-identical A703. Original strict archive verifier stays byte-identical and is not changed to accept derivatives.
- Verified 2,762 entries from the four earlier frozen manifests, including all 2,711 rehearsal entries. The unchanged rehearsal verifier rechecked original 660 files, all four derivative pairs, worker parity and source pins. Clean live HEAD remains a703caf274d6e7627cfc2c688ed7c351a55be465.

## Future execution holds

1. Root must obtain actual Fable and Opus review of this exact manifest; this package contains no new approval receipt.
2. Before a future CLI invocation, enroll dependency resolution for the staged app. The temporary app/node_modules link used only for TypeScript was removed before freezing. This package deliberately has no dependency installation or permanent link. A direct invocation without an approved matching module-resolution setup may fail the saved list preflight and must stop. Do not add a link to the frozen directory silently; use a separately pinned execution staging copy and review its path/dependency mapping, or explicitly enroll a manifest-aware link addendum. Current absolute CLI/source paths pin this host; relocation needs explicit re-pinning, not silent substitutions.
3. Future `run-arm.mjs` is the entrypoint, not direct Playwright. It performs saved list -> exactly-one gate -> test -> server teardown -> validate-run.mjs. Each arm has its own process/context, exclusive directory and owned server, no retries. An ordinary assertion failure remains visible and does not authorize replacing the arm. A launch or protocol failure stops the block; no installs/retries.
4. Fixed order is instrumented baseline / Blob / instrumented baseline / stream. Baseline is different from original/off due to logging, async work and module order. Never substitute original/off. Roughly three minutes per test, block maximum 25 minutes including overhead; root owns the clock and may stop rather than starting an arm it cannot finish safely.
5. Later analysis must prove request-flow linkage, exact engine branch, and same-thread nested OnSideDataReadingComplete inside OnResponse/OnResponseStream versus later separate callback. Baseline must reproduce the successful-stream -> ERR_ABORTED disconnect while side data remains outstanding signature. No signature means inconclusive. Fresh byte digests must pair within the same worker object/responseId and match the immutable asset. No statistical causal claim from these four exploratory arms.
6. Full regression, phone performance, actual device behavior, release and provider effects remain unexecuted. Blob changes body materialization and side-data association; eager fresh stream aims to remove the side-data association while retaining streaming, but is still an intervention needing trace evidence.

Recommendation: review these corrections and resolve the execution staging/dependency mapping before any browser process. Do not bypass missing evidence to begin treatments.
