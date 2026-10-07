import { beforeEach, describe, expect, it, vi } from "vitest";

// A Supabase stand-in that EXECUTES the keyset read against an in-memory
// table: eq/is/not/or(cursor, window)/order/limit — so paging behavior (ties,
// deletes between pages, the boundary probe) is tested, not just the shape.
const db = vi.hoisted(() => {
  type Op = [string, unknown[]];
  type Query = { table: string; ops: Op[] };
  const state = {
    queries: [] as Query[],
    respond: (_q: Query): { data: unknown; error: unknown } => ({ data: [], error: null }),
  };
  function from(table: string) {
    const q: Query = { table, ops: [] };
    state.queries.push(q);
    const builder: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
              Promise.resolve().then(() => state.respond(q)).then(ok, bad);
          }
          return (...args: unknown[]) => {
            q.ops.push([String(prop), args]);
            return builder;
          };
        },
      },
    );
    return builder;
  }
  return { state, supabase: { from } };
});

vi.mock("./supabase", () => ({ supabase: db.supabase }));

import {
  EXPORT_MAX_ROWS,
  GROUPED_PHOTO_EXPORT_MAX_ROWS,
  listAllPhotosForGroupedExport,
  MediaExportDataError,
} from "./photos";
import { listGroupedPhotoExportItems } from "./groupedPhotoExport";
import { mediaExportWindow } from "./mediaExport";

type Row = {
  id: string;
  storage_path: string;
  created_at: string;
  taken_at: string | null;
  project_id: string | null;
  kind?: string;
  deleted_at?: string | null;
};
type Query = (typeof db.state.queries)[number];

const CURSOR_RE = /created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\."([^"]+)"\)/;
const WINDOW_RE = /taken_at\.gte\."([^"]+)",taken_at\.lt\."([^"]+)"/;

let table: Row[] = [];
let serverFiltersPaths = true;

function desc(a: Row, b: Row) {
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function execute(q: Query): Row[] {
  let rows = table.slice();
  let limit = Infinity;
  for (const [op, args] of q.ops) {
    const [col, a, b] = args as [keyof Row, unknown, unknown];
    if (op === "eq") rows = rows.filter((r) => r[col] === a);
    if (op === "is") rows = rows.filter((r) => (r[col] ?? null) === null);
    if (op === "not" && serverFiltersPaths) {
      const prefix = String(b).replace(/%$/, "");
      rows = rows.filter((r) => !String(r[col]).startsWith(prefix));
    }
    if (op === "or") {
      const expr = String(args[0]);
      const c = CURSOR_RE.exec(expr);
      if (c) rows = rows.filter((r) => r.created_at < c[1] || (r.created_at === c[2] && r.id < c[3]));
      const w = WINDOW_RE.exec(expr);
      if (w) rows = rows.filter((r) => { const t = r.taken_at ?? r.created_at; return t >= w[1] && t < w[2]; });
    }
    if (op === "limit") limit = args[0] as number;
    if (op === "range") throw new Error("grouped reader must not page by offset");
  }
  return rows
    .sort(desc)
    .slice(0, limit)
    .map(({ id, storage_path, created_at, taken_at, project_id }) => ({ id, storage_path, created_at, taken_at, project_id }));
}

function at(i: number) {
  // Newest first by index; minutes keep a lexicographic ISO order.
  return new Date(Date.UTC(2026, 9, 6, 18) - i * 60_000).toISOString();
}

function row(i: number, over: Partial<Row> = {}): Row {
  return {
    id: `p${String(i).padStart(6, "0")}`,
    storage_path: `install-media/photos/p${i}.jpg`,
    created_at: at(i),
    taken_at: null,
    project_id: "job1",
    kind: "photo",
    deleted_at: null,
    ...over,
  };
}

const ops = (q: Query, name: string) => q.ops.filter((o) => o[0] === name).map((o) => o[1]);

beforeEach(() => {
  db.state.queries = [];
  table = [];
  serverFiltersPaths = true;
  db.state.respond = (q) => ({ data: execute(q), error: null });
});

describe("listAllPhotosForGroupedExport", () => {
  it("returns every row past the flat 5000 cap by keyset, newest first, once each", async () => {
    table = Array.from({ length: EXPORT_MAX_ROWS + 1234 }, (_, i) => row(i));
    const rows = await listAllPhotosForGroupedExport(null, null);
    expect(rows).toHaveLength(EXPORT_MAX_ROWS + 1234);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows[0].id).toBe("p000000");
    expect(rows.at(-1)!.id).toBe(`p${String(EXPORT_MAX_ROWS + 1233).padStart(6, "0")}`);
    // Same RLS-scoped read shape as the flat export, every page.
    for (const q of db.state.queries) {
      expect(q.table).toBe("attachments");
      expect(ops(q, "select")[0][0]).toBe("id, storage_path, created_at, taken_at, project_id");
      expect(ops(q, "eq")).toContainEqual(["kind", "photo"]);
      expect(ops(q, "is")).toContainEqual(["deleted_at", null]);
      expect(ops(q, "not")).toEqual([
        ["storage_path", "like", "install-media/receipts/%"],
        ["storage_path", "like", "receipts/%"],
      ]);
      expect(ops(q, "order")).toEqual([["created_at", { ascending: false }], ["id", { ascending: false }]]);
    }
    expect(ops(db.state.queries[0], "or")).toEqual([]);
    expect(String(ops(db.state.queries[1], "or")[0][0])).toMatch(CURSOR_RE);
  });

  it("pages through created_at ties by id without repeating or skipping", async () => {
    table = Array.from({ length: 23 }, (_, i) => row(i, { created_at: at(i < 20 ? 0 : i) }));
    const rows = await listAllPhotosForGroupedExport(null, null, undefined, { pageSize: 3 });
    expect(rows.map((r) => r.id)).toEqual(table.slice().sort(desc).map((r) => r.id));
  });

  it("neither repeats nor skips surviving rows when rows are inserted or deleted between pages", async () => {
    table = Array.from({ length: 30 }, (_, i) => row(i + 10));
    let page = 0;
    db.state.respond = (q) => {
      const data = execute(q);
      page++;
      if (page === 1) {
        table = table.filter((r) => r.id !== "p000011" && r.id !== "p000030"); // one read, one not yet
        table.push(row(0)); // a newer insert lands before the cursor
      }
      return { data, error: null };
    };
    const rows = await listAllPhotosForGroupedExport(null, null, undefined, { pageSize: 4 });
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("p000011"); // already read: kept
    expect(ids).not.toContain("p000030"); // deleted before it was reached
    expect(ids).not.toContain("p000000"); // newer than the snapshot cursor
    expect(ids).toHaveLength(29);
  });

  it("advances from the RAW last row, even when the local receipt filter drops it", async () => {
    serverFiltersPaths = false; // a server that returned receipt-namespace rows anyway
    table = Array.from({ length: 9 }, (_, i) =>
      row(i, i % 3 === 2 ? { storage_path: `install-media/receipts/r${i}.jpg` } : {}),
    );
    const rows = await listAllPhotosForGroupedExport(null, null, undefined, { pageSize: 3 });
    expect(rows.map((r) => r.id)).toEqual(["p000000", "p000001", "p000003", "p000004", "p000006", "p000007"]);
    const second = String(ops(db.state.queries[1], "or")[0][0]);
    expect(CURSOR_RE.exec(second)![3]).toBe("p000002");
  });

  it("ANDs the cursor with the date window in one or parameter", async () => {
    const window = mediaExportWindow("2026-10-05", "2026-10-06");
    table = Array.from({ length: 7 }, (_, i) => row(i));
    await listAllPhotosForGroupedExport("job1", window, undefined, { pageSize: 3 });
    const first = ops(db.state.queries[0], "or");
    expect(first).toHaveLength(1);
    expect(String(first[0][0])).toMatch(/^and\(taken_at\.gte/);
    const second = ops(db.state.queries[1], "or");
    expect(second).toHaveLength(1);
    expect(String(second[0][0])).toMatch(/^and\(or\(and\(taken_at\.gte.*\)\),or\(created_at\.lt\..*\)\)$/);
    expect(ops(db.state.queries[1], "eq")).toContainEqual(["project_id", "job1"]);
  });

  it("accepts exactly 50,000 rows after a one-row boundary probe, and refuses 50,001 whole", async () => {
    table = Array.from({ length: GROUPED_PHOTO_EXPORT_MAX_ROWS }, (_, i) => row(i));
    await expect(listAllPhotosForGroupedExport(null, null)).resolves.toHaveLength(GROUPED_PHOTO_EXPORT_MAX_ROWS);
    expect(ops(db.state.queries.at(-1)!, "limit")).toEqual([[1]]);

    db.state.queries = [];
    table.push(row(GROUPED_PHOTO_EXPORT_MAX_ROWS));
    const err = await listAllPhotosForGroupedExport(null, null).catch((e) => e);
    expect(err).toBeInstanceOf(MediaExportDataError);
    expect(err).toMatchObject({ code: "too_many", limit: GROUPED_PHOTO_EXPORT_MAX_ROWS });
  }, 30_000);

  it("refuses the whole listing past the metadata budget", async () => {
    table = Array.from({ length: 50 }, (_, i) => row(i));
    const enc = new TextEncoder();
    const total = execute({ table: "attachments", ops: [] }).reduce((n, r) => n + enc.encode(JSON.stringify(r)).byteLength, 0);
    await expect(
      listAllPhotosForGroupedExport(null, null, undefined, { pageSize: 10, maxMetadataBytes: total - 1 }),
    ).rejects.toMatchObject({ code: "too_many" });
    await expect(
      listAllPhotosForGroupedExport(null, null, undefined, { pageSize: 10, maxMetadataBytes: total }),
    ).resolves.toHaveLength(50);
  });

  it("budgets UTF-8 bytes, not UTF-16 code units", async () => {
    // "é" is 1 code unit but 2 bytes; "😀" is 2 code units but 4 bytes.
    table = Array.from({ length: 6 }, (_, i) => row(i, { storage_path: `install-media/photos/éé😀${i}.jpg` }));
    const rows = execute({ table: "attachments", ops: [] }).map((r) => JSON.stringify(r));
    const units = rows.reduce((n, s) => n + s.length, 0);
    const bytes = rows.reduce((n, s) => n + new TextEncoder().encode(s).byteLength, 0);
    expect(bytes).toBeGreaterThan(units);
    await expect(
      listAllPhotosForGroupedExport(null, null, undefined, { pageSize: 4, maxMetadataBytes: units }),
    ).rejects.toMatchObject({ code: "too_many" });
    await expect(
      listAllPhotosForGroupedExport(null, null, undefined, { pageSize: 4, maxMetadataBytes: bytes }),
    ).resolves.toHaveLength(6);
  });

  it("refuses on a database without the scoping columns", async () => {
    db.state.respond = () => ({ data: null, error: { code: "42703", message: 'column "deleted_at" does not exist' } });
    await expect(listAllPhotosForGroupedExport(null, null)).rejects.toMatchObject({ code: "schema_missing" });
  });

  it("passes the signal to every page and stops between pages once aborted", async () => {
    table = Array.from({ length: 20 }, (_, i) => row(i));
    const ctl = new AbortController();
    db.state.respond = (q) => {
      const data = execute(q);
      ctl.abort();
      return { data, error: null };
    };
    const err = await listAllPhotosForGroupedExport(null, null, ctl.signal, { pageSize: 5 }).catch((e) => e);
    expect(err).toMatchObject({ name: "AbortError" });
    expect(db.state.queries).toHaveLength(1);
    expect(ops(db.state.queries[0], "abortSignal")).toEqual([[ctl.signal]]);
  });
});

describe("listGroupedPhotoExportItems", () => {
  it("lists photos only, by exact local day, unsigned", async () => {
    table = [
      row(1, { taken_at: "2026-10-06T05:00:00Z", project_id: null }),
      row(2, { taken_at: "2026-10-04T12:00:00Z" }),
      row(3, { storage_path: "receipts/x.jpg" }),
    ];
    const items = await listGroupedPhotoExportItems(
      { kind: "photo", projectId: null, fromDate: "2026-10-05", throughDate: "2026-10-06" },
      "America/Denver",
    );
    expect(items).toEqual([
      expect.objectContaining({ id: "p000001", date: "2026-10-05", projectId: null, kind: "photo", documentPath: null }),
    ]);
    expect(JSON.stringify(items)).not.toMatch(/token=|https?:/);
  });

  it("rejects receipt mode and bad ranges before reading", async () => {
    await expect(
      listGroupedPhotoExportItems({ kind: "receipt", projectId: null, fromDate: "", throughDate: "" }),
    ).rejects.toThrow("photo_only");
    await expect(
      listGroupedPhotoExportItems({ kind: "photo", projectId: null, fromDate: "2026-10-06", throughDate: "" }),
    ).rejects.toThrow("range_incomplete");
    expect(db.state.queries).toHaveLength(0);
  });
});
