import { describe, expect, it, vi } from "vitest";
import { recordSyncReceipt, subscribeSyncReceipt } from "./syncReceipt";

describe("server-confirmed write receipt", () => {
  it("announces a confirmed write once with its owner; anonymous writes cannot claim another account's success", () => {
    const heard = vi.fn();
    const off = subscribeSyncReceipt(heard);
    try {
      recordSyncReceipt(null);
      expect(heard).not.toHaveBeenCalled();
      recordSyncReceipt("installer-1");
      expect(heard).toHaveBeenCalledOnce();
      expect(heard.mock.calls[0][0]).toMatchObject({ ownerId: "installer-1", savedAt: expect.any(Number) });
    } finally { off(); }
    recordSyncReceipt("installer-1");
    expect(heard).toHaveBeenCalledOnce();
  });
});
