// Saving a job when `projects.stories` is not usable yet.
//
// The column ships in 20260980000000, and the app ships ahead of it, so
// createProject/updateProject drop `stories` and retry rather than refusing the
// whole save. There are TWO ways it can be unusable and only one of them is a
// missing column:
//
//   - the migration has not deployed        → PGRST204 / 42703
//   - the column exists but is not GRANTED  → 42501
//
// The second one is the live risk. Table-level INSERT/UPDATE on `projects` is
// revoked and the writable columns are granted back BY NAME (wave D's law), and
// wave Z re-states both of those lists without `stories` in them. X's grant is
// additive and only survives because its number is higher. If that ever goes
// wrong, this retry is what stands between a person and a New-job form that
// will not submit — so it is tested, not assumed.

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  /** Every column set handed to the database, in order. */
  attempts: [] as Record<string, unknown>[],
  /** Error to answer the FIRST attempt with; later attempts succeed. */
  firstError: null as { code: string; message: string } | null,
}));

vi.mock("./supabase", () => {
  const builder: Record<string, unknown> = {};
  const answer = () => {
    const isFirst = db.attempts.length === 1;
    const error = isFirst ? db.firstError : null;
    return Promise.resolve({
      data: error ? null : { id: "p1", ...db.attempts[db.attempts.length - 1] },
      error,
    });
  };
  builder.update = (cols: Record<string, unknown>) => {
    db.attempts.push(cols);
    return builder;
  };
  builder.insert = builder.update;
  builder.eq = () => builder;
  builder.select = () => builder;
  builder.single = answer;
  builder.maybeSingle = answer;
  return { supabase: { from: () => builder } };
});

import { updateProject } from "./api";

describe("saving a job when `stories` cannot be written", () => {
  beforeEach(() => {
    db.attempts = [];
    db.firstError = null;
  });

  it("saves in one go when the column is there", async () => {
    await updateProject("p1", { name: "Mad Moose", stories: 2 });
    expect(db.attempts).toHaveLength(1);
    expect(db.attempts[0].stories).toBe(2);
  });

  it("drops the storey count and keeps the rest when the column is missing", async () => {
    db.firstError = {
      code: "PGRST204",
      message: "Could not find the 'stories' column of 'projects'",
    };
    const saved = await updateProject("p1", { name: "Mad Moose", stories: 2 });

    expect(db.attempts).toHaveLength(2);
    expect(db.attempts[1]).not.toHaveProperty("stories");
    // The rest of what the person typed still lands.
    expect(db.attempts[1].name).toBe("Mad Moose");
    expect((saved as { name?: string }).name).toBe("Mad Moose");
  });

  it("does the same when the column exists but was never granted", async () => {
    // What a lost `grant update (stories) on projects` actually returns.
    db.firstError = {
      code: "42501",
      message: "permission denied for column stories of relation projects",
    };
    await updateProject("p1", { name: "Mad Moose", stories: 3 });

    expect(db.attempts).toHaveLength(2);
    expect(db.attempts[1]).not.toHaveProperty("stories");
    expect(db.attempts[1].name).toBe("Mad Moose");
  });

  it("still reports a real refusal instead of retrying past it", async () => {
    // Row-level security saying no is also a 42501, and it is a genuine "no" —
    // the person is not allowed to touch this job at all. Retrying without one
    // column would change nothing and hide the reason.
    db.firstError = {
      code: "42501",
      message: "new row violates row-level security policy for table projects",
    };
    await expect(updateProject("p1", { name: "Mad Moose" })).rejects.toMatchObject({
      code: "42501",
    });
    expect(db.attempts).toHaveLength(1);
  });
});
