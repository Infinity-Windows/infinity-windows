// Runtime-agnostic authorization decisions for mutating the AI vault. Pure (no
// imports, no crypto, no I/O) so the Edge Function, the web client and the
// vitest suite share one source of truth for "who + what is required" to add,
// refresh, remove or approve notes.
//
// Two independent gates apply to every vault mutation:
//   1. Role gate  — only supervisor+ may manage the vault (unchanged rule).
//   2. PIN gate   — the owner-set shared PIN must be configured and supplied.
// Read/query access (Ask Infinity) is never gated here.

/**
 * Role rank mirroring app/src/lib/install/types.ts::roleRank so the server's
 * decision can never drift from the client's. Legacy names map the same way.
 */
export function vaultRoleRank(role?: string | null): number {
  switch (role) {
    case "owner":
    case "big_boss":
      return 3;
    case "supervisor":
    case "admin":
      return 2;
    case "foreman":
    case "lead":
      return 1;
    case "installer":
      return 0;
    default:
      return 0;
  }
}

/** Supervisor+ may manage (add/refresh/remove/approve) the vault. */
export function roleCanManageVault(role?: string | null): boolean {
  return vaultRoleRank(role) >= 2;
}

/** Only the owner may set or change the vault PIN. */
export function roleCanSetPin(role?: string | null): boolean {
  return vaultRoleRank(role) >= 3;
}

export type VaultGateReason =
  | "ok"
  | "role"
  | "pin-not-set"
  | "pin-missing";

export interface VaultGateInput {
  role?: string | null;
  /** Whether a vault PIN has been configured at all. */
  pinSet: boolean;
  /** Whether the caller supplied a (non-empty) PIN with this request. */
  pinProvided: boolean;
}

export interface VaultGateDecision {
  allowed: boolean;
  reason: VaultGateReason;
  message: string;
}

const MESSAGES: Record<VaultGateReason, string> = {
  ok: "",
  role: "Only supervisors and owners can manage the AI vault.",
  "pin-not-set":
    "No vault PIN is set yet. Ask an owner to set the vault PIN before adding notes.",
  "pin-missing": "Enter the vault PIN to continue.",
};

/**
 * The gating decision for any vault mutation. Role is checked first (a plain
 * installer is refused regardless of PIN), then that a PIN exists, then that
 * one was supplied. The function does NOT verify the PIN value — that requires
 * the stored hash and happens server-side.
 */
export function vaultMutationGate(input: VaultGateInput): VaultGateDecision {
  if (!roleCanManageVault(input.role)) {
    return { allowed: false, reason: "role", message: MESSAGES.role };
  }
  if (!input.pinSet) {
    return { allowed: false, reason: "pin-not-set", message: MESSAGES["pin-not-set"] };
  }
  if (!input.pinProvided) {
    return { allowed: false, reason: "pin-missing", message: MESSAGES["pin-missing"] };
  }
  return { allowed: true, reason: "ok", message: "" };
}
