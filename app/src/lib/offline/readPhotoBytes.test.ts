import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPhotoBytes } from "./readPhotoBytes";

describe("saved photo reads", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("releases a stalled local read without consuming or deleting the saved blob", async () => {
    const blob = new Blob(["original"]);
    let finish!: (bytes: ArrayBuffer) => void;
    vi.spyOn(blob, "arrayBuffer").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = readPhotoBytes(blob, undefined, 100).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(101);
    expect((await pending as Error).message).toMatch(/local read timed out/);
    finish(new Uint8Array([1]).buffer);
    expect(await blob.text()).toBe("original");
  });

  it("does not return bytes after the send has been abandoned", async () => {
    const controller = new AbortController();
    const blob = new Blob(["original"]);
    let finish!: (bytes: ArrayBuffer) => void;
    vi.spyOn(blob, "arrayBuffer").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = readPhotoBytes(blob, controller.signal, 100).catch((error: unknown) => error);
    controller.abort();
    finish(new Uint8Array([1]).buffer);
    expect((await pending as Error).name).toBe("SendTookTooLongError");
  });
});
