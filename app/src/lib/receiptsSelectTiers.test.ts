// The receipts read layer degrades by COLUMN TIER, and this proves the ladder.
//
// THE HOUSE RULE: a phone running a bundle ahead of the migration still LOADS
// every receipt screen. Deploying the backend has silently failed on this
// project before, so "the app arrived somewhere its database has not" is the
// likely direction, not the theoretical one — and a supervisor opening
// /receipts to a red error, on the day the office is trying to close out a
// month, is the failure this exists to prevent.
//
// Three tiers now: document_path (PDF receipts, 20260990000000), then wave Z's
// cost_code_id / job_cost_id (20260978000000), then the base list every
// database has had since receipts existed. Each rung must drop ONLY its own
// column — a database with wave Z but no document_path has to keep its cost
// codes and its "posted" chips.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every `select(cols)` the module asked for, in order. */
const asked: string[] = [];
/** Answers to hand back, one per call, oldest first. */
let answers: { data: unknown; error: unknown }[] = [];

function nextAnswer(): { data: unknown; error: unknown } {
  return answers.shift() ?? { data: [], error: null };
}

/** The slice of the PostgREST builder listReceipts actually chains. */
function builder() {
  const chain = {
    order: () => chain,
    limit: () => Promise.resolve(nextAnswer()),
    gte: () => chain,
    lt: () => chain,
    eq: () => chain,
    is: () => chain,
  };
  return chain;
}

vi.mock("./supabase", () => ({
  supabase: {
    from: () => ({
      select: (cols: string) => {
        asked.push(cols);
        return builder();
      },
    }),
  },
  supabaseConfigured: true,
}));

// A signed thumbnail URL is not this file's business.
vi.mock("./photos", () => ({ signedMedia: async () => null }));

const missingColumn = (name: string) => ({
  code: "PGRST204",
  message: `column receipts.${name} does not exist`,
});

const ROW = {
  id: "r1",
  uploaded_by: "u1",
  project_id: null,
  pending_job_name: null,
  photo_path: "install-media/receipts/r1.jpg",
  amount_cents: null,
  vendor: null,
  purchased_on: null,
  category: null,
  category_by: null,
  is_passthrough: null,
  note: null,
  ocr: null,
  created_at: "2026-09-05T10:00:00Z",
  reviewed_by: null,
  reviewed_at: null,
};

beforeEach(() => {
  asked.length = 0;
  answers = [];
  vi.resetModules();
});

/** A fresh module each time: the narrowing is remembered for the life of a
 * tab, which is the point of it — and would otherwise leak between tests. */
async function freshListReceipts() {
  const mod = await import("./receipts");
  return mod.listReceipts;
}

describe("the receipts select ladder", () => {
  it("asks for every column on a fully-migrated database, and asks once", async () => {
    answers = [{ data: [{ ...ROW, cost_code_id: "c1", job_cost_id: "j1", document_path: "install-media/receipts/r1.pdf" }], error: null }];
    const listReceipts = await freshListReceipts();
    const rows = await listReceipts();

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("document_path");
    expect(asked[0]).toContain("cost_code_id");
    expect(rows[0].documentPath).toBe("install-media/receipts/r1.pdf");
    expect(rows[0].costCodeId).toBe("c1");
  });

  it("drops document_path — and NOTHING else — when the PDF migration has not landed", async () => {
    answers = [
      { data: null, error: missingColumn("document_path") },
      { data: [{ ...ROW, cost_code_id: "c1", job_cost_id: "j1" }], error: null },
    ];
    const listReceipts = await freshListReceipts();
    const rows = await listReceipts();

    expect(asked).toHaveLength(2);
    expect(asked[1]).not.toContain("document_path");
    // Wave Z survives the fall: a database that has cost codes keeps them.
    expect(asked[1]).toContain("cost_code_id");
    expect(rows[0].documentPath).toBeNull();
    expect(rows[0].costCodeId).toBe("c1");
  });

  it("falls all the way to the base list when wave Z is missing too", async () => {
    answers = [
      { data: null, error: missingColumn("document_path") },
      { data: null, error: missingColumn("cost_code_id") },
      { data: [ROW], error: null },
    ];
    const listReceipts = await freshListReceipts();
    const rows = await listReceipts();

    expect(asked).toHaveLength(3);
    expect(asked[2]).not.toContain("document_path");
    expect(asked[2]).not.toContain("cost_code_id");
    expect(rows[0].documentPath).toBeNull();
    expect(rows[0].costCodeId).toBeNull();
    expect(rows[0].photoPath).toBe("install-media/receipts/r1.jpg");
  });

  it("stays narrowed for the rest of the tab rather than re-asking on every read", async () => {
    answers = [
      { data: null, error: missingColumn("document_path") },
      { data: [{ ...ROW, cost_code_id: null, job_cost_id: null }], error: null },
      { data: [{ ...ROW, cost_code_id: null, job_cost_id: null }], error: null },
    ];
    const listReceipts = await freshListReceipts();
    await listReceipts();
    await listReceipts();

    expect(asked).toHaveLength(3);
    expect(asked[2]).not.toContain("document_path");
  });

  it("does not swallow a real failure by peeling columns off it", async () => {
    answers = [{ data: null, error: { code: "42501", message: "permission denied for table receipts" } }];
    const listReceipts = await freshListReceipts();
    await expect(listReceipts()).rejects.toMatchObject({ code: "42501" });
    expect(asked).toHaveLength(1);
  });
});
