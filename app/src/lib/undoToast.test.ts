import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireUndo,
  pauseUndoToast,
  resumeUndoToast,
  showUndoToast,
  subscribeUndoToast,
  UNDO_TOAST_MS,
} from "./undoToast";
import { subscribeToasts } from "./toast";

// Every test drives its toast to completion (fired, or timed out) before
// finishing, so the module-level store starts each case with nothing
// pending — no reset hook needed for a store this small.

describe("undoToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a toast with the given message", () => {
    const seen: unknown[] = [];
    const unsub = subscribeUndoToast((s) => seen.push(s));
    showUndoToast({ message: "3 boxes checked in.", undo: async () => {} });
    expect(seen.at(-1)).toMatchObject({ message: "3 boxes checked in.", paused: false });
    unsub();
    void vi.advanceTimersByTimeAsync(UNDO_TOAST_MS);
  });

  it("fires the undo and closes the toast", async () => {
    const undo = vi.fn().mockResolvedValue(undefined);
    showUndoToast({ message: "Stored 2.", undo });
    await fireUndo();
    expect(undo).toHaveBeenCalledTimes(1);
    const seen: unknown[] = [];
    subscribeUndoToast((s) => seen.push(s))();
    expect(seen.at(-1)).toBeNull();
  });

  it("auto-dismisses at 5 seconds without running the undo", async () => {
    const undo = vi.fn().mockResolvedValue(undefined);
    showUndoToast({ message: "Checked in.", undo });
    await vi.advanceTimersByTimeAsync(UNDO_TOAST_MS + 1);
    expect(undo).not.toHaveBeenCalled();
    const seen: unknown[] = [];
    subscribeUndoToast((s) => seen.push(s))();
    expect(seen.at(-1)).toBeNull();
  });

  it("a replacement toast cancels the prior one's timer and undo", async () => {
    const firstUndo = vi.fn().mockResolvedValue(undefined);
    const secondUndo = vi.fn().mockResolvedValue(undefined);
    showUndoToast({ message: "First.", undo: firstUndo });
    await vi.advanceTimersByTimeAsync(UNDO_TOAST_MS - 500);
    showUndoToast({ message: "Second.", undo: secondUndo });

    // Past when the FIRST toast would have expired on its own — it must not
    // have fired anything, because the second call replaced it outright.
    await vi.advanceTimersByTimeAsync(600);
    expect(firstUndo).not.toHaveBeenCalled();

    const seen: unknown[] = [];
    const unsub = subscribeUndoToast((s) => seen.push(s));
    expect(seen.at(-1)).toMatchObject({ message: "Second." });
    unsub();

    await fireUndo();
    expect(secondUndo).toHaveBeenCalledTimes(1);
    expect(firstUndo).not.toHaveBeenCalled();
  });

  it("surfaces a failed undo through the ordinary error toast, formatted", async () => {
    const toasts: { message: string; kind: string }[] = [];
    const unsub = subscribeToasts((list) => {
      toasts.length = 0;
      toasts.push(...list);
    });
    showUndoToast({
      message: "Stored 1.",
      undo: async () => {
        throw new Error("permission denied for table packages");
      },
    });
    await fireUndo();
    expect(toasts.at(-1)?.kind).toBe("error");
    expect(toasts.at(-1)?.message).toContain("Couldn't undo — ");
    expect(toasts.at(-1)?.message).toContain("permission");
    unsub();
    await vi.advanceTimersByTimeAsync(5000);
  });

  it("pauses the countdown on hover/focus and resumes it", async () => {
    const undo = vi.fn().mockResolvedValue(undefined);
    showUndoToast({ message: "Checked in.", undo });
    await vi.advanceTimersByTimeAsync(UNDO_TOAST_MS - 200);
    pauseUndoToast();
    // Well past the original deadline — paused, so nothing fires.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(undo).not.toHaveBeenCalled();
    const seen: unknown[] = [];
    const unsub = subscribeUndoToast((s) => seen.push(s));
    expect(seen.at(-1)).toMatchObject({ paused: true });
    unsub();

    resumeUndoToast();
    // Only ~200ms were left when it paused.
    await vi.advanceTimersByTimeAsync(199);
    const stillSeen: unknown[] = [];
    subscribeUndoToast((s) => stillSeen.push(s))();
    expect(stillSeen.at(-1)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    const doneSeen: unknown[] = [];
    subscribeUndoToast((s) => doneSeen.push(s))();
    expect(doneSeen.at(-1)).toBeNull();
  });

  it("replacing a toast while paused still lands cleanly", async () => {
    showUndoToast({ message: "First.", undo: async () => {} });
    pauseUndoToast();
    const secondUndo = vi.fn().mockResolvedValue(undefined);
    showUndoToast({ message: "Second.", undo: secondUndo });
    await fireUndo();
    expect(secondUndo).toHaveBeenCalledTimes(1);
  });
});
