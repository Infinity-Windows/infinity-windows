import { stillSignedInAs, type SignInMark } from "../signedIn";
import { uuid } from "../workConfiguration/model";

export const REVIEW_FRESH_MS = 30_000;

export interface UnitReviewSelection {
  login: SignInMark;
  realRole: string;
  selectedJobId: string;
  selectedUnitId: string;
  /** Fresh authorized unit-basis binding, never a label or URL inference. */
  binding: { unitId: string; projectId: string };
  /** Read live parent source freshness/authority at every await boundary. */
  admitted: () => boolean;
}
interface SelectionSnapshot { revision: number; selection: UnitReviewSelection | null }
export interface UnitReviewSelectionSource {
  getSnapshot: () => SelectionSnapshot;
  subscribe: (listener: () => void) => () => void;
}
/** The parent invalidates BEFORE navigation, selection, or source refresh. A
 * fresh binding may then open a new lifetime, even when the IDs are unchanged. */
export function createUnitReviewSelectionSource() {
  let snapshot: SelectionSnapshot = { revision: 0, selection: null };
  const listeners = new Set<() => void>();
  const publish = (selection: UnitReviewSelection | null) => {
    snapshot = { revision: snapshot.revision + 1, selection }; for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    invalidate: () => publish(null),
    select: (input: UnitReviewSelection) => {
      // Invalid input closes the old lifetime before validation can throw.
      publish(null);
      try {
        uuid(input.login.userId);
        const selectedJobId = uuid(input.selectedJobId).toLowerCase(), selectedUnitId = uuid(input.selectedUnitId).toLowerCase();
        const binding = { unitId: uuid(input.binding.unitId).toLowerCase(), projectId: uuid(input.binding.projectId).toLowerCase() };
        if (binding.unitId !== selectedUnitId || binding.projectId !== selectedJobId || !input.realRole.trim()
          || !input.login.userId || !stillSignedInAs(input.login, input.login.userId) || !input.admitted()) return;
        publish(Object.freeze({ ...input, selectedJobId, selectedUnitId, binding: Object.freeze(binding), login: Object.freeze({ ...input.login }) }));
      } catch { /* incomplete or stale source remains closed */ }
    },
  };
}
