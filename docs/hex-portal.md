# Hex-Portal learning pilot

Release candidate, September 22, 2026. Pilot selected by the owner: Isaac Barlow - Deck Enclosure (Isaac’s deck). No live link is claimed until the owner selects the existing Forge job, Hexcore company and Hexcore project in the private workspace.

## Crew workflow

In Ask, expand Hex-Portal, choose a job and optional unit, then ask a work question. The bridge can return exact reviewed lessons when that job is linked. The answer shows whether it used reviewed guidance or the normal Ask path. Save Hex-Portal case is an explicit action; private timecard/report questions bypass this learning flow. The original question, answer, cited revisions and outcome remain in Forge. Resolved and Needs help record follow-up evidence; they never change an approved lesson automatically. Needs help withholds that exact received revision until a reviewer publishes and explicitly shares a new revision.

Cases and outcomes use the existing durable offline queue with stable IDs and original-user ownership checks. A queued save is labeled as saved on the device rather than confirmed uploaded. Switching accounts cannot submit another person’s evidence. Profile/project deletion follows the existing retention and trash cascades. Cases are not duplicated into Hexcore’s database.

## Owner setup and review

1. Sign in to the private Hexcore workspace and connect the existing read-only Forge owner connection.
2. Open Questions and learning → Hex-Portal. Load Forge jobs and reviewed lessons. Select Isaac’s deck and the matching existing company/project, trade Glazing, then enable the pilot.
3. Refresh crew cases. Use Reviewed guidance to create/review a lesson with evidence, applicability, accountable reviewer and review date.
4. Return to Hex-Portal, select the exact published lesson revision, optionally link its original Forge case, review the preview, and explicitly share. Updated lessons require a fresh share. Pause pilot or Stop sharing immediately removes that publication path.

Only the private workspace owner manages this first pilot. Every crew lookup independently validates the current Forge account and job twice. The private Site transport secret cannot grant native owner access. No owner credentials, tokens, private contact directory or general workspace history are exposed to Forge clients. Existing role floors for payroll and scheduling remain unchanged.

## Release and validation

Deploy Hexcore’s additive migration and private endpoint first. Forge deploys migration20261022000000, edge function hex-portal and the matching client through its existing workflows. HEX_PORTAL_SITES_TOKEN is a server-only deployment secret. No OpenAI provider/key change or model training is involved.

Validation: synthetic PostgreSQL role/RPC/retention checks, durable retry and account-switch unit tests, phone390px/desktop1440px save/outcome/reload checks, and payroll exclusion checks. The first full Forge run passed5554 tests; final build and CI receipts govern release status. Physical iPhone Safari and authenticated owner pilot activation remain separate acceptance steps.
