import { describe, expect, it } from "vitest";
import corpus from "./__fixtures__/sourceMatchedWire.json";
import { parseUnitReviewPayload, parseUnitReviewReceipt, parseUnitReviewReceiptReply, parseUnitReviewReply } from "./protocol";

// Successful real SQL calls from the complete source-matched disposable
// fixture, using synthetic identities only. This frozen corpus proves wire
// compatibility for this exact SQL SHA; it is not installed-provider proof.
describe("source-matched review SQL response compatibility", () => {
  it("binds the frozen synthetic corpus to the exact tested backend source", () => {
    expect(corpus.reviewSha256).toBe("4ec3c7486cba34976af5670aab08659b7525eff9fd714478b2cd10782877b474");
    expect(corpus.calls.length).toBeGreaterThan(5);
  });
  corpus.calls.forEach((call, index) => {
    it(`parses actual SQL call ${index + 1}: ${call.sql}`, () => {
      if (call.sql.includes("work_unit_review_command_receipt")) {
        expect(parseUnitReviewReceiptReply(call.result, String(call.args[0]))).toEqual(call.result);
      } else if (call.sql.includes("work_unit_review_read")) {
        expect(parseUnitReviewReply(call.result, String(call.args[0]))).toEqual(call.result);
      } else if (call.sql.includes("work_unit_review_command")) {
        // Fixture SQL embeds protocolVersion1 and has only two bind args.
        const original = parseUnitReviewPayload(JSON.parse(String(call.args[1])));
        expect(parseUnitReviewReceipt(call.result, String(call.args[0]), original)).toEqual(call.result);
      } else throw new Error("Unknown corpus call; do not silently skip wire compatibility.");
    });
  });
});
