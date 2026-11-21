import { useCallback, useState, type SetStateAction } from "react";

type Options = {
  /** Keep it for this tab's session only, not on the device. */
  session?: boolean;
  /** A saved value older than this is ignored. */
  maxAgeMs?: number;
};

function storeFor(options: Options) {
  return options.session ? sessionStorage : localStorage;
}

function readStored<T>(key: string, initial: T, options: Options): T {
  try {
    const raw = storeFor(options).getItem(key);
    if (!raw) return initial;
    const saved = JSON.parse(raw) as { at: number; value: T };
    if (options.maxAgeMs !== undefined && !(Date.now() - saved.at <= options.maxAgeMs)) return initial;
    return saved.value ?? initial;
  } catch {
    // Private mode, blocked storage or a damaged entry: behave as plain state.
    return initial;
  }
}

/**
 * useState that survives a reload. A phone reloads the app under a person
 * mid-task (an update, a dropped tab), and plain state forgets what they had
 * just chosen. Where storage is unavailable this is ordinary state.
 *
 * `key` names whose choice it is and for what (job, person, day); a new key
 * reads that key's own saved value.
 */
export function useStoredState<T>(key: string, initial: T, options: Options = {}) {
  const { session, maxAgeMs } = options;
  const [held, setHeld] = useState(() => ({ key, value: readStored(key, initial, { session, maxAgeMs }) }));
  let value = held.value;
  if (held.key !== key) {
    value = readStored(key, initial, { session, maxAgeMs });
    setHeld({ key, value });
  }
  const set = useCallback((next: SetStateAction<T>) => {
    setHeld(old => {
      const base = old.key === key ? old.value : readStored(key, old.value, { session, maxAgeMs });
      const changed = typeof next === "function" ? (next as (current: T) => T)(base) : next;
      try {
        const store = storeFor({ session });
        if (changed === undefined) store.removeItem(key);
        else store.setItem(key, JSON.stringify({ at: Date.now(), value: changed }));
      } catch {
        // Full or blocked storage: the choice still holds until the next reload.
      }
      return { key, value: changed };
    });
  }, [key, session, maxAgeMs]);
  return [value, set] as const;
}
