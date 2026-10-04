import * as storage from "../../src/lib/workUnitReview/storage";
import * as auth from "../../src/lib/signedIn";
import { UnitReviewCoordinator } from "../../src/lib/workUnitReview/coordinator";
import { parseUnitReviewReply, type ReviewPayload, type ReviewReceipt } from "../../src/lib/workUnitReview/protocol";
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const OWNER = id(1), UNIT = id(2);
export const payload = (): ReviewPayload => ({ action: "verify_dimensions", basis: { unitId: UNIT, unitRevision: 1, factId: id(4), factRevision: 1,
  scopeToken: `ur1:${"a".repeat(64)}`, reviewRevision: 0, submissionId: null, generation: 0 }, data: {
  widthDecimal: "0001.00000000000000000100", heightDecimal: "72", unit: "in", source: "measured", sourceReference: "Original tape measurement" } });
export const receipt = (commandId: string): ReviewReceipt => ({ protocolVersion: 1, commandId, action: "verify_dimensions", unitId: UNIT,
  eventId: id(7), reviewRevision: 1, generation: 0, submissionId: null, recordedAt: "2026-10-04T10:00:00Z", outcome: "applied" });
const view = () => parseUnitReviewReply({ protocolVersion: 1, asOf: "2026-10-04T10:00:00Z", availability: "available", review: {
  basis: payload().basis, basisStatus: "current", capabilities: { verifyDimensions: true, submit: true, pass: false, fail: false, claimResolved: false, reopen: false },
  observation: { observerId: OWNER, source: "measured", widthDecimal: "1.000000000000000001", heightDecimal: "72", unit: "in", sourceReference: null },
  dimensionVerification: { state: "unverified", verificationId: null }, qc: { state: "not_submitted", acceptance: "not_accepted", lifecycle: "unproven", qcAccepted: false },
  work: { availability: "available", activeCount: 0, pendingCount: 0 }, defects: [] } }, UNIT);
auth.rememberSignedIn({ user: { id: OWNER } });
let sends = 0;
const coordinator = new UnitReviewCoordinator({ login: auth.signInMark(), unitId: UNIT, contextKey: "synthetic-job-lifetime", admission: () => true }, {
  read: async () => view(), receipt: async () => ({ protocolVersion: 1, availability: "unavailable", receipt: null }),
  send: async () => { sends++; return { kind: "unknown" }; },
});
export const fixture = { storage, auth, coordinator, id, OWNER, UNIT, payload, receipt, sends: () => sends };
declare global { interface Window { unitReviewFixture: typeof fixture } }
window.unitReviewFixture = fixture;
