import { useLayoutEffect, useReducer, useRef, useSyncExternalStore } from "react";
import { signInGeneration, stillSignedInAs, subscribeSignedIn, type SignInMark } from "../signedIn";
import { useViewAsRole } from "../viewAsRoleContext";
import { uuid } from "../workConfiguration/model";
import { UnitReviewCoordinator, REVIEW_FRESH_MS, type ReviewCoordinatorDependencies, type ReviewHeld } from "./coordinator";
import { readReviewJournal } from "./storage";
import { parseUnitReviewPayload, type ReviewPayload } from "./protocol";

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
let environmentRevision = 0, pageHidden = false;
const foreground = () => typeof document !== "undefined" && document.visibilityState !== "hidden" && !pageHidden
  && typeof navigator !== "undefined" && navigator.onLine !== false;
const environmentListeners = new Set<() => void>();
const environmentChanged = () => { environmentRevision++; for (const listener of environmentListeners) listener(); };
const hidePage = () => { pageHidden = true; environmentChanged(); };
const showPage = () => { pageHidden = false; environmentChanged(); };
function subscribeEnvironment(listener: () => void) {
  if (!environmentListeners.size) {
    pageHidden = document.visibilityState === "hidden";
    window.addEventListener("online", environmentChanged); window.addEventListener("offline", environmentChanged);
    window.addEventListener("pagehide", hidePage); window.addEventListener("pageshow", showPage);
    document.addEventListener("visibilitychange", environmentChanged);
  }
  environmentListeners.add(listener);
  return () => {
    environmentListeners.delete(listener);
    if (!environmentListeners.size) {
      window.removeEventListener("online", environmentChanged); window.removeEventListener("offline", environmentChanged);
      window.removeEventListener("pagehide", hidePage); window.removeEventListener("pageshow", showPage);
      document.removeEventListener("visibilitychange", environmentChanged);
    }
  };
}
const environmentSnapshot = () => environmentRevision;
const emptySubscribe = () => () => {};
const missingPreview = () => -1;
const serverSnapshot = () => 0;
const blocked: ReviewHeld = { kind: "held", reason: "context_changed" };
interface Session {
  id: number; coordinator: UnitReviewCoordinator; current: () => boolean;
  busy: boolean; notice: string | null; armExpiry: (startedAt: number) => void;
  head: () => { commandId: string | null } | null; draftEpoch: number;
}
let nextSession = 0;

/** Owns the coordinator, never a second authoritative review read/cache. Only
 * scalar UI status is kept here; inspection is evaluated during every render. */
export function useUnitReviewCoordinator(source: UnitReviewSelectionSource, dependencies?: Partial<ReviewCoordinatorDependencies>) {
  const selected = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const viewAs = useViewAsRole(), preview = viewAs.sensitiveLifetime;
  const previewRevision = useSyncExternalStore(preview?.subscribe ?? emptySubscribe, preview?.getSnapshot ?? missingPreview, missingPreview);
  const authRevision = useSyncExternalStore(subscribeSignedIn, signInGeneration, serverSnapshot);
  const environment = useSyncExternalStore(subscribeEnvironment, environmentSnapshot, serverSnapshot);
  const active = useRef<Session | null>(null), [, repaint] = useReducer(n => n + 1, 0);
  // Treat dependency injection as a fixed construction seam. Production omits it.
  const injected = useRef(dependencies);
  useLayoutEffect(() => {
    let alive = true;
    const selection = selected.selection;
    const current = () => {
      try { return alive && source.getSnapshot() === selected && !!selection && !!preview
        && preview.getSnapshot() === previewRevision && preview.admitted(selection.login.userId!, selection.realRole)
        && environmentSnapshot() === environment && foreground() && stillSignedInAs(selection.login, selection.login.userId!)
        && selection.admitted(); }
      catch { return false; }
    };
    if (!selection || !current()) { active.current?.coordinator.dispose(); active.current = null; repaint(); return () => { alive = false; }; }
    // Observe only the head identity from the coordinator's SAME journal read.
    // This is not a second read or an exposure grant; hidden rows stay private.
    let head: { commandId: string | null } | null = null;
    const coordinator = new UnitReviewCoordinator({ login: selection.login, unitId: selection.selectedUnitId,
      contextKey: JSON.stringify([selection.selectedJobId, selection.selectedUnitId, selected.revision]), admission: current }, {
      ...injected.current,
      journal: async (login, unitId, admission) => {
        const rows = await (injected.current?.journal ?? readReviewJournal)(login, unitId, admission);
        if (admission()) head = { commandId: rows.at(-1)?.commandId ?? null };
        return rows;
      },
    });
    let timer: number | undefined;
    const armExpiry = (startedAt: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { if (current()) repaint(); }, Math.max(0, REVIEW_FRESH_MS - (performance.now() - startedAt)) + 1);
    };
    const session: Session = { id: ++nextSession, coordinator, current, busy: false, notice: null, armExpiry, head: () => head, draftEpoch: 0 };
    active.current = session; repaint();
    // Mount/re-entry recovers receipts only. No automatic delivery/cancellation.
    const startedAt = performance.now();
    void coordinator.refresh().then(result => { if (current() && active.current === session) {
      session.notice = result.kind === "held" ? result.reason : null; armExpiry(startedAt); repaint();
    } }).catch(() => { if (current() && active.current === session) {
      coordinator.invalidate(); session.notice = "unavailable"; repaint();
    } });
    return () => { alive = false; head = null; coordinator.dispose(); window.clearTimeout(timer); if (active.current === session) active.current = null; };
  }, [source, selected, preview, previewRevision, authRevision, environment]);
  const session = active.current;
  const valid = () => !!session && active.current === session && session.current();
  const inspection = valid() ? session!.coordinator.inspection() : blocked;
  const head = valid() ? session!.head() : null;
  const hasHiddenHead = inspection.kind === "ready" && (head === null
    || head.commandId !== null && !inspection.history.some(item => item.record.commandId === head.commandId));
  const run = async (operation: (coordinator: UnitReviewCoordinator) => Promise<{ kind: string; reason?: string }>, readOnly = false) => {
    if (!valid() || session!.busy) return;
    session!.busy = true; session!.notice = null; repaint();
    try {
      let startedAt = performance.now();
      const result = await operation(session!.coordinator);
      if (!valid()) return;
      session!.notice = result.kind === "held" ? result.reason ?? "unavailable" : result.kind;
      // Current acceptance comes only from this new read, never the result.
      if (!readOnly) { startedAt = performance.now(); await session!.coordinator.refresh(); }
      if (valid()) session!.armExpiry(startedAt);
    } catch { if (valid()) session!.notice = "unavailable"; }
    finally { if (valid()) { session!.busy = false; repaint(); } }
  };
  return {
    inspection, hasHiddenHead, draftEpoch: valid() ? session!.draftEpoch : 0,
    canReturnAsYourself: !!preview?.hasPreview() && !!viewAs.returnAsYourself,
    returnAsYourself: () => { viewAs.returnAsYourself?.(); },
    sessionId: valid() ? session!.id : null, login: valid() ? selected.selection!.login : null,
    busy: valid() && session!.busy, notice: valid() ? session!.notice : null,
    current: valid,
    refresh: () => run(coordinator => coordinator.refresh(), true),
    author: (raw: unknown) => {
      if (!valid() || session!.busy) return Promise.resolve();
      let payload: ReviewPayload;
      try { payload = parseUnitReviewPayload(raw); } catch { return Promise.resolve(); }
      const commandId = crypto.randomUUID();
      return run(async coordinator => {
        const saved = await coordinator.reserve(commandId, payload);
        if (!valid()) return blocked;
        // A duplicate saved UUID is not a second permission to send.
        if (saved.kind !== "saved") return saved;
        // Reset authoring even if an applied action leaves the same basis. The
        // exact saved decision remains in the journal, not an editable draft.
        session!.draftEpoch++;
        if (!saved.created) return saved;
        return coordinator.deliverOriginal(commandId);
      });
    },
    deliver: (commandId: string) => run(coordinator => coordinator.deliverOriginal(commandId)),
    cancel: () => run(coordinator => coordinator.cancelRetainedHead()),
  };
}
