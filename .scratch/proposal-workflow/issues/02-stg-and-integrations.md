# STG and connected intake
Status: in-progress

Implemented partner Workflow tab with selected submitted bid revisions and ready files. Explicit per-login grants remain independent of execution-job grants. Internal notes and acceptance email evidence are excluded from the projection. Supervisor/owner sharing by existing partner login email, replacing selections or revoking access; no email is sent. Partners can respond and confirm the current exact proposed date with version checking.

Validated in disposable PostgreSQL: projection, hidden revisions/notes, storage authorization, revoked access, partner write denial, date confirmation, stale responses. Browser fixtures cover partner phone view/date response and internal sharing; existing STG tests retained. All 5,378 unit tests pass. No production migration applied.

Remaining: display/edit existing grant selections, shared rates, partner upload/signature evidence, execution-job linking UI, structured line items, email intake/extraction/reply matching and per-recipient timers, authenticated AI interface and exact-content per-message send approval. No Gmail connector is available in this session and no Gmail OAuth code exists in the app. Sender/intake mailbox has been asked; no credentials or provider connectivity are assumed. Actual rates and legal terms remain blank.
