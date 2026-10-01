import { describe, expect, it } from "vitest";
import { buildAiIssueBody } from "./aiIssueReport";
import { FEEDBACK_CATALOG } from "./i18n/feedbackCatalog";

const t = ((key: keyof typeof FEEDBACK_CATALOG) => FEEDBACK_CATALOG[key].en) as Parameters<typeof buildAiIssueBody>[1];

describe("AI issue preview", () => {
  it("keeps the request and room for editing under the report limit", () => {
    const report = buildAiIssueBody({ question: "Q".repeat(4000), answer: "A".repeat(4000), channel: "text" }, t);
    expect(report.length).toBeLessThanOrEqual(1900);
    expect(report).toContain("My request:");
    expect(report).toContain("Q".repeat(100));
    expect(report).toContain("AI response:");
    expect(report).toContain("A".repeat(100));
    expect(report.length).toBeLessThan(2000);
  });
  it("identifies a failed live session without a recording", () => {
    const report = buildAiIssueBody({ question: "", answer: "Connection stopped", channel: "live" }, t);
    expect(report).toContain("AI issue — Live Chat");
    expect(report).toContain("Connection stopped");
  });
});
