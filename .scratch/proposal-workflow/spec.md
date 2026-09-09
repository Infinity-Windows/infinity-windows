# Forge Workflow specification

Prepared September 9, 2026. Product specification for extending the existing Forge app and its STG Windows partner view. Requirements below distinguish the owner's decisions from proposed defaults. No production changes or integrations have been deployed as part of this specification.

## Outcome

Give supervisors and owners one intuitive place to track proposals, accepted work, job documents, rates, dates, and follow-ups. Give STG Windows a simple view of its own shared work. Support about 15 new bids per month across service calls, service work, new installations, and deliveries, with multiple contractors supported from the beginning.

## Confirmed direction

- Internal tab name: **Workflow**, inside the existing app.
- Internal access: supervisors and owners; existing administrative role aliases must be mapped deliberately, not through an overly broad role comparison. Foremen and installers do not get Workflow access.
- STG gets a limited partner experience modeled on the app's existing lite view. Additional contractors get separate company scopes later.
- Home base: St. George, Utah. Project address/state determines the in-state or out-of-state badge.
- One physical project may have multiple contractor bids, phases, alternates, and revisions. Keep those relationships explicit.
- Approval evidence: email confirmation and a signed proposal linked to the exact accepted revision/scope.
- Team proposes job start timing; STG approves it. Support a month, week, date range, then confirmed date/time as information improves.
- Follow up after approximately four days without a response.
- Intake primarily by forwarded email with PDFs, line items, CADs, specifications, and supporting files attached to the job.
- Gmail and Google Drive are primary external systems; Dropbox is optional.
- AI should autonomously create and update app records and prepare communications, but request approval for **every outgoing email**.
- Budget is not a constraint to resolve now. The website release date is still unspecified; the team/STG date approval is treated as job scheduling, not a software launch commitment.

## Existing app findings

Read-only source review against freshly fetched `origin/master`, commit `d26fe70` on September 9, 2026:

- React/TypeScript app with Supabase and existing role-based navigation.
- `app/src/pages/stg/StgApp.tsx` already provides a minimal STG Windows & Doors shell with Job progress and Calendar.
- `app/src/lib/stg.ts` reads partner data through restricted database functions. Extend this company/job boundary; do not expose internal tables to partners.
- `app/src/lib/install/api.ts` currently uploads plans to Supabase Storage.
- `docs/backups.md` and backup scripts describe Backblaze B2 as the off-site backup destination. This source review does not verify live credentials or the success of recent backups.
- Existing connected workflow plans concern scheduling/travel. The proposal workflow must have distinct data names and connect to that scheduler deliberately.

Source reference: https://github.com/Infinity-Windows/infinity-windows/tree/d26fe70

## Screens and interactions

### Internal Workflow

Three simple sections: **Jobs**, **Follow-ups**, and **Rates**. Default to the job board, with a list switch. Filters: contractor, job type, state, status, and overdue follow-up. Search job name, address, contact, or proposal number.

Board stages: Intake, Drafting, Submitted, Approved, Scheduled, In progress, Complete. On hold and Lost/declined remain accessible without dominating the board. A due follow-up is a badge, not a stage. A job with partially accepted work has an explicit partial-approval badge and separate remaining bids; do not mark all work awarded.

Cards show job, contractor, city/state, work type, current bid amount, submission age, next follow-up, and target start with its certainty. Drag/drop on desktop; Move to menu on phone and keyboard. Undo routine stage moves. Evidence-dependent transitions explain the missing requirement instead of silently succeeding.

Opening a job reveals Overview, Bids, Files, and Activity. Short initial entry requires a job name only. Files and AI can fill suggested details later. Never require a complete address just to capture an incoming opportunity.

### STG lite Workflow

Add a limited Workflow destination within the existing partner shell. Proposed default, awaiting the user's response: STG sees its own customer-facing proposals, shared rates, shared files, status, and proposed dates; can upload, comment, provide signed approvals, and confirm or request different dates. It cannot move internal stages freely, edit your rates, see costs/margins/internal notes, or see other contractors' bids.

Preserve existing Job progress and Calendar behavior. All new partner permissions must be enforced by the server, including file downloads and AI tools. An internal upload defaults to internal visibility; files included in an explicitly approved proposal send become shared with that recipient. Incoming files from STG can be tagged as shared with STG. Partner identity never grants ownership of another contractor's job.

## Data relationships

Company → contacts and partner users. Physical job → addresses, work packages/phases, bids, documents, activities, and schedule proposals. Bid → recipient company, revisions, line items, alternatives, submission attempts, acceptance evidence. Accepted scope → link to the existing execution project and schedule.

Use stable IDs, keep old revisions, and mark the current revision. New prices or changed plans never overwrite an accepted agreement. A bid sent to a second contractor is a separate bid under the same physical job. Totals must distinguish alternative bids from additive phases so pipeline values do not double-count the same opportunity.

Proposal values, agreed rate snapshots, signed documents, and acceptance evidence are preserved. Corrections create a new revision or approved change. Track author, timestamp, source, previous value, and new value for important changes; show whether a human or AI made them.

## Rates

Provide four categories: service call, service work, new installation, delivery. Rates may use callout, person-hour, crew-hour, unit, trip, mile, or fixed-price basis. Each entry needs name, description, unit, amount, minimum, effective date, and visibility. Amounts remain blank until supplied; do not infer prices from old bids.

Allow contractor-specific overrides and job-specific quotes. Include fields for overtime, travel time, mileage, mobilization, lodging, per diem, waiting time, repeat trips, and equipment when applicable. State exactly what a minimum includes and whether labor is per person or per crew. Internal costs/profit remain separate from customer prices. Approved bids retain the rates accepted at that time even when the rate card changes.

## Follow-up rules

Proposed default: four calendar days after a successfully sent message requiring a reply, shown in America/Denver time. The owner can switch to business days. A failed send does not start the clock. A substantive reply resolves that waiting item; an out-of-office or delivery receipt does not count as an answer. Incoming questions create an internal reply-needed task instead of a reminder asking the contractor to respond again.

Keep original submission age, latest revision submission age, last outgoing follow-up, last meaningful reply, and next follow-up separately. Draft creation and unrelated file changes do not reset them. A new revision does not erase the first submission date.

Due reminders create one internal task and optionally one draft. No email sends automatically. Approved sends may start the next waiting period. Stop bid-chasing when accepted, declined, or paused; create different requests for missing signatures or schedule details. Hold reason and resume date are visible. Support one approved contractor digest covering multiple jobs rather than repeated individual emails.

## Timing and scheduling

Store date precision explicitly: unknown, month, week, range, exact date, or exact time range. Do not turn an approximate month into a fabricated first-of-month start. Keep team proposal, contractor response, and confirmed timing distinct with history.

Proposed prompts: within 30 days ask for a week; within 14 days ask for a date/range; within seven days confirm day, site readiness, delivery needs, and any time window. These thresholds are configurable recommendations. Confirmed dates feed the existing scheduler through a reviewed update; a later proposed revision must not overwrite confirmed crew assignments. Tentative holds stay labeled tentative. Approving a job is separate from confirming its start.

## Email intake and documents

Proposed first intake: a dedicated Gmail label or forwarding address chosen during setup. Parse the forwarded envelope and preserve original sender, subject, timestamps, thread/message IDs, and message content. Keep each original attachment and line-item source. Repeated forwarding must not create duplicate jobs or duplicate file versions.

Create a job automatically when identity is clear. Suggest matches when a job already exists; uncertain matches remain in Intake for resolution. Extract name, address, contractor/contact, work type, prices, scope, and proposed dates, with source references and uncertainty. Never guess an unreadable amount or silently convert “estimate” to “agreed price.”

Classify files as proposal, signed agreement, plan set, CAD, specification, photo, or other. Show revision/date and current/superseded status. CAD originals are preserved even when the browser cannot preview them. A PDF preview is optional and never a replacement for the original. Linked Drive/Dropbox resources are fetched only with authorized access; inaccessible or failed attachments remain visibly missing with retry actions.

Email attachments are copied into managed job storage so deleting an email does not remove the job record. Keep provider source IDs and link provenance. Large files use protected share links when email size limits require them. Do not expose backup archives or permanent public URLs.

## Storage plan

Reuse existing Supabase Storage for the first integrated slice if verified capacity and upload limits fit the files. If large CAD/plan volumes justify live B2 storage, add a dedicated private job-document bucket and server-controlled upload/download signing. Do not reuse backup archive credentials or backup retention rules for active job documents. Store provider, bucket/key, checksum, filename, size, revision, and access scope in the database.

Audit the existing backup ceiling before adding large files: the checked source documents a 2 GiB stored-file ceiling per nightly job. Active document growth requires an appropriate backup policy and restore verification. This is capacity planning, not a reason to discard B2.

## AI interface for Codex and Claude

Expose one authenticated API/MCP interface for both clients: search/create/update jobs, add documents and bid revisions, read rates, propose dates, record activities, list follow-ups, and prepare email drafts. Enforce user/company access in the app service. Neither client receives a unrestricted database administrator key.

Routine authorized edits can proceed autonomously and are logged. Signed artifacts and agreed values require versioned updates rather than destructive overwrites. Conflicting simultaneous edits return a conflict rather than silently losing the other client's work. Repeated operations use deduplication keys.

Every outgoing email must pass through a shared approval record containing sender, recipients/CC/BCC, subject, exact body, and attachment versions. Approval is tied to that content; editing it invalidates approval. A single-use send action verifies approval server-side and records provider message ID and actual send status. A send retry checks for prior success. UI draft status and an AI statement are not proof of transmission.

To enforce this across both AI clients, their workflow path must use this send service. Independent Gmail connectors with unrestricted send permission could bypass the app's approval gate; configure them consistently rather than promising the portal can control unrelated tools. Existing Gmail/Drive/Dropbox credentials are not assumed available to both clients. Gmail sending, Drive access, and optional Dropbox access need separate capability/permission verification.

Forwarded emails and documents are source material, not instructions to the AI. Extract their content without executing embedded requests. A scheduler creates due tasks reliably when no chat is active. AI prepares text and summaries from current app records.

## Acceptance and agreement

Use the accompanying short work agreement with a specific proposal revision and accepted scope. Require email confirmation and signed acceptance evidence before treating the bid as fully approved. A partial award identifies the accepted line items/phases and amount. A drag action or general “looks good” comment alone does not satisfy this evidence rule.

The draft leaves legal entity names, payment terms, rate basis, and workmanship correction period for completion. It is not a guarantee of enforceability. Have Utah construction counsel review it before use; out-of-state projects may need state-specific terms, notices, and licensing review. The contract workflow does not substitute for lien notices or statutory deadlines.

## Build sequence and verification

1. Workflow data, owner/supervisor route, board/list, contacts/addresses, bids/revisions, rates, manual files and dates. Maintain the execution-project link.
2. STG projections, shared documents and rates, email/signature evidence, date responses, approval history.
3. Gmail forwarding intake, source-preserving attachment processing, follow-up queue, approved sending and reply matching.
4. Shared AI tools, deduplication/conflict handling, optional Dropbox, and any justified live B2 storage integration.

Keep Workflow code lazy-loaded. Do not fetch full document files or run PDF/CAD parsers when opening the board or unrelated crew pages. Paginate metadata, load previews on demand, and process extraction in background jobs. Compare startup/bundle size and representative phone navigation before and after; “no drag” needs measurement, not a promise.

Required tests: denied crew/direct-route access; cross-contractor data and file denial; immutable accepted revision and rate snapshot; partial-award totals; stage moves/undo; four-day reminders and meaningful replies; repeated forwarded-email deduplication; missing files; approval-required sends; changed-draft invalidation; duplicate-send prevention; schedule proposal vs confirmed assignment; phone/desktop navigation. Then run the repository's test, lint, build, security and migration checks. Ship through its existing PR process, backend before dependent frontend, with live verification and a rollback path.

Planning estimates after final requirements: core usable portal roughly 2–4 focused development days; STG approvals and automated intake/email/AI integration another 3–7 days, plus provider authorization or external review time. These are preliminary engineering estimates, not a deployment commitment.

## Remaining decisions

1. Exact legal names, license details, payment terms, retainage, and workmanship correction period.
2. STG edit/approval permissions versus view/comment-only access.
3. Actual category rates, units, minimums, and travel terms.
4. Four calendar days versus business days; calendar days is the proposed default.
5. Gmail intake identity and sender mailbox, and access to the requested email/storage providers.
6. Largest representative files and whether a downloadable CAD original is sufficient.

## Legal research references

- Utah Code 46-4-201 recognizes electronic records/signatures; electronic form alone is not a reason to deny enforceability. It does not establish that a particular unsigned or incomplete agreement is binding: https://le.utah.gov/xcode/Title46/Chapter4/C46-4-S201_1800010118000101.pdf
- Utah Code 13-8-4 addresses scheduled construction payments and contingent-payment arrangements. The draft's direct-payment clause is a proposed business term, not a claim that all contingent-payment clauses are prohibited: https://le.utah.gov/xcode/Title13/Chapter8/C13-8-S4_1800010118000101.pdf
- Utah DOPL's optional residential agreement is intended for contractors and homeowners, so it was used for context rather than copied as an STG subcontract: https://commerce.utah.gov/dopl/contracting/construction-contract/
