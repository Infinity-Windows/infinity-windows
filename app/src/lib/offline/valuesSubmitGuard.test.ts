import { beforeEach, expect, it, vi } from "vitest";
import { makeEntry } from "./outbox-core";
import { hashValuesSubmission, normalizeValuesSubmission } from "../values/receiptContract";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../supabase", () => ({ supabase: { rpc } }));
const { createSupabaseHandlers, createShiftResolver } = await import("./outboxHandlers");
const handlers = createSupabaseHandlers(createShiftResolver());
const ownerId = "11111111-1111-4111-8111-111111111111";
const assignmentId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const scores = ["fullsend", "ownership", "integrity", "sincerity", "tribe", "growth", "strategic", "safety"].map((slug) => ({ slug, score: 7 }));

async function validEntry() {
  const submission = normalizeValuesSubmission({ assignmentId, requestId, rubricVersion: 1, scores, comment: "good" });
  const digest = await hashValuesSubmission(submission);
  return makeEntry({ op: "values_submit", ownerId, payload: {
    assignmentId, requestId, raterId: ownerId, rubricVersion: 1,
    scores: submission.scores, comment: submission.comment, digest,
    encodingVersion: submission.encodingVersion,
  } }, requestId, 1);
}

beforeEach(() => rpc.mockReset());

it("refuses changed durable fields before any server write", async () => {
  const original = await validEntry();
  const changes = [
    { scores: scores.map((row, i) => i === 0 ? { ...row, score: 9 } : row) },
    { comment: "changed" }, { rubricVersion: 2 }, { assignmentId: ownerId },
    { requestId: ownerId }, { encodingVersion: "other" }, { comment: 42 }, { digest: null },
  ];
  for (const changed of changes) {
    const entry = { ...original, payload: { ...original.payload, ...changed } };
    await expect(handlers.values_submit!(entry, { getBlob: async () => null })).rejects.toBeTruthy();
  }
  expect(rpc).not.toHaveBeenCalled();
});

it("a correctly saved request is sent unchanged and validates its receipt", async () => {
  const entry = await validEntry();
  rpc.mockResolvedValue({ error: null, data: { receipt: {
    encodingVersion: "forge-values-submit/v1", submissionId: "44444444-4444-4444-8444-444444444444",
    assignmentId, requestId, rubricVersion: 1, digest: entry.payload.digest,
    acceptedAt: "2026-10-03T12:00:00+00:00", quarterStart: "2026-10-01", cutoffAt: "2026-10-04T00:00:00+00:00",
    quarterEligibility: "eligible_before_cutoff",
  }, replay: true } });
  const result = await handlers.values_submit!(entry, { getBlob: async () => null });
  expect(rpc).toHaveBeenCalledOnce();
  expect(rpc.mock.calls[0][1]).toMatchObject({ p_assignment_id: assignmentId, p_request_id: requestId, p_comment: "good" });
  expect(result).toMatchObject({ receipt: { requestId, digest: entry.payload.digest }, replay: true });
});
