import { describe, expect, it } from "vitest";
import { pinSetupBlockMessage, vaultPinPhase } from "./vaultPinUx";

describe("vaultPinPhase", () => {
  it("is 'unavailable' until the migration/RPC is applied", () => {
    expect(vaultPinPhase({ available: false, pinSet: false })).toBe("unavailable");
    // available:false wins even if a stale pinSet leaks through.
    expect(vaultPinPhase({ available: false, pinSet: true })).toBe("unavailable");
  });

  it("is 'needs-setup' when available but no PIN has been created", () => {
    expect(vaultPinPhase({ available: true, pinSet: false })).toBe("needs-setup");
  });

  it("is 'ready' once a PIN exists", () => {
    expect(vaultPinPhase({ available: true, pinSet: true })).toBe("ready");
  });
});

describe("pinSetupBlockMessage", () => {
  it("blocks with a DB-update note when the feature isn't available", () => {
    const msg = pinSetupBlockMessage({ available: false, pinSet: false, isOwner: true });
    expect(msg).toContain("database update");
  });

  it("points a first-time owner at the setup form (not 'ask an owner')", () => {
    const msg = pinSetupBlockMessage({ available: true, pinSet: false, isOwner: true });
    expect(msg).toBeTruthy();
    expect(msg).toContain("Set a vault PIN first");
    expect(msg?.toLowerCase()).not.toContain("ask an owner");
  });

  it("tells a non-owner to ask an owner when no PIN is set", () => {
    const msg = pinSetupBlockMessage({ available: true, pinSet: false, isOwner: false });
    expect(msg?.toLowerCase()).toContain("ask an owner");
  });

  it("returns null once a PIN exists so the normal enter-PIN gate runs", () => {
    expect(pinSetupBlockMessage({ available: true, pinSet: true, isOwner: true })).toBeNull();
    expect(pinSetupBlockMessage({ available: true, pinSet: true, isOwner: false })).toBeNull();
  });
});
