# Clock protocol readiness

`work_activity_clock_capability()` is a self-only, authenticated read. It does
not start a clock, initialize personal state, issue an observation, or write a
receipt. A READ ONLY transaction is a required acceptance test. Capture and the
frontend remain disabled until the complete engine release gates pass.

Every response contains `protocolVersion: 1`, server `asOf`,
`clockProtocol: "setup_v1"`, `receiptProtocol: "retained_v1"`, and this matrix:

| mode | setupReason | canAuthorSetup |
| --- | --- | --- |
| active | null | true |
| closing_only | starts_disabled | false |
| unavailable | not_ready | false |

The three support flags `canDispatchExistingSetup`, `canReadOwnReceipts`, and
`canDispatchPayrollSafety` are true in every valid response. They describe the
installed protocol, not acceptance of any particular command. An already saved
twelve-argument command may still perform its original payroll action while new
authoring is disabled. Never downgrade it to eleven arguments. A setup receipt
proves receipt of the protocol; only a fresh activity snapshot confirms that a
setup session actually opened. Original taps and truthful review outcomes stay
under the existing payroll routes.

The read requires READ COMMITTED, takes the global gate, then validates the
current internal account. Revoked, retired, partner, missing and anonymous
callers receive no projection. The server timestamp is selected after the wait.
Toolbox admission uses the actual existing helper: either today's completion or
the enabled company paid-from-Start-day policy. Known corrupt/exhausted personal
capture state, missing/exhausted authority state or retained safety evidence
makes capture unavailable; it does not turn off the payroll support flags.
A missing personal state is not initialized. This readiness read does not replace
the caller's separate current-shift or project authorization checks.

0843 is a separate migration. Before it installs anything, its generated
completion guard verifies 667 represented application routines, 347 triggers,
and 19 private protocol relation shapes/RLS/permissions from the frozen e2
cutover compiled on the source-matched fixture. It then creates a revoked private
constant marker and the public read in the same transaction. The read verifies
the marker and 21 clock/authority routine contracts on every call. Routine hashes
include source, owner, security mode, volatility, result, configuration and
PUBLIC/anon/authenticated EXECUTE; provider service-role default grants are not
silently equated with the disposable fixture. OIDs and grant ordering are not
identities. Extra independent read-only migration functions do not invalidate the
contract. An original/substrate-only database, altered source/permissions,
disabled required trigger or changed private shape refuses installation.

This is protection against partial/mismatched deployment. Trusted administrators
can replace database objects and are outside this contract. The complete 0841
installed-source/graph guards, installed rehearsal, provider boundaries and
release acceptance remain mandatory; this fixture-derived contract does not
replace them. No new table, retained identity or history census entry is added.

The client must validate the exact DTO, bind it to the current sign-in generation,
use RAM-only `offline: false` caching and ignore late results after identity
changes. Network failure, a missing RPC, SQLSTATE 55000, auth failure, or malformed
payload means readiness unknown and no new authoring. It must not fabricate
capability from a historical receipt. Offline display/causal safety handling is
specified separately; this read grants no durable offline new-clock authority.

Verification: `verify-work-activity-clock-capability.mjs` compiles the pinned full
application fixture and exact e2 cutover, compares the generated migration bytes,
and exercises real permission helpers and mutation-positive guard failures.
`--build` is an explicit source-generation action, never performed by normal
tests. `verify-work-activity-engine-role-parity.py` additionally installs 0843 via
actual NOSUPERUSER postgres login, calls it via actual authenticator login in a
READ ONLY transaction, and requires two observed independent-backend G blocking
edges before testing capture disable and account revocation freshness. Its URI
and fresh-database guards, bounded processes, real installed timeout settings and
provider exclusions are unchanged. Local PGlite execution is not PostgreSQL 17
network/concurrency proof; preserve the separate CI receipts.

The explicit new setup route may admit the original paid tap before toolbox signing when capture is active and healthy. Retained clock routes keep their existing toolbox/company-paid-date policy. Activity starts, Prep, and finishing setup still require actual toolbox signing. The private one-use setup-root claim is checked inside the existing payroll route; client readiness alone cannot authorize a punch.
