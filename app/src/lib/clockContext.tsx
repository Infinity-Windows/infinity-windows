import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMyProfile } from "./install/api";
import { getOpenShift, type ClockInPick, type TimeShift } from "./timeclock";
import { subscribeSynced } from "./offline/outbox";
import { ClockSheet } from "../components/clock/ClockSheet";
import { FarFromJobPrompt } from "../components/clock/FarFromJobPrompt";

/**
 * App-wide clock state. The clock is a bottom sheet that any surface can open
 * (the Time nav tab, a Home CTA, etc.) via `openClock()` or by dispatching the
 * `infinity:open-clock` window event. The open shift is queried once here and
 * shared, so the nav timer and the sheet always agree.
 *
 * The event may carry a ClockInPick as its `detail` (2026-09-06): the landing
 * block hands its job / cost code / note / mode over when its own punch is
 * refused, and the sheet opens pre-filled instead of empty. A bare event —
 * every other opener — still means "open, and prime yourself as usual".
 */
interface ClockContextValue {
  profileId: string | null;
  shift: TimeShift | null;
  /** True while the open-shift query is still resolving on first load. */
  loading: boolean;
  isOpen: boolean;
  openClock: () => void;
  closeClock: () => void;
  refresh: () => void;
}

const ClockContext = createContext<ClockContextValue | null>(null);

export const OPEN_CLOCK_EVENT = "infinity:open-clock";

/** The event's detail when it is a pick; null for a bare open. */
function pickFromEvent(e: Event): ClockInPick | null {
  const d = (e as CustomEvent<unknown>).detail;
  return d && typeof d === "object" && "projectId" in d ? (d as ClockInPick) : null;
}

export function ClockProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  // What the sheet should open pre-filled with; cleared on close so a later
  // bare open (the nav tab, next morning) primes from the schedule again.
  const [initialPick, setInitialPick] = useState<ClockInPick | null>(null);

  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const profileId = me.data?.id ?? null;

  const shiftQuery = useQuery({
    queryKey: ["openShift", profileId],
    queryFn: () => getOpenShift(profileId!),
    enabled: Boolean(profileId),
    // Keep the nav timer honest if the tab was backgrounded through a punch.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const openClock = useCallback(() => setIsOpen(true), []);
  const closeClock = useCallback(() => {
    setIsOpen(false);
    setInitialPick(null);
  }, []);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["openShift", profileId] });
  }, [queryClient, profileId]);

  useEffect(() => {
    const onOpen = (e: Event) => {
      setInitialPick(pickFromEvent(e));
      setIsOpen(true);
    };
    window.addEventListener(OPEN_CLOCK_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CLOCK_EVENT, onOpen);
  }, []);

  // When the offline outbox syncs queued punches, refetch the real shift state
  // so any optimistic "pending" shift is replaced by the server's version.
  useEffect(
    () =>
      subscribeSynced(() => {
        void queryClient.invalidateQueries({ queryKey: ["openShift"] });
        void queryClient.invalidateQueries({ queryKey: ["myShifts"] });
        void queryClient.invalidateQueries({ queryKey: ["recentJobs"] });
      }),
    [queryClient],
  );

  const value = useMemo<ClockContextValue>(
    () => ({
      profileId,
      shift: shiftQuery.data ?? null,
      loading: Boolean(profileId) && shiftQuery.isLoading,
      isOpen,
      openClock,
      closeClock,
      refresh,
    }),
    [profileId, shiftQuery.data, shiftQuery.isLoading, isOpen, openClock, closeClock, refresh],
  );

  return (
    <ClockContext.Provider value={value}>
      {children}
      {isOpen && (
        <ClockSheet
          profileId={profileId}
          shift={shiftQuery.data ?? null}
          initialPick={initialPick}
          onClose={closeClock}
          onChanged={refresh}
        />
      )}
      {/* Wave K, K1/K3: rides every screen the same way the sheet does,
          because "you're 14 miles from the job" is worth asking wherever the
          person happens to be looking when they open the app. Renders nothing
          until it has something to ask. */}
      <FarFromJobPrompt shift={shiftQuery.data ?? null} onChanged={refresh} />
    </ClockContext.Provider>
  );
}

export function useClock(): ClockContextValue {
  const ctx = useContext(ClockContext);
  if (!ctx) throw new Error("useClock must be used within ClockProvider");
  return ctx;
}

/**
 * Fire-and-forget helper for surfaces outside the provider tree. Pass a pick
 * to open the sheet pre-filled (see ClockInPick); call bare to open it plain.
 * Always a CustomEvent, so a listener can read `detail` either way.
 */
export function openClockGlobally(detail?: ClockInPick) {
  window.dispatchEvent(new CustomEvent(OPEN_CLOCK_EVENT, { detail: detail ?? null }));
}
