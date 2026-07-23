// Pure, runtime-agnostic UX-state helpers for the AI vault PIN gate. No
// imports or I/O so this unit-tests without pulling in the Supabase client
// (which can't initialise under the test runner's Node build). The Knowledge
// page uses these to decide, before any vault mutation, whether to send the
// user to the enter-PIN prompt or to the first-time "set a PIN" flow.

export type VaultPinPhase =
  | "unavailable" // the vault-PIN migration/RPC isn't applied yet
  | "needs-setup" // available, but no shared PIN has been created yet
  | "ready"; // a shared PIN exists — the enter-PIN gate applies

export interface VaultPinStatusInput {
  /** False when the migration/RPC isn't applied (treat as "no PIN"). */
  available: boolean;
  /** Whether a shared vault PIN has actually been configured. */
  pinSet: boolean;
}

/** The high-level state the Knowledge UI should reflect for the vault PIN. */
export function vaultPinPhase(input: VaultPinStatusInput): VaultPinPhase {
  if (!input.available) return "unavailable";
  if (!input.pinSet) return "needs-setup";
  return "ready";
}

/**
 * Why a vault mutation (add / refresh / remove / approve) can't proceed to the
 * enter-PIN prompt yet, as a plain-English sentence — or `null` when a PIN
 * exists and the normal enter-PIN gate should run. Owner-aware so a first-time
 * owner is pointed at the setup form instead of being told to "ask an owner"
 * (which, for the owner, is a dead-end).
 */
export function pinSetupBlockMessage(input: {
  available: boolean;
  pinSet: boolean;
  isOwner: boolean;
}): string | null {
  switch (vaultPinPhase(input)) {
    case "unavailable":
      return "The vault PIN needs a quick database update before notes can be added. Once that's applied, an owner can set the shared PIN here.";
    case "needs-setup":
      return input.isOwner
        ? "Set a vault PIN first — use the Vault PIN section above to create one, then you can add notes."
        : "No vault PIN is set yet. Ask an owner to set the vault PIN before adding notes.";
    case "ready":
      return null;
  }
}
