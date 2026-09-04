// Wave H (H0): readiness and the materials dates come back as an EMBED now,
// and the jobs list has to survive three different databases.
//
// The three columns moved off `projects` into `project_pipeline`, because
// `projects` is the one table a builder (partner) login reads whole for a job
// it was granted and RLS has no column-level half — so "your windows are late"
// was readable by the general contractor. What that costs on the client is a
// join, and a join is a new way for the Jobs page to fail: PostgREST refuses
// the WHOLE read when it cannot serve one part of it, so a phone or a preview
// database that is behind the migration would get nothing at all rather than a
// list without readiness on it.
//
// So this pins the three shapes the reader has to cope with, and the meaning of
// each one:
//   - the embed came back            → the real answer
//   - the embed came back NULL       → nobody has said anything: Ready, no dates
//   - the table is not there yet     → nothing is known, and no pill is drawn
//
// The last one is the difference that matters. "Ready" and "nothing is known"
// look the same on a card and are not the same fact: a job with no row is one
// nobody has flagged, while a database with no table is one where NOBODY CAN
// flag anything, and drawing a green all-clear over that would be a lie the
// crew could not see through.

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  /** Every `select(...)` string the reader asked for, in order. */
  selects: [] as string[],
  /** Answers, popped in order. */
  answers: [] as { data: unknown; error: unknown }[],
}));

vi.mock("./supabase", () => {
  const makeBuilder = (columns: string) => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.eq = chain;
    builder.is = chain;
    builder.not = chain;
    builder.order = chain;
    builder.then = (resolve: (value: unknown) => unknown) => {
      db.selects.push(columns);
      const next = db.answers.shift() ?? { data: [], error: null };
      return Promise.resolve(next).then(resolve);
    };
    return builder;
  };
  return {
    supabase: { from: () => ({ select: (columns: string) => makeBuilder(columns) }) },
    supabaseConfigured: true,
  };
});

import { flattenPipeline, listProjects } from "./api";

const JOB = { id: "p1", job_code: "SANDHOLLOW", name: "Sand Hollow", sort_order: 1 };

describe("flattenPipeline", () => {
  it("folds the embedded row up onto the job", () => {
    const out = flattenPipeline({
      ...JOB,
      project_pipeline: {
        ready_state: "not_ready",
        materials_eta: "2026-09-15",
        materials_arrived_at: null,
      },
    });
    expect(out.ready_state).toBe("not_ready");
    expect(out.materials_eta).toBe("2026-09-15");
    expect(out.materials_arrived_at).toBeNull();
    // The embed key itself never survives: nothing downstream should learn the
    // shape of the join, and a stray key would ride into a query cache.
    expect("project_pipeline" in out).toBe(false);
  });

  it("reads a job with no row as ready, with nothing else to say", () => {
    const out = flattenPipeline({ ...JOB, project_pipeline: null });
    expect(out.ready_state).toBe("ready");
    expect(out.materials_eta).toBeNull();
    expect(out.materials_arrived_at).toBeNull();
  });

  it("accepts the array form a cold schema cache answers with", () => {
    const out = flattenPipeline({
      ...JOB,
      project_pipeline: [{ ready_state: "not_ready", materials_eta: null }],
    });
    expect(out.ready_state).toBe("not_ready");
  });

  it("leaves a job read WITHOUT the embed knowing nothing", () => {
    // Not "ready" — undefined. A phone ahead of the migration has no way to
    // find out, and the Pipeline card draws nothing rather than an all-clear.
    const out = flattenPipeline({ ...JOB });
    expect(out.ready_state).toBeUndefined();
    expect(out.materials_eta).toBeUndefined();
  });
});

describe("listProjects degrades one step at a time", () => {
  beforeEach(() => {
    db.selects = [];
    db.answers = [];
  });

  it("asks for the embed and folds what comes back", async () => {
    db.answers = [
      {
        data: [{ ...JOB, project_pipeline: { ready_state: "not_ready", materials_eta: null } }],
        error: null,
      },
    ];
    const rows = await listProjects();
    expect(db.selects[0]).toContain("project_pipeline(");
    expect(rows[0].ready_state).toBe("not_ready");
  });

  it("still lists the jobs when project_pipeline does not exist yet", async () => {
    db.answers = [
      {
        data: null,
        error: {
          code: "PGRST200",
          message:
            "Could not find a relationship between 'projects' and 'project_pipeline' in the schema cache",
        },
      },
      { data: [JOB], error: null },
    ];
    const rows = await listProjects();
    // Second attempt drops the embed entirely rather than the whole screen.
    expect(db.selects[1]).toBe("*");
    expect(rows).toHaveLength(1);
    expect(rows[0].ready_state).toBeUndefined();
  });

  it("still lists the jobs when sort_order does not exist yet", async () => {
    db.answers = [
      { data: null, error: { code: "42703", message: 'column "sort_order" does not exist' } },
      { data: [{ ...JOB, project_pipeline: null }], error: null },
    ];
    const rows = await listProjects();
    // The embed survives — only the ORDER BY it could not serve is dropped.
    expect(db.selects[1]).toContain("project_pipeline(");
    expect(rows[0].ready_state).toBe("ready");
  });

  it("throws anything that is not a missing table or column", async () => {
    db.answers = [{ data: null, error: { code: "42501", message: "permission denied" } }];
    await expect(listProjects()).rejects.toMatchObject({ code: "42501" });
  });
});
