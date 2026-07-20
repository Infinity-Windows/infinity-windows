// Tiny external store for the onboarding wizard's open state, so any component
// (the Settings page, the Layout shell, the in-app Notifications page) can open
// it without prop-drilling or a context provider. Same pattern as toast.ts.

import { browserPermissionEnv, readNotificationStatus, readLocationStatus } from "./permissionEnv";
import { shouldAutoOpenWizard } from "./permissionCore";

type Listener = (open: boolean) => void;

const listeners = new Set<Listener>();
let open = false;

function emit() {
  for (const l of listeners) l(open);
}

export function openOnboardingWizard(): void {
  if (open) return;
  open = true;
  emit();
}

export function closeOnboardingWizard(): void {
  if (!open) return;
  open = false;
  emit();
}

export function getWizardOpen(): boolean {
  return open;
}

export function subscribeWizard(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

let autoOpenChecked = false;

/**
 * Decide (once per session) whether to auto-open the wizard on first run. Reads
 * live permission + persisted-choice state through the adapter, applies the pure
 * gate, and opens the wizard if warranted. Safe to call from an effect; it never
 * throws and only ever runs its check a single time.
 */
export async function maybeAutoOpenWizard(): Promise<void> {
  if (autoOpenChecked) return;
  autoOpenChecked = true;
  try {
    const [notifications, location] = await Promise.all([
      readNotificationStatus(browserPermissionEnv),
      readLocationStatus(browserPermissionEnv),
    ]);
    const shouldOpen = shouldAutoOpenWizard({
      wizardChoice: browserPermissionEnv.readWizardChoice(),
      notifications,
      location,
    });
    if (shouldOpen) openOnboardingWizard();
  } catch {
    // Never let permission probing block the app shell.
  }
}
