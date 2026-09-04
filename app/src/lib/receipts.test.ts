import { describe, expect, it } from "vitest";
import { buildJobSuggestions, buildReceiptsCsv, type Receipt } from "./receipts";

describe("buildJobSuggestions — this-week recent-jobs ranking", () => {
  it("returns one suggestion per job, most-recent-clock-in first, each with a visible reason", () => {
    const suggestions = buildJobSuggestions([
      { projectId: "p1", jobCode: "BLACK22", name: "Black Desert", clockInAt: "2026-08-27T09:00:00Z" },
      { projectId: "p2", jobCode: "PECAN14", name: "Pecan Grove", clockInAt: "2026-08-25T09:00:00Z" },
    ]);
    expect(suggestions).toEqual([
      { projectId: "p1", jobCode: "BLACK22", name: "Black Desert", reason: "Recent — you clocked this job this week" },
      { projectId: "p2", jobCode: "PECAN14", name: "Pecan Grove", reason: "Recent — you clocked this job this week" },
    ]);
  });

  it("dedupes multiple shifts on the same job to one suggestion, keeping the first (most recent) occurrence", () => {
    const suggestions = buildJobSuggestions([
      { projectId: "p1", jobCode: "BLACK22", name: "Black Desert", clockInAt: "2026-08-27T09:00:00Z" },
      { projectId: "p1", jobCode: "BLACK22", name: "Black Desert", clockInAt: "2026-08-26T09:00:00Z" },
      { projectId: "p1", jobCode: "BLACK22", name: "Black Desert", clockInAt: "2026-08-25T09:00:00Z" },
    ]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].projectId).toBe("p1");
  });

  it("preserves the caller's ordering rather than re-sorting (the query already orders newest-first)", () => {
    const suggestions = buildJobSuggestions([
      { projectId: "p2", jobCode: "PECAN14", name: "Pecan Grove", clockInAt: "2026-08-25T09:00:00Z" },
      { projectId: "p1", jobCode: "BLACK22", name: "Black Desert", clockInAt: "2026-08-27T09:00:00Z" },
    ]);
    expect(suggestions.map((s) => s.projectId)).toEqual(["p2", "p1"]);
  });

  it("skips a shift with no project (should never reach here, but defensive)", () => {
    const suggestions = buildJobSuggestions([
      { projectId: "", jobCode: "", name: "", clockInAt: "2026-08-27T09:00:00Z" },
      { projectId: "p1", jobCode: "BLACK22", name: "Black Desert", clockInAt: "2026-08-26T09:00:00Z" },
    ]);
    expect(suggestions.map((s) => s.projectId)).toEqual(["p1"]);
  });

  it("returns an empty list for no shifts this week", () => {
    expect(buildJobSuggestions([])).toEqual([]);
  });
});

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    id: "r1",
    uploadedBy: "u1",
    uploaderName: "Taylor",
    projectId: "p1",
    pendingJobName: null,
    jobCode: "BLACK22",
    jobName: "Black Desert",
    photoPath: "install-media/receipts/r1.jpg",
    signedUrl: null,
    amountCents: 1250,
    vendor: "Shell",
    purchasedOn: "2026-08-20",
    category: "gas",
    categoryBy: "ai",
    isPassthrough: false,
    note: null,
    ocr: null,
    createdAt: "2026-08-20T10:00:00Z",
    reviewedBy: null,
    reviewedAt: null,
    // Wave Z: not yet coded, not yet posted — a freshly snapped receipt.
    costCodeId: null,
    jobCostId: null,
    ...overrides,
  };
}

describe("buildReceiptsCsv — the accounting bridge", () => {
  it("emits a header row and one row per receipt, cents as a plain decimal", () => {
    const csv = buildReceiptsCsv([receipt()]);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe(
      "date,vendor,amount,category,job_code,job_name,pending_job_name,billed_to_customer,uploaded_by,reviewed,note",
    );
    expect(lines[1]).toBe(
      "2026-08-20,Shell,12.50,gas,BLACK22,Black Desert,,no,Taylor,no,",
    );
  });

  it("marks billed_to_customer and reviewed correctly", () => {
    const csv = buildReceiptsCsv([
      receipt({ isPassthrough: true, reviewedAt: "2026-08-21T00:00:00Z", reviewedBy: "u2" }),
    ]);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    const fields = lines[1].split(",");
    expect(fields[7]).toBe("yes"); // billed_to_customer
    expect(fields[9]).toBe("yes"); // reviewed
  });

  it("leaves billed_to_customer blank when the question was never answered", () => {
    const csv = buildReceiptsCsv([receipt({ isPassthrough: null })]);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[1].split(",")[7]).toBe("");
  });

  it("renders a jobless receipt with its waiting-job name and no job code", () => {
    const csv = buildReceiptsCsv([
      receipt({ projectId: null, jobCode: null, jobName: null, pendingJobName: "New build on 5th" }),
    ]);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    const fields = lines[1].split(",");
    expect(fields[4]).toBe(""); // job_code
    expect(fields[6]).toBe("New build on 5th"); // pending_job_name
  });

  it("quotes a vendor name containing a comma", () => {
    const csv = buildReceiptsCsv([receipt({ vendor: "Ace Hardware, Provo" })]);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[1]).toContain('"Ace Hardware, Provo"');
  });

  it("leaves the amount blank for a receipt with no amount read yet", () => {
    const csv = buildReceiptsCsv([receipt({ amountCents: null })]);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[1].split(",")[2]).toBe("");
  });

  it("formats a sub-dollar amount with a leading zero", () => {
    const csv = buildReceiptsCsv([receipt({ amountCents: 5 })]);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[1].split(",")[2]).toBe("0.05");
  });

  it("carries a UTF-8 BOM so Excel on Windows decodes it correctly", () => {
    const csv = buildReceiptsCsv([receipt()]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("is just the header for an empty list", () => {
    const csv = buildReceiptsCsv([]);
    expect(csv.replace(/^﻿/, "").split("\r\n")).toHaveLength(1);
  });
});
