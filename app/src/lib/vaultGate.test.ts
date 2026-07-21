import { describe, expect, it } from "vitest";
import {
  roleCanManageVault,
  roleCanSetPin,
  vaultMutationGate,
  vaultRoleRank,
} from "../../../supabase/functions/_shared/vaultGate";

describe("vaultRoleRank", () => {
  it("ranks roles and maps legacy names like the app's roleRank", () => {
    expect(vaultRoleRank("owner")).toBe(3);
    expect(vaultRoleRank("big_boss")).toBe(3);
    expect(vaultRoleRank("supervisor")).toBe(2);
    expect(vaultRoleRank("admin")).toBe(2);
    expect(vaultRoleRank("foreman")).toBe(1);
    expect(vaultRoleRank("lead")).toBe(1);
    expect(vaultRoleRank("installer")).toBe(0);
    expect(vaultRoleRank(null)).toBe(0);
    expect(vaultRoleRank("nonsense")).toBe(0);
  });
});

describe("role gates", () => {
  it("supervisor+ can manage the vault", () => {
    expect(roleCanManageVault("supervisor")).toBe(true);
    expect(roleCanManageVault("owner")).toBe(true);
    expect(roleCanManageVault("foreman")).toBe(false);
    expect(roleCanManageVault("installer")).toBe(false);
  });

  it("only owner can set the PIN", () => {
    expect(roleCanSetPin("owner")).toBe(true);
    expect(roleCanSetPin("supervisor")).toBe(false);
  });
});

describe("vaultMutationGate", () => {
  it("refuses a non-supervisor regardless of PIN", () => {
    const d = vaultMutationGate({ role: "foreman", pinSet: true, pinProvided: true });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("role");
  });

  it("refuses when no PIN is configured", () => {
    const d = vaultMutationGate({ role: "supervisor", pinSet: false, pinProvided: true });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("pin-not-set");
  });

  it("refuses when a PIN exists but none was supplied", () => {
    const d = vaultMutationGate({ role: "owner", pinSet: true, pinProvided: false });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("pin-missing");
  });

  it("allows a supervisor+ who supplies a PIN when one is set", () => {
    const d = vaultMutationGate({ role: "supervisor", pinSet: true, pinProvided: true });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("ok");
    expect(d.message).toBe("");
  });
});
