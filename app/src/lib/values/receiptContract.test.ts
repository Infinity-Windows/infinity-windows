import { describe, expect, it } from "vitest";
import {
  ValuesContractError,
  canonicalValuesSubmissionText,
  hashValuesSubmission,
  normalizeValuesSubmission,
  validateValuesResponse,
  VALUE_SLUGS_ASCII_SORTED,
  VALUES_SUBMIT_ENCODING_VERSION,
  type RawValuesSubmissionInput,
  type SavedValuesSubmission,
} from "./receiptContract";

/**
 * Golden cross-language fixtures, executed (not just transcribed) in
 * ../../../../../outputs/Crew-Goals-Values-Build-2026-10-03/VALUES-RECEIPT-CONTRACT.md
 * §7 against Node's TextEncoder + WebCrypto SHA-256 and PGlite's built-in
 * sha256 — this suite is the regression that would catch either side (this
 * file or the SQL in `values_submit()`) drifting from that agreed contract.
 */
const FIXTURE_ASSIGNMENT_ID = "11111111-1111-4111-8111-111111111111";
const FIXTURE_REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const FIXTURE_RUBRIC_VERSION = 1;

// Full Send 1, Growth 2, Integrity 3, Ownership 4, Safety 5, Sincerity 6,
// Strategic 7, Tribe 8 — deliberately NOT ascii-sorted on input, so a
// correct implementation must sort by slug itself before hashing.
const FIXTURE_SCORES: RawValuesSubmissionInput["scores"] = [
  { slug: "tribe", score: 8 },
  { slug: "fullsend", score: 1 },
  { slug: "safety", score: 5 },
  { slug: "growth", score: 2 },
  { slug: "integrity", score: 3 },
  { slug: "strategic", score: 7 },
  { slug: "ownership", score: 4 },
  { slug: "sincerity", score: 6 },
];

function fixtureInput(comment: string | null): RawValuesSubmissionInput {
  return {
    assignmentId: FIXTURE_ASSIGNMENT_ID,
    requestId: FIXTURE_REQUEST_ID,
    rubricVersion: FIXTURE_RUBRIC_VERSION,
    scores: FIXTURE_SCORES,
    comment,
  };
}

describe("golden digest fixtures (VALUES-RECEIPT-CONTRACT.md §7)", () => {
  const cases: [string, string | null, string][] = [
    ["null comment", null, "fa0ecfc2e76fb29a3fa169bd42583c49172e42d3972272867ef83ac90f0b2ae3"],
    ["empty-string comment (becomes null)", "", "fa0ecfc2e76fb29a3fa169bd42583c49172e42d3972272867ef83ac90f0b2ae3"],
    ["spaces-only comment (becomes null)", "   ", "fa0ecfc2e76fb29a3fa169bd42583c49172e42d3972272867ef83ac90f0b2ae3"],
    ["ASCII-space-trimmed comment", "  Team effort  ", "003f30790f9ddf20f90c441c826dfd305f3c600345d0a52be3c619fb71319f04"],
    ["Unicode/CRLF comment", "  café \u{1F6E0}️\r\nLine 2  ", "52c5c47edb67adc85e74044273789a9b6bd93b9c5e7eaeea9d093537939d3502"],
    ["combining-mark comment", "é", "198931f5062040a9120bc2f0916df27891e5cd3e33f66cf652e01f402e273aff"],
    ["precomposed comment", "é", "0d6b32b5621e5d5739140edf9b8b5d7a5ef2779b5d6af5c6e66cbc110dd15fbd"],
    ["NBSP/tab comment", "  \tGood\t  ", "70577ac41a6888ad687565dc41f43a68e8d0ca537d0df2f7b517eca1a27350ea"],
    ["newline-only comment stays non-null", "\n", "09927a38f35de96e67f2a37215a9d94b6be37c74aa4c251a97cf381554d7d492"],
    ["2000-emoji comment", "\u{1F600}".repeat(2000), "f8dedd1b193872d3bde3341efea4a0362143c9669346ab7b7a2534e00f620f2e"],
  ];

  for (const [label, comment, expectedDigest] of cases) {
    it(`${label}`, async () => {
      const saved = normalizeValuesSubmission(fixtureInput(comment));
      const digest = await hashValuesSubmission(saved);
      expect(digest).toBe(expectedDigest);
    });
  }

  it("array order of the input scores never changes the digest", async () => {
    const shuffled: RawValuesSubmissionInput = {
      ...fixtureInput(null),
      scores: [...FIXTURE_SCORES].reverse(),
    };
    const saved = normalizeValuesSubmission(shuffled);
    const digest = await hashValuesSubmission(saved);
    expect(digest).toBe("fa0ecfc2e76fb29a3fa169bd42583c49172e42d3972272867ef83ac90f0b2ae3");
  });

  it("canonical text ends every line, including the last, in a single LF", () => {
    const saved = normalizeValuesSubmission(fixtureInput(null));
    const text = canonicalValuesSubmissionText(saved);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.includes("\r")).toBe(false);
    expect(text.startsWith(`${VALUES_SUBMIT_ENCODING_VERSION}\n`)).toBe(true);
  });
});

describe("normalizeValuesSubmission — rejects before hashing or queueing", () => {
  it("rejects a non-canonical assignment id", () => {
    expect(() => normalizeValuesSubmission({ ...fixtureInput(null), assignmentId: "not-a-uuid" })).toThrow(
      ValuesContractError,
    );
  });

  it("lowercases an uppercase-hex UUID", () => {
    const saved = normalizeValuesSubmission({
      ...fixtureInput(null),
      assignmentId: FIXTURE_ASSIGNMENT_ID.toUpperCase(),
    });
    expect(saved.assignmentId).toBe(FIXTURE_ASSIGNMENT_ID);
  });

  it("rejects a non-integer rubric version", () => {
    expect(() => normalizeValuesSubmission({ ...fixtureInput(null), rubricVersion: 1.5 })).toThrow(
      ValuesContractError,
    );
  });

  it("rejects fewer than eight scores", () => {
    expect(() =>
      normalizeValuesSubmission({ ...fixtureInput(null), scores: FIXTURE_SCORES.slice(0, 7) }),
    ).toThrow(ValuesContractError);
  });

  it("rejects an unknown slug", () => {
    const scores = [...FIXTURE_SCORES.slice(0, 7), { slug: "notaslug", score: 9 }];
    expect(() => normalizeValuesSubmission({ ...fixtureInput(null), scores })).toThrow(ValuesContractError);
  });

  it("rejects a real duplicate slug (two array entries, not a collapsed object key)", () => {
    const scores = [...FIXTURE_SCORES, { slug: "fullsend", score: 9 }];
    expect(() => normalizeValuesSubmission({ ...fixtureInput(null), scores })).toThrow(ValuesContractError);
  });

  it("rejects a string score", () => {
    const scores = FIXTURE_SCORES.map((s) => (s.slug === "fullsend" ? { slug: s.slug, score: "1" as unknown } : s));
    expect(() => normalizeValuesSubmission({ ...fixtureInput(null), scores })).toThrow(ValuesContractError);
  });

  it("rejects a fractional score", () => {
    const scores = FIXTURE_SCORES.map((s) => (s.slug === "fullsend" ? { slug: s.slug, score: 5.5 } : s));
    expect(() => normalizeValuesSubmission({ ...fixtureInput(null), scores })).toThrow(ValuesContractError);
  });

  it("rejects a null score", () => {
    const scores = FIXTURE_SCORES.map((s) => (s.slug === "fullsend" ? { slug: s.slug, score: null as unknown } : s));
    expect(() => normalizeValuesSubmission({ ...fixtureInput(null), scores })).toThrow(ValuesContractError);
  });

  it("rejects an out-of-range score", () => {
    const scores = FIXTURE_SCORES.map((s) => (s.slug === "fullsend" ? { slug: s.slug, score: 11 } : s));
    expect(() => normalizeValuesSubmission({ ...fixtureInput(null), scores })).toThrow(ValuesContractError);
  });

  it("rejects a NUL character in the comment", () => {
    expect(() => normalizeValuesSubmission(fixtureInput("a\u0000b"))).toThrow(ValuesContractError);
  });

  it("rejects a lone high surrogate in the comment", () => {
    expect(() => normalizeValuesSubmission(fixtureInput("a\uD800b"))).toThrow(ValuesContractError);
  });

  it("rejects a lone low surrogate in the comment", () => {
    expect(() => normalizeValuesSubmission(fixtureInput("a\uDC00b"))).toThrow(ValuesContractError);
  });

  it("accepts exactly 2000 code points and rejects 2001", () => {
    expect(() => normalizeValuesSubmission(fixtureInput("x".repeat(2000)))).not.toThrow();
    expect(() => normalizeValuesSubmission(fixtureInput("x".repeat(2001)))).toThrow(ValuesContractError);
  });

  it("every slug list has exactly the eight known names", () => {
    expect([...VALUE_SLUGS_ASCII_SORTED].sort()).toEqual([...VALUE_SLUGS_ASCII_SORTED]);
    expect(VALUE_SLUGS_ASCII_SORTED).toHaveLength(8);
  });
});

describe("validateValuesResponse — the queue acknowledgment rule (contract §6)", () => {
  async function savedExpectedFor(saved: SavedValuesSubmission) {
    return { submission: saved, expectedDigest: await hashValuesSubmission(saved) };
  }

  function receiptFor(saved: SavedValuesSubmission, digest: string, overrides: Partial<Record<string, unknown>> = {}) {
    return {
      receipt: {
        encodingVersion: saved.encodingVersion,
        submissionId: "33333333-3333-4333-8333-333333333333",
        assignmentId: saved.assignmentId,
        requestId: saved.requestId,
        rubricVersion: saved.rubricVersion,
        digest,
        acceptedAt: "2026-10-05T12:00:00.000Z",
        quarterStart: "2026-10-01",
        cutoffAt: "2027-01-10T07:00:00.000Z",
        quarterEligibility: "eligible_before_cutoff",
        ...overrides,
      },
      replay: false,
    };
  }

  it("accepts a matching response", async () => {
    const saved = normalizeValuesSubmission(fixtureInput("Great month."));
    const savedExpected = await savedExpectedFor(saved);
    const raw = receiptFor(saved, savedExpected.expectedDigest);
    const result = await validateValuesResponse(raw, savedExpected);
    expect(result.receipt.digest).toBe(savedExpected.expectedDigest);
    expect(result.replay).toBe(false);
  });

  it("throws on a non-object response instead of returning a false success", async () => {
    const saved = normalizeValuesSubmission(fixtureInput(null));
    const savedExpected = await savedExpectedFor(saved);
    await expect(validateValuesResponse(null, savedExpected)).rejects.toThrow(ValuesContractError);
    await expect(validateValuesResponse([], savedExpected)).rejects.toThrow(ValuesContractError);
    await expect(validateValuesResponse(0, savedExpected)).rejects.toThrow(ValuesContractError);
  });

  it("throws on a mismatched digest", async () => {
    const saved = normalizeValuesSubmission(fixtureInput(null));
    const savedExpected = await savedExpectedFor(saved);
    const raw = receiptFor(saved, "0".repeat(64));
    await expect(validateValuesResponse(raw, savedExpected)).rejects.toThrow(ValuesContractError);
  });

  it("throws when the receipt names a different assignment id", async () => {
    const saved = normalizeValuesSubmission(fixtureInput(null));
    const savedExpected = await savedExpectedFor(saved);
    const raw = receiptFor(saved, savedExpected.expectedDigest, {
      assignmentId: "44444444-4444-4444-8444-444444444444",
    });
    await expect(validateValuesResponse(raw, savedExpected)).rejects.toThrow(ValuesContractError);
  });

  it("throws when the receipt is missing a required field", async () => {
    const saved = normalizeValuesSubmission(fixtureInput(null));
    const savedExpected = await savedExpectedFor(saved);
    const raw = receiptFor(saved, savedExpected.expectedDigest, { acceptedAt: undefined });
    await expect(validateValuesResponse(raw, savedExpected)).rejects.toThrow(ValuesContractError);
  });

  it("throws on an unknown quarterEligibility value", async () => {
    const saved = normalizeValuesSubmission(fixtureInput(null));
    const savedExpected = await savedExpectedFor(saved);
    const raw = receiptFor(saved, savedExpected.expectedDigest, { quarterEligibility: "something_else" });
    await expect(validateValuesResponse(raw, savedExpected)).rejects.toThrow(ValuesContractError);
  });

  it("surfaces a matching replay:true for exact recovery of a lost response", async () => {
    const saved = normalizeValuesSubmission(fixtureInput(null));
    const savedExpected = await savedExpectedFor(saved);
    const raw = { ...receiptFor(saved, savedExpected.expectedDigest), replay: true };
    const result = await validateValuesResponse(raw, savedExpected);
    expect(result.replay).toBe(true);
  });

  it("throws when submissionId is not a canonical UUID", async () => {
    const saved = normalizeValuesSubmission(fixtureInput(null));
    const savedExpected = await savedExpectedFor(saved);
    const raw = receiptFor(saved, savedExpected.expectedDigest, { submissionId: "not-a-uuid" });
    await expect(validateValuesResponse(raw, savedExpected)).rejects.toThrow(ValuesContractError);
  });

  it("throws when submissionId is uppercase (not the canonical lowercase form)", async () => {
    const saved = normalizeValuesSubmission(fixtureInput(null));
    const savedExpected = await savedExpectedFor(saved);
    const raw = receiptFor(saved, savedExpected.expectedDigest, {
      submissionId: "3bcdef33-3333-4333-8333-333333333333".toUpperCase(),
    });
    await expect(validateValuesResponse(raw, savedExpected)).rejects.toThrow(ValuesContractError);
  });

  it("throws when acceptedAt is garbage, non-empty text", async () => {
    const saved = normalizeValuesSubmission(fixtureInput(null));
    const savedExpected = await savedExpectedFor(saved);
    const raw = receiptFor(saved, savedExpected.expectedDigest, { acceptedAt: "not-a-date" });
    await expect(validateValuesResponse(raw, savedExpected)).rejects.toThrow(ValuesContractError);
  });

  it("throws when cutoffAt is garbage, non-empty text", async () => {
    const saved = normalizeValuesSubmission(fixtureInput(null));
    const savedExpected = await savedExpectedFor(saved);
    const raw = receiptFor(saved, savedExpected.expectedDigest, { cutoffAt: "not-a-date" });
    await expect(validateValuesResponse(raw, savedExpected)).rejects.toThrow(ValuesContractError);
  });

  it("throws when quarterStart is not a genuine quarter-start date", async () => {
    const saved = normalizeValuesSubmission(fixtureInput(null));
    const savedExpected = await savedExpectedFor(saved);
    // The 15th of a quarter-start month — not a real quarter boundary.
    const raw = receiptFor(saved, savedExpected.expectedDigest, { quarterStart: "2026-10-15" });
    await expect(validateValuesResponse(raw, savedExpected)).rejects.toThrow(ValuesContractError);
  });

  it("throws when quarterStart names a non-quarter-start month", async () => {
    const saved = normalizeValuesSubmission(fixtureInput(null));
    const savedExpected = await savedExpectedFor(saved);
    const raw = receiptFor(saved, savedExpected.expectedDigest, { quarterStart: "2026-11-01" });
    await expect(validateValuesResponse(raw, savedExpected)).rejects.toThrow(ValuesContractError);
  });

  it("throws when acceptedAt is at/after cutoffAt but eligibility claims eligible_before_cutoff", async () => {
    const saved = normalizeValuesSubmission(fixtureInput(null));
    const savedExpected = await savedExpectedFor(saved);
    const raw = receiptFor(saved, savedExpected.expectedDigest, {
      acceptedAt: "2027-01-10T07:00:00.000Z",
      cutoffAt: "2027-01-10T07:00:00.000Z",
      quarterEligibility: "eligible_before_cutoff",
    });
    await expect(validateValuesResponse(raw, savedExpected)).rejects.toThrow(ValuesContractError);
  });

  it("throws when acceptedAt is before cutoffAt but eligibility claims late_after_cutoff", async () => {
    const saved = normalizeValuesSubmission(fixtureInput(null));
    const savedExpected = await savedExpectedFor(saved);
    const raw = receiptFor(saved, savedExpected.expectedDigest, {
      acceptedAt: "2026-10-05T12:00:00.000Z",
      cutoffAt: "2027-01-10T07:00:00.000Z",
      quarterEligibility: "late_after_cutoff",
    });
    await expect(validateValuesResponse(raw, savedExpected)).rejects.toThrow(ValuesContractError);
  });
});

describe("normalizeValuesSubmission — score entries reject extra keys", () => {
  it("rejects a score entry with an extra property beyond slug/score", () => {
    const scores = FIXTURE_SCORES.map((s) =>
      s.slug === "fullsend" ? { slug: s.slug, score: s.score, weight: 1 } : s,
    );
    expect(() => normalizeValuesSubmission({ ...fixtureInput(null), scores })).toThrow(ValuesContractError);
  });

  it("rejects a score entry missing the score key entirely", () => {
    const scores = FIXTURE_SCORES.map((s) => (s.slug === "fullsend" ? { slug: s.slug } : s));
    // Exercise a malformed runtime payload without pretending it satisfies the input type.
    expect(() => normalizeValuesSubmission({ ...fixtureInput(null), scores: scores as unknown as RawValuesSubmissionInput["scores"] })).toThrow(ValuesContractError);
  });
});
