/** Resolves an offline clock-in entry id to the real server shift id. */
export interface ShiftResolver {
  record(clockInEntryId: string, shiftId: string, clockInAt?: string): void;
  clockInAt?(ref: string): string | null;
  resolve(ref: string): string | null;
}

const PENDING_PREFIX = "pending:";

/** Build a clock-out/break shiftRef that points at a not-yet-synced clock-in. */
export function pendingShiftRef(clockInEntryId: string): string {
  return `${PENDING_PREFIX}${clockInEntryId}`;
}

export function isPendingRef(ref: string): boolean {
  return ref.startsWith(PENDING_PREFIX);
}

/** Persisted resolver so an offline clock-in → clock-out chain survives reload. */
export function createShiftResolver(): ShiftResolver {
  const KEY = "wops-outbox-shift-map";
  const mem = new Map<string, string>();

  const load = (): Record<string, string> => {
    if (typeof localStorage === "undefined") return {};
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  };
  const save = (map: Record<string, string>) => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(KEY, JSON.stringify(map));
    } catch {
      /* quota — in-memory copy still works this session */
    }
  };

  return {
    record(clockInEntryId, shiftId, clockInAt) {
      mem.set(clockInEntryId, shiftId);
      const map = load();
      map[clockInEntryId] = shiftId;
      if (clockInAt) {
        const key = "clock-in-at:" + clockInEntryId;
        mem.set(key, clockInAt);
        map[key] = clockInAt;
      }
      save(map);
    },
    clockInAt(ref) {
      const key = "clock-in-at:" + ref.slice(PENDING_PREFIX.length);
      return mem.get(key) ?? load()[key] ?? null;
    },
    resolve(ref) {
      const id = ref.startsWith(PENDING_PREFIX) ? ref.slice(PENDING_PREFIX.length) : ref;
      return mem.get(id) ?? load()[id] ?? null;
    },
  };
}

export const clockShiftResolver = createShiftResolver();

