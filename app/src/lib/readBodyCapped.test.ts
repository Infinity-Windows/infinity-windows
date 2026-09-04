import { describe, expect, it } from "vitest";
import { readBodyCapped } from "../../../supabase/functions/_shared/bytes.ts";

/**
 * THE CAP HAS TO HOLD BEFORE THE BYTES ARE IN MEMORY.
 *
 * The Monday pull used to do `res.arrayBuffer()` and check the length
 * afterwards, with one pre-check against the size Monday's metadata claimed.
 * That size is `number | null`, so a file Monday said nothing about had no
 * ceiling at all: the whole thing landed in an edge runtime and the limit was
 * applied to something already resident. At 80 MB that is close to the
 * runtime's own ceiling, and past it the failure was a bare 500 rather than the
 * plain sentence the design promises.
 *
 * These tests drive the ceiling with a real stream, one chunk at a time.
 */

/** A body that hands out `count` chunks of `size` bytes, like a download. */
function bodyOf(chunks: number[]): { body: ReadableStream<Uint8Array> | null } {
  let i = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunks[i]).fill(i + 1));
      i += 1;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    body: stream,
    wasCancelled: () => cancelled,
    chunksRead: () => i,
  };
}

describe("readBodyCapped", () => {
  it("returns the whole body when it fits", async () => {
    const got = await readBodyCapped(bodyOf([10, 10, 5]), 100);
    expect(got).not.toBeNull();
    expect(got!.byteLength).toBe(25);
    // Chunks are joined in order, not interleaved.
    expect(got![0]).toBe(1);
    expect(got![10]).toBe(2);
    expect(got![20]).toBe(3);
  });

  it("returns exactly the cap when the body is exactly the cap", async () => {
    const got = await readBodyCapped(bodyOf([50, 50]), 100);
    expect(got?.byteLength).toBe(100);
  });

  it("refuses the moment it goes one byte over", async () => {
    expect(await readBodyCapped(bodyOf([50, 51]), 100)).toBeNull();
  });

  it("stops reading rather than draining the rest of the download", async () => {
    // The point of the whole exercise: a 500 MB file must cost us the first
    // chunk past the cap, not 500 MB of memory.
    const src = bodyOf([60, 60, 60, 60, 60, 60, 60, 60, 60, 60]);
    expect(await readBodyCapped(src, 100)).toBeNull();
    expect(src.wasCancelled()).toBe(true);
    expect(src.chunksRead()).toBe(2);
  });

  it("treats a response with no body as empty, not as an error", async () => {
    const got = await readBodyCapped({ body: null }, 100);
    expect(got?.byteLength).toBe(0);
  });

  it("handles an empty body", async () => {
    expect((await readBodyCapped(bodyOf([]), 100))?.byteLength).toBe(0);
  });
});
