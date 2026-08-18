// The queued half of tagging, setting aside, and moving a container
// (warehouse audit F3).
//
// Two things these handlers have to get right that the other warehouse ops
// did not have to think about:
//
//   1. bind_package REFUSES a second bind. It is `where status = 'blank'`,
//      and it raises when that matches nothing. So the ordinary lost-answer
//      case — the tag landed, the reply never came back, the write queued —
//      comes back around as an error for work that actually succeeded. If
//      that error is just rethrown it is not even classified as permanent, so
//      it burns eight retries and lands on the stuck-writes screen as a
//      failure a foreman can never clear by retrying.
//
//   2. move_container has no such guard: it writes a fresh "rode along" line
//      for every package inside, every time it is called. A resend after a
//      lost answer doubles a container's history.
//
// Both are answered the same way — look at what the server actually holds
// before deciding — so both get a test.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRetryableError, type OutboxEntry, type OutboxOp } from "./outbox-core";

const rpc = vi.fn();
/** One row read back by id, so a handler can ask "did this already land?" */
const readRow = vi.fn<(table: string, id: string) => { data: unknown; error: unknown }>();

vi.mock("../supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (table: string) => ({
      select: () => ({
        eq: (_column: string, value: string) => ({
          maybeSingle: async () => readRow(table, value),
        }),
      }),
    }),
  },
  supabaseConfigured: true,
}));

const { createShiftResolver, createSupabaseHandlers } = await import("./outboxHandlers");

const handlers = createSupabaseHandlers(createShiftResolver());

function entryFor(op: OutboxOp, payload: Record<string, unknown>): OutboxEntry {
  return {
    id: "outbox-entry-1",
    op,
    payload,
    createdAt: 0,
    attemptCount: 0,
    lastError: null,
    status: "queued",
    nextAttemptAt: 0,
  };
}

async function send(op: OutboxOp, payload: Record<string, unknown>): Promise<void> {
  const handler = handlers[op];
  if (!handler) throw new Error(`no ${op} handler is registered`);
  await handler(entryFor(op, payload), { getBlob: async () => null });
}

const TAG = {
  packageId: "pkg-1",
  projectId: "job-1",
  category: "windows",
  note: "cracked corner",
  marks: ["A1"],
  deliveryId: "del-1",
  partIndex: 2,
  partTotal: 3,
  partType: "frame",
  mfrMark: "16",
};

const TAG_RPC_ARGS = {
  p_package: "pkg-1",
  p_project: "job-1",
  p_category: "windows",
  p_note: "cracked corner",
  p_marks: ["A1"],
  p_delivery: "del-1",
  p_part_index: 2,
  p_part_total: 3,
  p_part_type: "frame",
  p_mfr_mark: "16",
};

const ALREADY_ASSIGNED =
  "that sticker is already assigned — a package ID never moves to another package";

/** The package row exactly as bind_package leaves it once THIS tag lands. */
const TAG_LANDED = {
  status: "received",
  project_id: "job-1",
  serial: "PKG-000123",
  category: "windows",
  note: "cracked corner",
  part_index: 2,
  part_total: 3,
  part_type: "frame",
  mfr_mark: "16",
  delivery_id: "del-1",
  // The marks the row really carries. Production always returns this join;
  // leaving it out of the fixture would have made a matching tag look like it
  // had lost a mark, which is the opposite of what this row is testing.
  package_marks: [{ mark_code: "A1" }],
};

/**
 * Answer each read by table AND id, because naming a refusal takes more than
 * one row: the sticker for its serial, and one or two jobs for their codes.
 * A row that isn't listed reads as "nothing there".
 */
function serverRows(rows: Record<string, unknown>): void {
  readRow.mockImplementation((table, id) => ({
    data: rows[`${table}:${id}`] ?? null,
    error: null,
  }));
}

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: { id: "pkg-1" }, error: null });
  readRow.mockReset();
  readRow.mockReturnValue({ data: null, error: null });
});

describe("a queued tag", () => {
  it("sends every field the sticker carried", async () => {
    await send("bind_package", TAG);
    expect(rpc).toHaveBeenCalledWith("bind_package", TAG_RPC_ARGS);
  });

  it("falls back to the old signature only when there is no part number to lose", async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function" },
    });
    await send("bind_package", { ...TAG, partIndex: null, partTotal: null, partType: null, mfrMark: null });
    expect(rpc).toHaveBeenLastCalledWith("bind_package", {
      p_package: "pkg-1",
      p_project: "job-1",
      p_category: "windows",
      p_note: "cracked corner",
      p_marks: ["A1"],
      p_delivery: "del-1",
    });
  });

  it("keeps a tag WITH a part number rather than silently shedding it", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function" },
    });
    await expect(send("bind_package", TAG)).rejects.toBeDefined();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  // The lost answer. The tag DID land; we never heard. bind_package refuses
  // the second one, and retrying can never make it succeed — so check the
  // sticker, and if it already names this job AND carries what this tag was
  // carrying, the work is done.
  it("counts a sticker already tagged to this job, with these details, as done", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error(ALREADY_ASSIGNED) });
    serverRows({ "packages:pkg-1": TAG_LANDED });
    await expect(send("bind_package", TAG)).resolves.toBeUndefined();
    expect(readRow).toHaveBeenCalledWith("packages", "pkg-1");
  });

  // The vanishing act, exactly as it happened. Two phones pick the same blank
  // sticker off the same delivery label, so every field they send is
  // identical — only one person also ticked mark A1. The other tag wins. The
  // first version of this compared fields only, found them all equal, and
  // deleted the entry with mark A1 gone and nothing said anywhere.
  it("names a mark the winning tag did not carry, even when every field matches", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error(ALREADY_ASSIGNED) });
    serverRows({ "packages:pkg-1": { ...TAG_LANDED, package_marks: [] } });
    await expect(send("bind_package", TAG)).rejects.toThrow("mark A1");
  });

  it("stays quiet when the winning tag carried the same mark", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error(ALREADY_ASSIGNED) });
    serverRows({ "packages:pkg-1": TAG_LANDED });
    await expect(send("bind_package", TAG)).resolves.toBeUndefined();
  });

  it("still resolves a bare tag that carried nothing to lose", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error(ALREADY_ASSIGNED) });
    serverRows({
      "packages:pkg-1": { status: "received", project_id: "job-1", serial: "PKG-000123" },
    });
    await expect(
      send("bind_package", { packageId: "pkg-1", projectId: "job-1" }),
    ).resolves.toBeUndefined();
  });

  // The tag landed, but a DIFFERENT tag did — two phones can pick the same
  // blank sticker for the same job, and the one that won may be the one
  // without the part number read off the label. This used to resolve flat, so
  // the marks, the note and "#16 2/3" vanished with no error anywhere. The
  // sticker is bound and cannot be bound again, so this is not a retry; it is
  // a report, naming every piece so a foreman can put it on by hand.
  it("reports the details a resent tag was carrying when the sticker lost them", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error(ALREADY_ASSIGNED) });
    serverRows({
      "packages:pkg-1": {
        status: "received",
        project_id: "job-1",
        serial: "PKG-000123",
        category: null,
        note: null,
        part_index: null,
        part_total: null,
        part_type: null,
        mfr_mark: null,
        delivery_id: null,
        package_marks: [],
      },
      "projects:job-1": { job_code: "BLACK22" },
    });
    const err = await send("bind_package", TAG).catch((e: unknown) => e);
    const msg = String((err as Error).message);
    expect(msg).toContain("Sticker PKG-000123");
    expect(msg).toContain("job BLACK22");
    expect(msg).toContain("the part number #16 2/3");
    expect(msg).toContain("which piece it is (frame)");
    expect(msg).toContain("what is inside (windows)");
    expect(msg).toContain("the note");
    expect(msg).toContain("mark A1");
    // Not a failed write: the sticker IS bound, and re-sending can never bind
    // it again. It stops here so a human sees it, and never retries.
    expect(isRetryableError(err)).toBe(false);
  });

  // The instruction has to be one a foreman can follow. Nothing in the app
  // edits a tagged package — bind_package writes these fields and only ever
  // `where status = 'blank'`, the tag screen offers blank stickers only, and
  // the package sheet is read-only apart from Reprint. So the line must not
  // send somebody to a screen that does not exist; it says what is actually
  // left to do, which is to put the detail on the physical package.
  it("does not send a foreman to a screen the app does not have", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error(ALREADY_ASSIGNED) });
    serverRows({
      "packages:pkg-1": {
        status: "received",
        project_id: "job-1",
        serial: "PKG-000123",
        category: "windows",
        note: "cracked corner",
        part_index: null,
        part_total: null,
        part_type: "frame",
        mfr_mark: null,
        delivery_id: "del-1",
      },
      "projects:job-1": { job_code: "BLACK22" },
    });
    const err = await send("bind_package", TAG).catch((e: unknown) => e);
    const msg = String((err as Error).message);
    expect(msg).toContain("the part number #16 2/3");
    expect(msg).not.toMatch(/open the package/i);
    expect(msg).toContain(
      "Nothing in the app can add them to a sticker that is already tagged",
    );
    expect(msg).toContain("write them on the package by hand");
  });

  it("says nothing about a note that only differs by spaces", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error(ALREADY_ASSIGNED) });
    serverRows({ "packages:pkg-1": TAG_LANDED });
    await expect(
      send("bind_package", { ...TAG, note: "  cracked corner  ", mfrMark: "16" }),
    ).resolves.toBeUndefined();
  });

  // Defect 2: this message is the ONLY thing a foreman gets. StuckWrites.tsx
  // renders the op label ("Package tagged"), the time, and this text — nothing
  // on that screen says which sticker or which job. "Put a fresh sticker on
  // the package" is not an instruction until it names the package.
  it("names the sticker and both jobs when the sticker went to a different job", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error(ALREADY_ASSIGNED) });
    serverRows({
      "packages:pkg-1": { status: "received", project_id: "job-9", serial: "PKG-000123" },
      "projects:job-9": { job_code: "PECAN14" },
      "projects:job-1": { job_code: "BLACK22" },
    });
    let thrown: unknown;
    await send("bind_package", TAG).catch((e) => {
      thrown = e;
    });
    const msg = String((thrown as Error).message);
    expect(msg).toContain("Sticker PKG-000123");
    expect(msg).toContain("already tagged to job PECAN14");
    expect(msg).toContain("this tag for job BLACK22");
    expect(msg).toMatch(/fresh sticker/);
    // Permanent: eight more tries cannot un-assign a sticker.
    expect(isRetryableError(thrown)).toBe(false);
  });

  // The jobs may be unreadable — the same dead connection that queued the tag
  // can eat the lookup. The sentence still has to read as English and still
  // has to name the sticker, which is the part a foreman scans.
  it("still names the sticker when the job codes cannot be read", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error(ALREADY_ASSIGNED) });
    serverRows({
      "packages:pkg-1": { status: "received", project_id: "job-9", serial: "PKG-000123" },
    });
    const err = await send("bind_package", TAG).catch((e: unknown) => e);
    const msg = String((err as Error).message);
    expect(msg).toContain("Sticker PKG-000123");
    expect(msg).toContain("a different job");
    expect(msg).not.toContain("job-9");
    expect(msg).not.toContain("undefined");
  });

  it("tries again later when it could not check the sticker at all", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error(ALREADY_ASSIGNED) });
    readRow.mockReturnValue({ data: null, error: new Error("Failed to fetch") });
    let thrown: unknown;
    await send("bind_package", TAG).catch((e) => {
      thrown = e;
    });
    // Unknown, so it must stay retryable — deciding either way on no evidence
    // is how a real tag gets thrown away or a wrong one gets called done.
    expect(isRetryableError(thrown)).toBe(true);
  });

  it("refuses a tag with no sticker or no job", async () => {
    await expect(send("bind_package", { projectId: "job-1" })).rejects.toThrow();
    await expect(send("bind_package", { packageId: "pkg-1" })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});

// F3 put set-aside on the queue, which handed it the exact race F2 had just
// closed for check-in: a queued set-aside can land minutes late, on top of
// something newer, and record a package on a job's bay while it is physically
// in a conex or on a truck. The queue does not preserve order across a failed
// entry either, so it can even replay AFTER a check-in for the same package.
//
// Closed the same way, deliberately not a second way: the phone's note travels
// with the write, the database compares it per package, and what no longer
// matches comes back named.
describe("a queued set-aside", () => {
  const NOTE = { a: { status: "received", container: null, location: null } };
  const STAGED = { staged: 1, job: "BLACK22", bay: "J-BLACK22-A", refused: [] };

  it("sends what the phone believed, not just where it was going", async () => {
    rpc.mockResolvedValue({ data: STAGED, error: null });
    await send("stage_packages", {
      packageIds: ["a", "b"],
      projectId: "job-1",
      expected: NOTE,
    });
    expect(rpc).toHaveBeenCalledWith("stage_packages", {
      p_packages: ["a", "b"],
      p_project: "job-1",
      p_expected: NOTE,
    });
  });

  it("stops for a human, naming the package and the job that beat it", async () => {
    rpc.mockResolvedValue({
      data: {
        staged: 0,
        job: "BLACK22",
        bay: "J-BLACK22-A",
        refused: [
          {
            id: "a",
            serial: "PKG-000123",
            status: "checked_out",
            container: null,
            location: null,
            job: "PECAN14",
          },
        ],
      },
      error: null,
    });
    await expect(
      send("stage_packages", { packageIds: ["a"], projectId: "job-1", expected: NOTE }),
    ).rejects.toThrow(
      "PKG-000123 did not go on BLACK22's shelf — it was checked out to PECAN14 first.",
    );
  });

  // The stale belief only a shelf can catch. Status is still 'stored' and the
  // container is still empty; the package has simply been set aside on ANOTHER
  // job's bay in the meantime. A status/container note would call that a match.
  it("names the other job's shelf when the package was staged elsewhere first", async () => {
    rpc.mockResolvedValue({
      data: {
        staged: 0,
        job: "BLACK22",
        bay: "J-BLACK22-A",
        refused: [
          {
            id: "a",
            serial: "PKG-000123",
            status: "stored",
            container: null,
            location: "J-PECAN14-A",
          },
        ],
      },
      error: null,
    });
    const err = await send("stage_packages", {
      packageIds: ["a"],
      projectId: "job-1",
      expected: NOTE,
    }).catch((e: unknown) => e);
    expect(String(err)).toContain("it is on shelf J-PECAN14-A now.");
    // Permanent: no amount of retrying takes it back off PECAN14's shelf.
    expect(isRetryableError(err)).toBe(false);
  });

  it("reports a PARTLY applied batch instead of reading as a clean success", async () => {
    rpc.mockResolvedValue({
      data: {
        staged: 2,
        job: "BLACK22",
        bay: "J-BLACK22-A",
        refused: [{ serial: "PKG-000999", status: "stored", container: "Conex 3" }],
      },
      error: null,
    });
    await expect(
      send("stage_packages", {
        packageIds: ["a", "b", "c"],
        projectId: "job-1",
        expected: NOTE,
      }),
    ).rejects.toThrow("PKG-000999 did not go on BLACK22's shelf — it is in Conex 3 now.");
  });

  it("lets a clean set-aside through untouched", async () => {
    rpc.mockResolvedValue({ data: STAGED, error: null });
    await expect(
      send("stage_packages", { packageIds: ["a"], projectId: "job-1", expected: NOTE }),
    ).resolves.toBeUndefined();
  });

  // The server refuses rather than dropping a job's material on a shared
  // shelf. Nothing about waiting fixes that, and the fix — add the bay — is
  // something only a person can do, so send it to the person on the first
  // try instead of eight tries later.
  it("parks a job with no staging bay for a human straight away", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "this job has no staging bay yet", hint: "no_staging_bay" },
    });
    let thrown: unknown;
    await send("stage_packages", {
      packageIds: ["a"],
      projectId: "job-1",
      expected: NOTE,
    }).catch((e) => {
      thrown = e;
    });
    expect(String((thrown as Error).message)).toMatch(/staging bay/);
    expect(isRetryableError(thrown)).toBe(false);
  });

  it("refuses a set-aside with no job or no packages", async () => {
    await expect(send("stage_packages", { packageIds: ["a"] })).rejects.toThrow();
    await expect(
      send("stage_packages", { packageIds: [], projectId: "job-1" }),
    ).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("a queued container move", () => {
  it("sends where the container was headed", async () => {
    readRow.mockReturnValue({
      data: { parent_container_id: null, location_id: "yard-1" },
      error: null,
    });
    await send("move_container", {
      containerId: "crate-1",
      parentContainerId: "conex-9",
      locationId: null,
    });
    expect(rpc).toHaveBeenCalledWith("move_container", {
      p_container: "crate-1",
      p_parent: "conex-9",
      p_location: null,
    });
  });

  // move_container writes a "rode along" line for every package inside it,
  // every time, with nothing to skip against. A resend after a lost answer
  // would say each package moved twice when it moved once.
  it("does not move a container that is already where it was sent", async () => {
    readRow.mockReturnValue({
      data: { parent_container_id: "conex-9", location_id: null },
      error: null,
    });
    await send("move_container", {
      containerId: "crate-1",
      parentContainerId: "conex-9",
      locationId: null,
    });
    expect(readRow).toHaveBeenCalledWith("storage_containers", "crate-1");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("still sends when it cannot see where the container is", async () => {
    readRow.mockReturnValue({ data: null, error: new Error("Failed to fetch") });
    await send("move_container", { containerId: "crate-1", parentContainerId: null, locationId: null });
    expect(rpc).toHaveBeenCalled();
  });

  it("refuses a move with no container", async () => {
    await expect(send("move_container", { parentContainerId: "conex-9" })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});

// The seam that has burned this repo twice: enqueue builds the payload, the
// handler reads it back, and nothing but a test holds the two field lists in
// step. A name typed differently on either side loses the write with no error.
//
// Every op gets one of these, not just the tag, because the three fail in
// three different ways and the quietest one is the worst. A renamed field on
// a set-aside dead-letters where a foreman can at least see it. A renamed
// field on a MOVE sends p_parent = null instead of the conex — so the
// container is recorded as taken out on its own, every package inside gets a
// "rode along" line, and nothing anywhere reports a problem. Reading the two
// field lists side by side is not proof; only the real store is.
//
// These go through the real enqueue → MemoryOutboxStore → serializeEntry →
// deserializeEntry → drain path, so they also stand as the check that each op
// is on the OPS allowlist: an op missing there deserializes to null and the
// rpc below is simply never called.
describe("every queued warehouse write survives the round trip", () => {
  it("a tag reaches the server with the same fields it was queued with", async () => {
    const { enqueueBindPackage } = await import("./outbox");
    await enqueueBindPackage(TAG);
    await vi.waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("bind_package", TAG_RPC_ARGS),
    );
  });

  it("a set-aside reaches the server with its packages, its job and its note", async () => {
    const { enqueueStagePackages } = await import("./outbox");
    const note = {
      "pkg-a": { status: "stored", container: "conex-3", location: null },
      "pkg-b": { status: "stored", container: null, location: "bay-pecan14" },
    };
    await enqueueStagePackages(["pkg-a", "pkg-b"], "job-1", note);
    await vi.waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("stage_packages", {
        p_packages: ["pkg-a", "pkg-b"],
        p_project: "job-1",
        p_expected: note,
      }),
    );
  });

  it("a move reaches the server still knowing where it was going", async () => {
    const { enqueueMoveContainer } = await import("./outbox");
    await enqueueMoveContainer({
      containerId: "crate-1",
      parentContainerId: "conex-9",
    });
    await vi.waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("move_container", {
        p_container: "crate-1",
        p_parent: "conex-9",
        p_location: null,
      }),
    );
  });
});

describe("a queued check-in that lost the race (F2)", () => {
  const NOTE = { "pkg-1": { status: "received", container: null } };

  it("sends what the phone believed, not just where it was going", async () => {
    rpc.mockResolvedValue({ data: { stored: 1, container: "Conex 7", refused: [] }, error: null });
    await send("store_packages", {
      packageIds: ["pkg-1"],
      containerId: "conex-7",
      expected: NOTE,
    });
    expect(rpc).toHaveBeenCalledWith("store_packages", {
      p_packages: ["pkg-1"],
      p_container: "conex-7",
      p_expected: NOTE,
    });
  });

  it("stops for a human, naming the package and the job that beat it", async () => {
    // The whole point of F2. Before this, the check-in went through, put the
    // package back in the conex an installer had already driven away from,
    // and the entry deleted itself. The refusal has to reach somebody.
    rpc.mockResolvedValue({
      data: {
        stored: 0,
        container: "Conex 7",
        refused: [
          { id: "pkg-1", serial: "PKG-000123", status: "checked_out", container: null, job: "BLACK22" },
        ],
      },
      error: null,
    });
    await expect(
      send("store_packages", { packageIds: ["pkg-1"], containerId: "conex-7", expected: NOTE }),
    ).rejects.toThrow("PKG-000123 did not go into Conex 7 — it was checked out to BLACK22 first.");
  });

  it("does not retry a refusal — no amount of trying brings the package back", async () => {
    rpc.mockResolvedValue({
      data: { stored: 0, container: "Conex 7", refused: [{ serial: "PKG-000123", status: "stored", container: "Conex 3" }] },
      error: null,
    });
    const err = await send("store_packages", {
      packageIds: ["pkg-1"],
      containerId: "conex-7",
      expected: NOTE,
    }).catch((e: unknown) => e);
    expect(isRetryableError(err)).toBe(false);
    expect(String(err)).toContain("it is in Conex 3 now.");
  });

  it("reports a PARTLY applied batch instead of reading as a clean success", async () => {
    // Three ticked, two went in. Resolving here would be the same bug wearing
    // a different coat: the write "worked" and nobody learns the third package
    // is somewhere else.
    rpc.mockResolvedValue({
      data: {
        stored: 2,
        container: "Conex 7",
        refused: [{ serial: "PKG-000999", status: "checked_out", job: "PECAN14" }],
      },
      error: null,
    });
    await expect(
      send("store_packages", {
        packageIds: ["pkg-1", "pkg-2", "pkg-3"],
        containerId: "conex-7",
        expected: NOTE,
      }),
    ).rejects.toThrow("PKG-000999");
  });

  it("says something a person can act on when four or more are refused", async () => {
    rpc.mockResolvedValue({
      data: {
        stored: 0,
        container: "Conex 7",
        refused: [1, 2, 3, 4, 5].map((n) => ({
          serial: `PKG-00000${n}`,
          status: "stored",
          container: "Conex 3",
        })),
      },
      error: null,
    });
    const err = await send("store_packages", {
      packageIds: ["a"],
      containerId: "conex-7",
      expected: NOTE,
    }).catch((e: unknown) => e);
    expect(String(err)).toContain("PKG-000001");
    expect(String(err)).toContain("And 2 more like it.");
  });

  it("lets a clean check-in through untouched", async () => {
    rpc.mockResolvedValue({ data: { stored: 2, container: "Conex 7", refused: [] }, error: null });
    await expect(
      send("store_packages", { packageIds: ["a", "b"], containerId: "conex-7", expected: NOTE }),
    ).resolves.toBeUndefined();
  });
});

describe("a queued area note (ticket 14)", () => {
  it("sends the package and the pointer", async () => {
    rpc.mockResolvedValue({ data: { id: "pkg-1" }, error: null });
    await send("set_package_area", { packageId: "pkg-1", area: "front" });
    expect(rpc).toHaveBeenCalledWith("set_package_area", {
      p_package: "pkg-1",
      p_area: "front",
    });
  });

  it("clearing is a legal value, not a missing one", async () => {
    rpc.mockResolvedValue({ data: { id: "pkg-1" }, error: null });
    await send("set_package_area", { packageId: "pkg-1", area: null });
    expect(rpc).toHaveBeenCalledWith("set_package_area", {
      p_package: "pkg-1",
      p_area: null,
    });
  });

  it("a pointer that went stale stops once, in plain words, instead of burning retries", async () => {
    // The package moved between queueing and sending. No resend changes that:
    // the pointer is stale by definition, and whoever is there next points
    // again. Eight retries of a hopeless write is how the queue clogs.
    rpc.mockResolvedValue({
      data: null,
      error: { message: "that area does not fit this kind of box" },
    });
    const err = await send("set_package_area", {
      packageId: "pkg-1",
      area: "north",
    }).catch((e: unknown) => e);
    expect(isRetryableError(err)).toBe(false);
    expect(String(err)).toContain("point at it again");
  });

  it("refuses an entry with no package", async () => {
    await expect(send("set_package_area", { area: "front" })).rejects.toThrow(
      "missing its package",
    );
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("a queued delivery confirmation (ticket 15)", () => {
  it("sends the packages that came off the truck", async () => {
    rpc.mockResolvedValue({ data: 2, error: null });
    await send("receive_minted", { packageIds: ["pkg-1", "pkg-2"] });
    expect(rpc).toHaveBeenCalledWith("receive_minted_packages", {
      p_packages: ["pkg-1", "pkg-2"],
    });
  });

  it("refuses an empty confirmation instead of sending a no-op forever", async () => {
    await expect(send("receive_minted", { packageIds: [] })).rejects.toThrow(
      "names no packages",
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an app ahead of its database stops on the first try, in words", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function" },
    });
    const err = await send("receive_minted", { packageIds: ["pkg-1"] }).catch(
      (e: unknown) => e,
    );
    expect(isRetryableError(err)).toBe(false);
    expect(String(err)).toContain("app update");
  });
});
