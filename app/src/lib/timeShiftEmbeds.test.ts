import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `time_shifts` links to `profiles` FOUR times: whose shift it is, plus who
 * approved, edited and rejected it. PostgREST will not guess between them — it
 * answers 300 (PGRST201) and the query fails outright.
 *
 * That took down the clock and the whole timecard once those approval columns
 * reached the live database, and it failed at runtime only: the code compiled,
 * the types were fine, and nothing caught it until an owner opened the page.
 * This test is what catches it, by reading every shift query in the app and
 * refusing one that asks for `profiles` without saying which link it means.
 */

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Comments talk ABOUT these queries, so they must not be read as code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const stringsIn = (text: string): string[] => text.match(/"[^"]*"|'[^']*'/g) ?? [];

/**
 * The select strings of every `from("time_shifts")` query in one file,
 * following `select(SHIFT_SELECT)` back to the constant it names.
 */
function shiftSelects(source: string): string[] {
  const src = stripComments(source);
  const out: string[] = [];
  for (const match of src.matchAll(/from\(\s*["']time_shifts["']\s*\)/g)) {
    const query = src.slice(match.index, match.index + 400);
    const select = query.match(/\.select\(\s*([\s\S]{0,300})/);
    if (!select) continue;

    const named = select[1].match(/^([A-Za-z_$][\w$]*)/);
    if (named) {
      const constant = src.match(
        new RegExp(`const\\s+${named[1]}\\s*=([\\s\\S]{0,400}?);`),
      );
      if (constant) out.push(...stringsIn(constant[1]));
    } else {
      out.push(...stringsIn(select[1]));
    }
  }
  return out;
}

describe("shift queries name which person they mean", () => {
  const queries = sourceFiles(SRC).flatMap((file) =>
    shiftSelects(readFileSync(file, "utf8")).map((select) => ({ file, select })),
  );

  it("finds the shift queries in the app", () => {
    // Guards the guard: at zero, the check below would pass vacuously.
    expect(queries.length).toBeGreaterThan(0);
  });

  it.each(queries)("$file: $select", ({ file, select }) => {
    expect(
      select,
      `${file} embeds a bare profiles(...) on time_shifts. PostgREST cannot ` +
        `tell which of the four links you mean, so the query fails outright. ` +
        `Name the column: profiles!profile_id(...).`,
    ).not.toMatch(/(?<!!)\bprofiles\(/);
  });
});
