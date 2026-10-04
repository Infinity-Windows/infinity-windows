import { describe, expect, it } from "vitest";
import corpus from "./__fixtures__/sourceMatchedWire.json";
import { parseTotalsReply } from "./protocol";
// Actual disposable SQL replies with synthetic identities; never provider proof.
describe("source-matched activity totals", () => {
 it("pins the exact reviewed SQL sources", () => {
  expect(corpus.totalsSha256).toBe("e0e74c2d1985d332af81f95d20d2a6625c40cb5fcf995b4aa6e267d75e092140");
  expect(corpus.reviewSha256).toBe("e32122a581bf995857983cc433323bc490381b6eb217c583bf95fd7376b3e53f");
 });
 corpus.calls.forEach((call, i) => it(`parses actual totals SQL reply ${i+1}`, () => {
  const actor = call.result.totals?.actorId ?? "00000000-0000-4000-8000-000000250001";
  expect(parseTotalsReply(call.result, String(call.args[0]), call.args[1] === null ? null : String(call.args[1]), actor)).toEqual(call.result);
 }));
});
