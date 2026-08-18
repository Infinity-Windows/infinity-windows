// The queued half of the supply-take guard — warehouse audit F1.
//
// The old handler sent a take with nothing on it that said "this is the same
// take you already have". So the outbox doing its job — retry until the
// server answers — was itself the bug: four tubes went out, the reply was
// lost, the entry came back around, and on hand dropped by eight with two
// honest-looking movement rows behind it.
//
// Two things have to hold forever after this:
//   1. the key the caller minted reaches the server on the queued send, and
//   2. an entry with no key is refused, not sent unguarded. Sending it would
//      be the original bug wearing a fix.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRetryableError, type OutboxEntry } from "./outbox-core";

const rpc = vi.fn();
vi.mock("../supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
  supabaseConfigured: true,
}));

const { createShiftResolver, createSupabaseHandlers } = await import("./outboxHandlers");

const KEY = "9b2f0c14-7d3a-4e51-8a06-3f2c9d1e4b77";

function entryFor(payload: Record<string, unknown>): OutboxEntry {
  return {
    id: "outbox-entry-1",
    op: "take_supply",
    payload,
    createdAt: 0,
    attemptCount: 0,
    lastError: null,
    status: "queued",
    nextAttemptAt: 0,
  };
}

const handlers = createSupabaseHandlers(createShiftResolver());

async function send(payload: Record<string, unknown>): Promise<void> {
  const handler = handlers.take_supply;
  if (!handler) throw new Error("no take_supply handler is registered");
  await handler(entryFor(payload), { getBlob: async () => null });
}

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: { id: "supply-1" }, error: null });
});

describe("the queued supply take", () => {
  it("sends the key the take was minted with", async () => {
    await send({ supplyId: "supply-1", projectId: "job-1", qty: 4, clientId: KEY });

    expect(rpc).toHaveBeenCalledWith("take_supply", {
      p_supply: "supply-1",
      p_project: "job-1",
      p_qty: 4,
      p_client_id: KEY,
    });
  });

  it("uses the key from the take, not the outbox entry's own id", async () => {
    // These differ on purpose. entry.id is born when the take is QUEUED, which
    // is one attempt too late: the live try that may already have subtracted
    // happened before this entry existed.
    await send({ supplyId: "supply-1", projectId: "job-1", qty: 4, clientId: KEY });

    const args = rpc.mock.calls[0][1] as { p_client_id: string };
    expect(args.p_client_id).toBe(KEY);
    expect(args.p_client_id).not.toBe("outbox-entry-1");
  });

  it("refuses a take with no key instead of sending it unguarded", async () => {
    await expect(
      send({ supplyId: "supply-1", projectId: "job-1", qty: 4 }),
    ).rejects.toThrow(/counting twice/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("parks an unkeyed take for a human rather than retrying it forever", async () => {
    let thrown: unknown;
    await send({ supplyId: "supply-1", projectId: "job-1", qty: 4 }).catch((e) => {
      thrown = e;
    });
    // Permanent → dead-letter → it shows up on the stuck-writes screen. A
    // retry would just fail the same way eight more times.
    expect(isRetryableError(thrown)).toBe(false);
  });

  it("still refuses a take that is missing what or how many", async () => {
    await expect(send({ projectId: "job-1", qty: 4, clientId: KEY })).rejects.toThrow();
    await expect(
      send({ supplyId: "supply-1", projectId: "job-1", qty: 0, clientId: KEY }),
    ).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes a server rejection straight through", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error("that supply is not in the catalog") });
    await expect(
      send({ supplyId: "gone", projectId: "job-1", qty: 1, clientId: KEY }),
    ).rejects.toThrow("that supply is not in the catalog");
  });
});

// The key has to cross one more seam: enqueueTakeSupply in outbox.ts builds
// the stored entry, and this file's handler reads it back out. Nothing in
// outbox.ts's types names clientId — it survives because that function spreads
// the whole input into the payload. This repo has already been burned twice by
// a value that was added to one list and dropped by the one actually read, so
// the seam gets a test rather than a promise.
describe("the key survives being queued", () => {
  it("reaches the server after a real trip through the outbox", async () => {
    const { enqueueTakeSupply } = await import("./outbox");

    await enqueueTakeSupply({
      supplyId: "supply-1",
      projectId: "job-1",
      qty: 4,
      clientId: KEY,
    } as Parameters<typeof enqueueTakeSupply>[0]);

    await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(rpc).toHaveBeenCalledWith("take_supply", {
      p_supply: "supply-1",
      p_project: "job-1",
      p_qty: 4,
      p_client_id: KEY,
    });
  });
});
