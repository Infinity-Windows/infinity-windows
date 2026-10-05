# Archived PWA Linux diagnostic

This build seals a test kit and adds instructions for a controlled cloud test. It selects the corrected checkpoint4, rather than the older environment gate that rejected Bash PWD. Every package file has a checked fingerprint. Forge product behavior is unchanged.

The workflow is dispatch-only: supply the exact published commit (40 lowercase hex) and the independently reviewed package manifest SHA (64 hex). Checkpoint4 manifest is `9cab38dce05a4fe613c3cc2275f25936497f0c76df73f5e90c85da9da947bde5`. The844 enrolled files are843 package files and one workflow. This document is the additional publication record. No source-root files are edited. Historical checkpoint documents describe their status at sealing.

The publication workflow differs from the checkpoint proposal only by its package path and two input descriptions. The copied bootstrap helper's old path constant is unused: the inline workflow verifies checkpoint4 first, and helpers resolve their verified folder. YAML and Python AST checks passed, and all **three** Bash run steps passed syntax checks. Root matched every staged package byte.87 offline controls passed (67Node+20Python); these do not establish cloud runtime success.

Actual Claude Opus5.5 and Fable5.1 approved their separate source and publication review scopes. Opus checked environment/inline bootstrap security; Fable checked counts/preservation/tests and publication pins/budgets. Root verified returned models and receipt usage deltas. Fable's publication documentation correction is reflected here: there are three Bash run steps. The proposal HANDOFF containing the typo is not published.

One run uses Ubuntu24.04, exact official Node22.23.1 and pinned Playwright1.62 sources, normal npm ci, then default Chromium headless shell selected from its pinned registry. All installation happens on the disposable runner. Setup30minutes, one four-arm block25minutes, upload10minutes and job70minutes are fixed. Missing/terminal/late evidence is incomplete; no retry or larger timing budget. Raw setup, identity, traces and partial outcomes are retained.

Original A703 Node patch, actual Linux installation/browser identity, early-worker coverage and failure mechanism remain unknown until evidence establishes them. Four exploratory arms do not prove a failure rate or cause. No merge, deployment, production activation, provider action, physical-device proof or full redesign acceptance is included.
