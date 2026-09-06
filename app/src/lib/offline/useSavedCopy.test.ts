import { describe, expect, it } from "vitest";
import { isSavedCopy, savedCopyReason } from "./useSavedCopy";

const live = { data: [1], isError: false, fetchStatus: "idle" as const };

describe("saved-copy detection", () => {
  it("is quiet when the screen is live", () => {
    expect(isSavedCopy(live, true, false)).toBe(false);
    expect(savedCopyReason(live, true, false)).toBeNull();
  });
  it("says offline when there is no network or the refetch is paused", () => {
    expect(savedCopyReason(live, false, false)).toBe("offline");
    expect(savedCopyReason({ ...live, fetchStatus: "paused" }, true, false)).toBe("offline");
  });
  it("says weak when a request just timed out", () => {
    expect(savedCopyReason(live, true, true)).toBe("weak");
  });
  it("says failed when the refetch errored but data remains", () => {
    expect(savedCopyReason({ ...live, isError: true }, true, false)).toBe("failed");
  });
  it("never claims a saved copy when there is nothing saved", () => {
    expect(isSavedCopy({ data: undefined, isError: true, fetchStatus: "idle" }, false, true)).toBe(false);
    expect(isSavedCopy({ data: null, isError: false, fetchStatus: "paused" }, false, false)).toBe(false);
  });
});
