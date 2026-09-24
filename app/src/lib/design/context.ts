// The context and hook for the design switch. Kept apart from the provider
// component (DesignProvider.tsx) for the same reason i18n/context.ts is: a
// file exporting a component AND helpers trips the fast-refresh lint rule.

import { createContext, useContext } from "react";
import type { UiDesign } from "./design";

export interface DesignContextValue {
  /** The design the app renders right now (master switch already applied). */
  design: UiDesign;
  /** The person's own recorded choice, or null while the profile is loading. */
  choice: UiDesign | null;
  /** The owner's master switch for Release 1; null while unknown. */
  masterOn: boolean | null;
  /** Persist a new choice and apply it this instant, app-wide. */
  setChoice: (next: UiDesign) => void;
}

export const DesignContext = createContext<DesignContextValue | null>(null);

// Stable identity, for the same reason i18n's fallback is module-level: a
// fresh object per call would make every dependency array see a change.
const fallback: DesignContextValue = {
  design: "classic",
  choice: null,
  masterOn: null,
  setChoice: () => {},
};

/**
 * `const { design } = useDesign()`. Works with NO provider above it — a
 * component in a unit test renders the classic design rather than crashing,
 * which is exactly what every test written before the switch existed expects.
 */
export function useDesign(): DesignContextValue {
  return useContext(DesignContext) ?? fallback;
}
