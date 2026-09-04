import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Monday board is STG Windows' board, and this app is a guest on it.
 *
 * Everything the connector does there is a read: list the up-and-coming jobs,
 * list the files on an item, ask for a one-hour download link. It must never
 * write — no status change, no column edit, no file uploaded back, nothing. The
 * board is another company's system of record and an accidental write there is
 * not a mistake we can take back.
 *
 * A source-contract test rather than a behaviour test, for the same reason
 * aiProviderContract.test.ts is one: no unit test can honestly prove what a
 * deployed function sent to api.monday.com. What this catches is the drift
 * nothing else would — somebody a year from now adding "and mark the row Done
 * in Monday while we're there", which is a two-line change that would look
 * perfectly reasonable in review.
 *
 * The first check is deliberately the crudest one available: the GraphQL
 * keyword for a write must not appear in the file AT ALL, in code or in a
 * comment. A test that tried to be clever about which occurrences were real
 * would be a test somebody could argue with.
 */

const SOURCE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/functions/monday-sync/index.ts",
);

const src = readFileSync(SOURCE, "utf8");

/** Every backtick template in the file. None of them nest a backtick. */
const templates = src.match(/`[^`]*`/g) ?? [];

describe("monday-sync only ever reads STG's board", () => {
  it("never sends a GraphQL write", () => {
    // Spelled by code so this test file can name the keyword without tripping
    // its own check when somebody greps the tree for it.
    const keyword = ["muta", "tion"].join("");
    const hits = src
      .split("\n")
      .map((line, i) => `${i + 1}: ${line.trim()}`)
      .filter((line) => line.toLowerCase().includes(keyword));
    expect(
      hits,
      "supabase/functions/monday-sync/index.ts may send GraphQL queries only — " +
        "the Ops Gantt Chart belongs to STG Windows and this app is a guest on it",
    ).toEqual([]);
  });

  it("every GraphQL operation it sends is declared as a query", () => {
    const graphql = templates.filter(
      (t) => t.includes("{") && /\b(boards|items|items_page|assets)\b/.test(t),
    );
    expect(graphql.length).toBeGreaterThan(0);
    for (const t of graphql) {
      expect(t.replace(/^`\s*/, "").slice(0, 5)).toBe("query");
    }
  });

  it("never uploads a file back to Monday", () => {
    expect(src).not.toContain("add_file_to_column");
    expect(src).not.toContain("multipart/form-data");
  });

  it("never stores Monday's one-hour download link", () => {
    // public_url expires in an hour, so a stored one is a list that 404s and a
    // live unauthenticated link to another company's document sitting in a
    // table a foreman can read. The sync keeps asset ids; the link is asked for
    // fresh at the moment somebody presses Get.
    const from = src.indexOf("interface StagedFile");
    const to = src.indexOf("const ASSET_FIELDS");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    // The shape written into monday_jobs.files, and the function that fills it.
    expect(src.slice(from, to)).not.toContain("public_url");
    // And the board sync does not even ask Monday for it.
    expect(src).toContain(
      'const ASSET_FIELDS = "id name file_extension file_size created_at"',
    );
  });
});
