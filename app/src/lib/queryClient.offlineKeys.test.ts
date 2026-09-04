import { dehydrate, hydrate, QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
// api.ts reaches for supabase at import time; nothing here calls the network.
vi.mock("./supabase", () => ({ supabase: {} }));
// The job pack's four reads, held still so the pack can be run for real
// below. Spread over the originals so everything else in these modules —
// `byProjectId`, which the second describe tests — stays the real thing.
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  listProjects: async () => [],
  getProjectWindows: async () => [],
}));
vi.mock("./install/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install/api")>()),
  listOpenings: async () => [],
  listPlansets: async () => [],
  getTypeBrainStats: async () => ({}),
  listMarkSpecs: async (projectId: string) => [
    { id: "spec-1", project_id: projectId, mark_code: "1" },
  ],
}));
import {
  prefetchJobPack,
  queryClient,
  shouldPersistQuery,
  shouldPersistQueryState,
} from "./queryClient";
import { byProjectId } from "./api";
import type { ScopeCounts } from "./scope";

/**
 * A gate is only as offline-proof as the fact that CLEARS it.
 *
 * Twice now the same shape of bug has shipped: a read that raises a gate was
 * kept in the offline cache and the read that satisfies it was not, so after a
 * reload with no signal the app refused work that was already done and gave
 * nobody a way past it.
 *
 * - toolboxToday (installer audit, 2026-08-17): the talk was cached, the
 *   signature on it was not, so every Start install was silently refused.
 * - openingPhases (review, 2026-09-02): the opening was cached, so
 *   `needs_flashing = true` came back; the submitted flashing phase that
 *   clears it was not, so Submit went dead on an already-flashed unit and the
 *   install could not even be queued for later.
 * - markSpecs (installer research item 2, 2026-09-04): the opening was cached
 *   and the mark's spec was not, so with no signal the unit sheet showed no
 *   sizes, no hardware, no OXXO layout — and the "no spec sheet for this mark"
 *   notice is gated on the spec list being non-empty, so it said nothing
 *   either. The installer got silence at the window and guessed.
 *
 * These pairs are listed together here so the next one is a failing test
 * rather than a field report.
 */
describe("offline cache: a gate and the fact that clears it travel together", () => {
  const PAIRS: Array<[string, string, string]> = [
    ["the toolbox talk", "todayTalk", "toolboxToday"],
    ["the flashing gate", "opening", "openingPhases"],
    ["what to install", "opening", "markSpecs"],
  ];

  for (const [what, raises, clears] of PAIRS) {
    it(`${what}: both halves survive an offline reload`, () => {
      expect(shouldPersistQuery([raises, "project-1"])).toBe(true);
      expect(shouldPersistQuery([clears, "project-1"])).toBe(true);
    });
  }

  it("still keeps volatile and heavy reads out", () => {
    expect(shouldPersistQuery(["openingPhotos", "opening-1"])).toBe(false);
    expect(shouldPersistQuery([])).toBe(false);
  });

  // The guard in front of the unit sheet asks the all-jobs list whether this
  // job is tracking-only. Offline that read never resolves — react-query
  // pauses a retry rather than failing it — so the guard held a loading screen
  // and the sheet the whole install loop runs on never appeared. It is a gate
  // like any other, and its fact has to be on the phone too.
  it("keeps the list the unit sheet's own guard reads", () => {
    expect(shouldPersistQuery(["projectsAll"])).toBe(true);
  });
});

/**
 * A query that is still in flight must never be written to disk.
 *
 * React Query dehydrates a PENDING query with its in-flight promise attached.
 * `JSON.stringify` turns a promise into `{}`, and on the next launch hydrate
 * calls `.then` on that `{}`, throws, and — by design, as a precaution —
 * discards the whole persisted cache. So one unlucky snapshot taken mid-fetch
 * threw away every offline answer on the device, including all the ones added
 * above after real incidents. The offline e2e spec caught it: the cache was
 * written, and came back empty on the very next load.
 *
 * PENDING is the only status that does this, which is why the guard excludes
 * that and nothing else — see the failed-refetch case below.
 */
describe("only answers that are not still in the air are written to disk", () => {
  it("persists a settled answer on a listed key", () => {
    expect(shouldPersistQueryState(["markSpecs", "project-1"], "success")).toBe(true);
  });

  it("refuses a query that is still loading, however good its key", () => {
    expect(shouldPersistQueryState(["markSpecs", "project-1"], "pending")).toBe(false);
    expect(shouldPersistQueryState(["opening", "opening-1"], "pending")).toBe(false);
  });

  it("refuses any key not on the list", () => {
    expect(shouldPersistQueryState(["openingPhotos", "opening-1"], "success")).toBe(
      false,
    );
    expect(shouldPersistQueryState(["openingPhotos", "opening-1"], "error")).toBe(
      false,
    );
  });

  // Changed 2026-09-04, in review of this same branch: this used to assert
  // that a failed read was refused. That was wrong, and it was a regression
  // against the behaviour that shipped before the status test existed at all.
  // A refetch that fails leaves the previous good data on the query, and a
  // phone with bars but no data does exactly that all morning. Refusing it
  // does not merely leave the file stale — the persister rewrites the whole
  // snapshot on every save, so the spec sheet, the flashing phases and the
  // toolbox state would be DELETED from the phone by a failed background
  // refetch, which is the one moment the installer is about to need them.
  it("keeps a listed answer whose last refetch failed — the data is still there", () => {
    expect(shouldPersistQueryState(["markSpecs", "project-1"], "error")).toBe(true);
    expect(shouldPersistQueryState(["opening", "opening-1"], "error")).toBe(true);
    expect(shouldPersistQueryState(["openingPhases", "opening-1"], "error")).toBe(true);
  });
});

/**
 * Keeping a key in OFFLINE_KEYS only preserves what somebody has already
 * opened on this phone. The job pack is the other half of the promise — "the
 * job is on your phone before the truck leaves" — so a read that matters at
 * the window has to be in both lists, or the first unit of the day is the one
 * with no spec card.
 */
describe("the job pack downloads what the unit sheet reads at the window", () => {
  it("warms the mark specs under the key the sheet reads them by", async () => {
    await prefetchJobPack("project-1");

    // The four it always had.
    for (const key of [
      ["projects"],
      ["openings", "project-1"],
      ["projectWindows", "project-1"],
      ["plansets", "project-1"],
    ]) {
      expect(queryClient.getQueryData(key), `${key[0]} was not warmed`).toBeDefined();
    }
    // The one it was missing, and the reason this test exists. Same key shape
    // OpeningSheet uses: ["markSpecs", projectId].
    expect(
      queryClient.getQueryData(["markSpecs", "project-1"]),
      "no specs in the cache — the sheet shows no spec card in a dead zone",
    ).toEqual([{ id: "spec-1", project_id: "project-1", mark_code: "1" }]);
  });
});

/**
 * A persisted answer goes to localStorage through `JSON.stringify` and comes
 * back through `JSON.parse`, so it has to be made of things JSON can carry.
 *
 * A `Map` is not: it stringifies to `{}`, losing every key. Wave X very nearly
 * shipped `listScopeCounts()` answering with one — the restored value would
 * have been a truthy object with no `.get`, so the jobs list and the manager
 * Home (the two most-used landings) would have thrown on the SECOND launch and
 * every launch after, because the bad value is written back each time. The
 * crash is only reachable from the persisted cache, which is why no rendering
 * test would have caught it and this one lives beside the key list.
 */
describe("a persisted answer survives the round trip localStorage puts it through", () => {
  const row = (id: string): ScopeCounts => ({
    project_id: id,
    openings: 40,
    installed: 32,
    windows: 32,
    doors: 8,
    door_sliders: 5,
    door_french: 2,
    door_bifold: 1,
    door_swing: 0,
    door_other: 0,
    unknown_units: 0,
  });

  it("scopeCounts is persisted, so it must be JSON-native", () => {
    expect(shouldPersistQuery(["scopeCounts"])).toBe(true);

    const fresh = byProjectId([row("job-1"), row("job-2")]);
    const restored: Record<string, ScopeCounts> = JSON.parse(
      JSON.stringify(fresh),
    );

    // The lookup both landings do at render, on the value read back from disk.
    expect(restored["job-1"]?.doors).toBe(8);
    expect(restored["job-2"]?.openings).toBe(40);
    expect(restored["not-a-job"]).toBeUndefined();
  });

  it("the same rows in a Map would have lost every key", () => {
    const asMap = new Map([["job-1", row("job-1")]]);
    expect(JSON.parse(JSON.stringify(asMap))).toEqual({});
  });
});

/**
 * The snapshot itself, end to end: dehydrate with the app's own filter,
 * through `JSON.stringify` exactly as the persister writes it, and back.
 *
 * The boolean above is only half a guarantee. What the phone actually needs is
 * for the DATA to survive the round trip, and the case that matters is the one
 * that reads oddly: a query whose last refetch FAILED. On a phone with bars
 * and no data that is the normal state of a sheet somebody has been reading
 * for ten minutes — the answer is right there on screen, and the refresh
 * behind it is failing. React Query keeps the data through that, so the
 * snapshot must too. It briefly did not (this branch, in review): the filter
 * asked for `status === "success"`, and because the persister rewrites the
 * whole file on every save, the next failed refresh did not leave a stale spec
 * sheet on the phone — it deleted it.
 */
describe("the snapshot survives the trip to disk and back", () => {
  const SPECS = [{ id: "spec-1", mark_code: "1", style: "OXXO" }];

  /** One query, holding data, whose most recent fetch ended in `status`. */
  function clientHolding(status: "success" | "error") {
    const client = new QueryClient();
    client.setQueryData(["markSpecs", "project-1"], SPECS);
    if (status === "error") {
      const query = client
        .getQueryCache()
        .find({ queryKey: ["markSpecs", "project-1"] })!;
      // What a failed background refetch leaves behind: the error, and the
      // data from the read before it.
      query.setState({
        ...query.state,
        status: "error",
        error: new Error("Failed to fetch"),
        fetchStatus: "idle",
      });
    }
    return client;
  }

  /** Write it the way the persister does, read it the way launch does. */
  function throughDisk(client: QueryClient): QueryClient {
    const written = JSON.stringify(
      dehydrate(client, {
        shouldDehydrateQuery: (query) =>
          shouldPersistQueryState(query.queryKey, query.state.status),
      }),
    );
    const restored = new QueryClient();
    hydrate(restored, JSON.parse(written));
    return restored;
  }

  it("brings a good read back", () => {
    expect(
      throughDisk(clientHolding("success")).getQueryData([
        "markSpecs",
        "project-1",
      ]),
    ).toEqual(SPECS);
  });

  it("brings back a read whose last refresh failed, data and all", () => {
    expect(
      throughDisk(clientHolding("error")).getQueryData(["markSpecs", "project-1"]),
      "a failed refresh wiped the spec sheet off the phone",
    ).toEqual(SPECS);
  });
});
