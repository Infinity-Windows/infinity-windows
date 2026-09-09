# Core Workflow
Status: resolved

Implemented a supervisor/owner-only Workflow route with persistent job board/list, contacts and addresses, Utah/out-of-state classification, dated bid revisions, signed-document and email acceptance evidence, start precision and confirmation, private original-file uploads with retry, rate history, activity and four-calendar-day follow-ups. Crew and partners cannot query the internal records. Execution-job deletion detaches the proposal record, preserving contract evidence.

## Validation
- Full app suite: 5,378 tests passed.
- Browser fixtures: phone/desktop forms, stage move/undo, rates, restricted installer route, and create/cancel dialog.
- Disposable PostgreSQL 16: roles, storage policy, stale revisions, submission clock, immutable bid values, acceptance and schedule gates.
- Partner-wall, sandbox-guard and schema/restore tooling tests.
- Production build/lint and entry bundle budget (244.4 kB gzip; budget 260 kB).

## Remaining work
This is the first internal slice. It is not deployed and does not send email. STG partner projections, linked execution-job creation, structured quantity/rate line-item editing, file-to-bid linkage, automated intake/extraction, per-recipient follow-up timers, and shared AI/email tools remain in ticket 02. Rates, legal entities and contract payment/warranty terms are still awaiting the owner's inputs. No live storage capacity or provider authorization is assumed verified.
