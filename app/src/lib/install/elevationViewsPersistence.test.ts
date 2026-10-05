import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  rows: [] as { project_id: string; planset_id: string; mark_code: string }[],
}));

vi.mock("../supabase", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "project_mark_elevation_views") throw new Error(`Unexpected table ${table}`);
      const filters: Record<string, string> = {};
      return {
        delete() {
          return {
            eq(column: string, value: string) {
              filters[column] = value;
              return this;
            },
            then(resolve: (result: { error: null }) => void) {
              db.rows = db.rows.filter((row) =>
                !Object.entries(filters).every(([column, value]) =>
                  row[column as keyof typeof row] === value,
                ),
              );
              resolve({ error: null });
            },
          };
        },
      };
    },
  },
}));

import { saveElevationViews } from "./api";

beforeEach(() => {
  db.rows = [
    { project_id: "pv40", planset_id: "vinyl", mark_code: "V1" },
    { project_id: "pv40", planset_id: "aluminum", mark_code: "A1" },
    { project_id: "other-job", planset_id: "vinyl", mark_code: "X1" },
  ];
});

describe("re-reading one drawing set's elevation references", () => {
  it("keeps the other drawing set and other jobs when this set has no references", async () => {
    expect(await saveElevationViews("pv40", "vinyl", [])).toEqual({ saved: 0 });
    expect(db.rows).toEqual([
      { project_id: "pv40", planset_id: "aluminum", mark_code: "A1" },
      { project_id: "other-job", planset_id: "vinyl", mark_code: "X1" },
    ]);
  });
});
