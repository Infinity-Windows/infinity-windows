import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatRate,
  indexPayRates,
  localDayOf,
  parseRateDollars,
  rateInEffect,
  type PayRate,
} from "./payRates";

/** Real-shaped rows: two people, one of them with a raise part-way through the
 * year — the case the whole history exists for. */
function rate(
  profileId: string,
  hourlyCents: number,
  effectiveFrom: string,
): PayRate {
  return {
    id: `${profileId}-${effectiveFrom}`,
    profileId,
    hourlyCents,
    effectiveFrom,
    setBy: "00000000-0000-4000-8000-000000000001",
    createdAt: `${effectiveFrom}T14:02:11.000Z`,
  };
}

const ROWS: PayRate[] = [
  rate("maria", 2800, "2026-01-01"),
  rate("maria", 3250, "2026-06-01"),
  rate("sam", 4100, "2026-03-15"),
];

describe("indexPayRates", () => {
  it("groups by person, newest start date first", () => {
    const idx = indexPayRates(ROWS);
    expect([...idx.keys()].sort()).toEqual(["maria", "sam"]);
    expect(idx.get("maria")!.map((r) => r.effectiveFrom)).toEqual([
      "2026-06-01",
      "2026-01-01",
    ]);
  });

  it("sorts even when the rows arrive oldest-first", () => {
    const idx = indexPayRates([...ROWS].reverse());
    expect(idx.get("maria")![0].hourlyCents).toBe(3250);
  });
});

describe("rateInEffect", () => {
  const idx = indexPayRates(ROWS);

  it("prices a shift at the rate that was in force that day, not today's", () => {
    // THE reason pay_rates is a history: a raise in June must not reprice May.
    expect(rateInEffect(idx.get("maria"), "2026-05-31")!.hourlyCents).toBe(2800);
    expect(rateInEffect(idx.get("maria"), "2026-06-01")!.hourlyCents).toBe(3250);
    expect(rateInEffect(idx.get("maria"), "2026-09-03")!.hourlyCents).toBe(3250);
  });

  it("gives no rate for a day before the person had one", () => {
    expect(rateInEffect(idx.get("sam"), "2026-03-14")).toBeNull();
    expect(rateInEffect(idx.get("sam"), "2026-03-15")!.hourlyCents).toBe(4100);
  });

  it("gives no rate for somebody with none on file", () => {
    expect(rateInEffect(idx.get("nobody"), "2026-09-03")).toBeNull();
    expect(rateInEffect([], "2026-09-03")).toBeNull();
    expect(rateInEffect(undefined, "2026-09-03")).toBeNull();
  });

  it("says nothing rather than guessing when the day is missing", () => {
    expect(rateInEffect(idx.get("maria"), "")).toBeNull();
  });
});

describe("localDayOf", () => {
  it("files a timestamp under the reader's own calendar day", () => {
    // Built from local parts so the assertion holds in any timezone the suite
    // runs in — the point is that the ISO instant round-trips to that day.
    const local = new Date(2026, 8, 3, 17, 30, 0);
    expect(localDayOf(local.toISOString())).toBe("2026-09-03");
  });

  it("is empty for a value that is not a timestamp", () => {
    expect(localDayOf("not a date")).toBe("");
  });
});

describe("formatRate", () => {
  it("writes cents as money", () => {
    expect(formatRate(3250)).toBe("$32.50");
    expect(formatRate(4000)).toBe("$40.00");
    expect(formatRate(5)).toBe("$0.05");
  });
});

describe("parseRateDollars", () => {
  it("reads what a person actually types", () => {
    expect(parseRateDollars("32.50")).toBe(3250);
    expect(parseRateDollars("$32.50")).toBe(3250);
    expect(parseRateDollars(" 32 ")).toBe(3200);
    expect(parseRateDollars("1,000")).toBe(100000);
  });

  it("rounds to the cent instead of trusting float arithmetic", () => {
    // 32.55 * 100 === 3254.9999999999995
    expect(parseRateDollars("32.55")).toBe(3255);
  });

  it("refuses anything that is not a rate", () => {
    expect(parseRateDollars("")).toBeNull();
    expect(parseRateDollars("abc")).toBeNull();
    expect(parseRateDollars("-5")).toBeNull();
    expect(parseRateDollars(".")).toBeNull();
  });
});

/**
 * Wave Z's standing guarantee about the AI: "the assistant's tools run at the
 * caller's permission and never return a rate to anyone without the grant."
 *
 * In the app that is true by construction — every AI tool reads through the
 * signed-in client, so pay_rates' policy answers a non-granted caller with no
 * rows. The edge functions are the exception worth a test: they hold the
 * SERVICE ROLE key, which bypasses RLS entirely, so a single `.from("pay_rates")`
 * added to `ask` (or any sibling) would read every wage in the company past
 * every policy in this migration and hand it to a model. This scan is what
 * turns that from a thing somebody has to remember into a red build.
 */
describe("the edge functions never touch pay_rates", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const FUNCTIONS = join(HERE, "../../../supabase/functions");

  function everyFile(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...everyFile(full));
      else if (/\.(ts|js)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("finds the functions directory at all (so this is not vacuous)", () => {
    expect(everyFile(FUNCTIONS).length).toBeGreaterThan(10);
  });

  it("names pay_rates nowhere, because they run past RLS", () => {
    const offenders = everyFile(FUNCTIONS).filter((f) =>
      readFileSync(f, "utf8").includes("pay_rates"),
    );
    expect(offenders).toEqual([]);
  });
});
