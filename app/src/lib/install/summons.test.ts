// Summon pure bits: the man-minutes the breakdown shows, and the 4040
// two-man-lift rule that drives the declinable install-start prompt.
//
// Plus the two list reads — mocked at the supabase client, because what they
// ASK FOR is the thing that went wrong once: a `created_at` bound computed
// from the handset's clock hid every call for hands on a phone with a wrong
// date, and hid the caller's own expired call from the only person owed it.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every builder call the reads made, as "method:first argument". */
const db = vi.hoisted(() => ({ ops: [] as string[], rows: [] as unknown[] }));

vi.mock("../supabase", () => {
  const builder: Record<string, unknown> = {};
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      db.ops.push(`${method}:${String(args[0])}`);
      return builder;
    };
  for (const method of ["select", "eq", "in", "gte", "lte", "gt", "lt", "order", "limit"]) {
    builder[method] = record(method);
  }
  // PostgREST builders are thenable, so awaiting the chain hands back rows.
  builder.then = (resolve: (value: unknown) => void) => {
    resolve({ data: db.rows, error: null });
  };
  return {
    supabase: {
      from: record("from"),
      rpc: (fn: string, args: { p_ids?: string[] }) => {
        db.ops.push(`rpc:${fn}`);
        // live_project_ids: no job is in the trash in these tests.
        return Promise.resolve({ data: args?.p_ids ?? [], error: null });
      },
    },
    supabaseConfigured: true,
  };
});

import {
  SUMMON_LIFETIME_MS,
  iAnswered,
  listAllLiveSummons,
  listLiveSummons,
  sizeSuggestsSummon,
  summonEtaLine,
  summonExpired,
  summonHelperMinutes,
  summonHref,
  summonNow,
  summonStripLine,
  visibleSummons,
  type Summon,
} from "./summons";

describe("summonHelperMinutes", () => {
  const t0 = Date.parse("2026-08-14T10:00:00Z");
  it("sums stamped minutes and live helpers together", () => {
    const helpers = [
      { joined_at: "2026-08-14T09:00:00Z", completed_at: "2026-08-14T09:25:00Z", minutes: 25 },
      { joined_at: "2026-08-14T09:50:00Z", completed_at: null, minutes: null },
    ];
    // 25 stamped + 10 live.
    expect(summonHelperMinutes(helpers, t0)).toBe(35);
  });

  it("caps a runaway live clock at 480 and never goes negative", () => {
    expect(
      summonHelperMinutes([{ joined_at: "2026-08-10T00:00:00Z", completed_at: null, minutes: null }], t0),
    ).toBe(480);
    expect(
      summonHelperMinutes([{ joined_at: "2026-08-14T11:00:00Z", completed_at: null, minutes: null }], t0),
    ).toBe(0);
  });
});

// Where "Answer" lands, on every surface that shows a call for hands — the
// landing strip, the dispatch board, and the realtime ring banner. A
// job-level call has no window, so the ring once built `/opening/null`, a
// dead route the helper could not answer from (job-level-summons slice 4).
describe("summonHref", () => {
  it("opens the window's sheet for a window-scoped call", () => {
    expect(summonHref("p1", "op1")).toBe("/projects/p1/opening/op1");
  });
  it("opens the job — never /opening/null — for a job-level call", () => {
    expect(summonHref("p1", null)).toBe("/projects/p1");
    expect(summonHref("p1", undefined)).toBe("/projects/p1");
  });
});

describe("sizeSuggestsSummon (over 4040 = 2+ man lift)", () => {
  it("fires when EITHER side beats 4'0\"", () => {
    expect(sizeSuggestsSummon(60, 40)).toBe(true);
    expect(sizeSuggestsSummon(36, 72)).toBe(true);
    expect(sizeSuggestsSummon(313.5, 179.5)).toBe(true); // window 16
  });
  it("stays quiet at or under 4040, and on unknown sizes", () => {
    expect(sizeSuggestsSummon(48, 48)).toBe(false);
    expect(sizeSuggestsSummon(36, 40)).toBe(false);
    expect(sizeSuggestsSummon(null, undefined)).toBe(false);
  });
});

// The landing strip's line (owner ask, 2026-08-18): a live summon reads as
// one plain sentence — who, how many hands, where — wherever it appears.

describe("summonStripLine", () => {
  const base = {
    needed: 3,
    status: "open" as const,
    requester: { display_name: "Marcus" },
    project: { job_code: "BLACK22" },
    opening: { opening_code: "14" },
  };

  it("someone else's call: name, hands, job and window", () => {
    expect(summonStripLine(base, false)).toBe(
      "Marcus needs 3 hands — BLACK22 · #14",
    );
  });

  it("your own call reads as confirmation, not an emergency", () => {
    expect(summonStripLine(base, true)).toBe(
      "You called for 3 hands — BLACK22 · #14",
    );
  });

  it("one helper is a hand, not hands", () => {
    expect(summonStripLine({ ...base, needed: 1 }, false)).toBe(
      "Marcus needs 1 hand — BLACK22 · #14",
    );
  });

  it("covered says so — the call is answered but still live", () => {
    expect(summonStripLine({ ...base, status: "covered" }, false)).toBe(
      "Marcus needs 3 hands — BLACK22 · #14 (covered)",
    );
  });

  it("missing joins degrade to the plain sentence, never to 'null'", () => {
    expect(
      summonStripLine(
        { needed: 2, status: "open", requester: null, project: null, opening: null },
        false,
      ),
    ).toBe("Someone needs 2 hands");
  });
});

// The ETA (owner ask, 2026-08-19): the caller names when hands are needed;
// every viewer reads the same countdown, and it flips to "needed NOW" when
// the time passes instead of counting negative.
describe("summonEtaLine", () => {
  const now = Date.parse("2026-08-19T13:00:00");

  it("ahead of time: clock time plus minutes left", () => {
    const line = summonEtaLine(new Date(now + 22 * 60_000).toISOString(), now);
    // \s not a plain space: newer ICU puts a narrow no-break space before AM/PM.
    expect(line).toMatch(/^by \d{1,2}:\d{2}\s?(AM|PM) · 22 min$/);
  });

  it("past due reads as needed NOW", () => {
    expect(summonEtaLine(new Date(now - 60_000).toISOString(), now)).toBe("needed NOW");
  });

  it("untimed summons have no line at all", () => {
    expect(summonEtaLine(null, now)).toBeNull();
    expect(summonEtaLine(undefined, now)).toBeNull();
  });
});

describe("summonStripLine with an ETA", () => {
  it("the countdown rides the strip line", () => {
    const now = Date.parse("2026-08-19T13:00:00");
    const line = summonStripLine(
      {
        needed: 3,
        status: "open",
        requester: { display_name: "Marcus" },
        project: { job_code: "BLACK22" },
        opening: { opening_code: "14" },
        needed_at: new Date(now + 30 * 60_000).toISOString(),
      },
      false,
      now,
    );
    expect(line).toMatch(/^Marcus needs 3 hands — BLACK22 · #14 · by .* · 30 min$/);
  });

  it("untimed summons read exactly as before", () => {
    expect(
      summonStripLine(
        {
          needed: 3,
          status: "open",
          requester: { display_name: "Marcus" },
          project: { job_code: "BLACK22" },
          opening: { opening_code: "14" },
          needed_at: null,
        },
        false,
      ),
    ).toBe("Marcus needs 3 hands — BLACK22 · #14");
  });
});

// Backing out (owner ask, 2026-08-19 evening): canceled helpers leave the
// counts, the totals, and the "you answered" state — honestly, everywhere.
describe("canceled helpers", () => {
  it("summonHelperMinutes skips backed-out rows entirely", () => {
    const now = Date.parse("2026-08-19T13:00:00");
    const helpers = [
      { joined_at: new Date(now - 30 * 60_000).toISOString(), completed_at: null, minutes: null, canceled_at: new Date(now - 10 * 60_000).toISOString() },
      { joined_at: new Date(now - 20 * 60_000).toISOString(), completed_at: null, minutes: null, canceled_at: null },
    ];
    expect(summonHelperMinutes(helpers, now)).toBe(20);
  });

  it("iAnswered: true while active, false after backing out, false for strangers", () => {
    const s = {
      helpers: [
        { profile_id: "chris", completed_at: null, canceled_at: null },
        { profile_id: "dave", completed_at: null, canceled_at: "2026-08-19T12:00:00Z" },
      ],
    };
    expect(iAnswered(s, "chris")).toBe(true);
    expect(iAnswered(s, "dave")).toBe(false);
    expect(iAnswered(s, "maria")).toBe(false);
    expect(iAnswered(s, null)).toBe(false);
  });
});

// A day and it's over, and a decline takes the row off your screen (owner
// ask, 2026-09-02): "I should have the option to say Decline so that it goes
// off of my screen. That way I don't have these summons piled up. A summons
// should expire 1 day after the user sends the summons."

const NOW = Date.parse("2026-09-02T13:00:00Z");

function summonRow(over: Partial<Summon> = {}): Summon {
  return {
    id: "s1",
    project_id: "p1",
    opening_id: "o1",
    requested_by: "marcus",
    needed: 3,
    status: "open",
    created_at: new Date(NOW - 60 * 60_000).toISOString(),
    closed_at: null,
    ...over,
  };
}

describe("summonExpired", () => {
  it("an hour-old call is still live", () => {
    expect(summonExpired(new Date(NOW - 60 * 60_000).toISOString(), NOW)).toBe(false);
  });

  it("exactly a day old is still live — the server uses the same < boundary", () => {
    expect(summonExpired(new Date(NOW - SUMMON_LIFETIME_MS).toISOString(), NOW)).toBe(false);
  });

  it("one millisecond past a day is over", () => {
    expect(summonExpired(new Date(NOW - SUMMON_LIFETIME_MS - 1).toISOString(), NOW)).toBe(true);
  });

  it("an unreadable date never hides a call", () => {
    expect(summonExpired("not a date", NOW)).toBe(false);
  });
});

describe("visibleSummons", () => {
  it("keeps a live call from someone else", () => {
    expect(visibleSummons([summonRow()], "chris", NOW)).toHaveLength(1);
  });

  it("drops a call I declined; someone else's decline changes nothing", () => {
    const declinedByMe = summonRow({ id: "a", declines: [{ profile_id: "chris" }] });
    const declinedByDave = summonRow({ id: "b", declines: [{ profile_id: "dave" }] });
    expect(visibleSummons([declinedByMe, declinedByDave], "chris", NOW).map((s) => s.id)).toEqual([
      "b",
    ]);
  });

  it("drops someone else's day-old call — nothing piles up", () => {
    const stale = summonRow({ created_at: new Date(NOW - SUMMON_LIFETIME_MS - 1).toISOString() });
    expect(visibleSummons([stale], "chris", NOW)).toHaveLength(0);
  });

  it("keeps my own expired call, so I learn nobody came", () => {
    const mine = summonRow({
      requested_by: "chris",
      created_at: new Date(NOW - SUMMON_LIFETIME_MS - 1).toISOString(),
    });
    expect(visibleSummons([mine], "chris", NOW)).toHaveLength(1);
  });

  it("keeps my own live call too — the caller sees their own summon", () => {
    expect(visibleSummons([summonRow({ requested_by: "chris" })], "chris", NOW)).toHaveLength(1);
  });

  it("keeps a covered call: answered is not the same as over", () => {
    expect(visibleSummons([summonRow({ status: "covered" })], "chris", NOW)).toHaveLength(1);
  });

  it("signed out (no profile yet): live calls still show, stale ones do not", () => {
    const stale = summonRow({
      id: "old",
      created_at: new Date(NOW - SUMMON_LIFETIME_MS - 1).toISOString(),
      declines: [{ profile_id: "chris" }],
    });
    expect(visibleSummons([summonRow({ id: "new" }), stale], null, NOW).map((s) => s.id)).toEqual([
      "new",
    ]);
  });
});

// The caller's side of the one-day rule (owner ask, 2026-09-02): their own
// expired call is the one row that stays, and it has to read as ended.

describe("summonStripLine on an expired call", () => {
  const expiredAt = new Date(NOW - SUMMON_LIFETIME_MS - 1).toISOString();
  const base = {
    needed: 3,
    status: "open" as const,
    requester: { display_name: "Marcus" },
    project: { job_code: "BLACK22" },
    opening: { opening_code: "14" },
    created_at: expiredAt,
  };

  it("the caller reads what happened, not a live call", () => {
    expect(summonStripLine(base, true, NOW)).toBe(
      "Expired — nobody came in a day — BLACK22 · #14",
    );
  });

  it("says the truth when hands did come and the day ran out", () => {
    expect(
      summonStripLine(
        { ...base, helpers: [{ profile_id: "chris", completed_at: null, canceled_at: null }] },
        true,
        NOW,
      ),
    ).toBe("Expired — the call ended after a day — BLACK22 · #14");
  });

  it("a helper who backed out is not somebody who came", () => {
    expect(
      summonStripLine(
        {
          ...base,
          helpers: [{ profile_id: "dave", completed_at: null, canceled_at: expiredAt }],
        },
        true,
        NOW,
      ),
    ).toBe("Expired — nobody came in a day — BLACK22 · #14");
  });

  it("a still-live call of mine reads exactly as before", () => {
    expect(
      summonStripLine(
        { ...base, created_at: new Date(NOW - 60 * 60_000).toISOString() },
        true,
        NOW,
      ),
    ).toBe("You called for 3 hands — BLACK22 · #14");
  });
});

// Whose clock decides? The database's. `created_at` is stamped by the server;
// `Date.now()` is whatever the handset believes, and a phone whose date has
// drifted must never be the reason an installer stops seeing calls for hands.

describe("summonNow", () => {
  it("corrects the device clock by the measured offset", () => {
    const threeHoursAhead = 3 * 60 * 60_000;
    expect(summonNow(threeHoursAhead, NOW)).toBe(NOW - threeHoursAhead);
  });

  it("is null until the offset is known, and then nothing counts as expired", () => {
    expect(summonNow(null, NOW)).toBeNull();
    expect(summonNow(undefined, NOW)).toBeNull();
    const staleAt = new Date(NOW - SUMMON_LIFETIME_MS - 1).toISOString();
    expect(summonExpired(staleAt, null)).toBe(false);
    expect(visibleSummons([summonRow({ created_at: staleAt })], "chris", null)).toHaveLength(1);
  });

  it("a phone a day ahead still shows a call sent five minutes ago", () => {
    const skewMs = 24 * 60 * 60_000 + 60_000; // device running a day fast
    const deviceNow = NOW + skewMs;
    const justSent = new Date(NOW - 5 * 60_000).toISOString();
    // Read against the handset's own clock the call looks a day old…
    expect(summonExpired(justSent, deviceNow)).toBe(true);
    // …against the server's it is five minutes old, and it stays on screen.
    const server = summonNow(skewMs, deviceNow);
    expect(summonExpired(justSent, server)).toBe(false);
    expect(
      visibleSummons([summonRow({ created_at: justSent })], "chris", server),
    ).toHaveLength(1);
  });
});

describe("the summon list reads", () => {
  beforeEach(() => {
    db.ops = [];
    db.rows = [];
  });

  it("never bounds created_at, on either read", async () => {
    db.rows = [summonRow()];
    await listAllLiveSummons();
    await listLiveSummons("p1");
    expect(db.ops.filter((op) => /^(gte|lte|gt|lt):/.test(op))).toEqual([]);
    expect(db.ops.filter((op) => op === "in:status")).toHaveLength(2);
  });

  it("brings back my own day-old call, so I can be told nobody came", async () => {
    const staleAt = new Date(NOW - SUMMON_LIFETIME_MS - 1).toISOString();
    db.rows = [summonRow({ requested_by: "chris", created_at: staleAt })];
    const rows = await listAllLiveSummons();
    expect(rows.map((s) => s.id)).toEqual(["s1"]);
    // The whole point of reading it: the caller's strip can say what happened.
    expect(visibleSummons(rows, "chris", NOW)).toHaveLength(1);
    expect(summonStripLine(rows[0], true, NOW)).toContain("Expired");
  });

  it("a phone a week ahead of the server still gets every live call", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(NOW + 7 * 24 * 60 * 60_000));
      db.rows = [summonRow()];
      expect(await listAllLiveSummons()).toHaveLength(1);
      expect(await listLiveSummons("p1")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
