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
import { getOpenShift, type TimeShift } from "./timeclock";
import { subscribeSynced } from "./offline/outbox";
import { ClockSheet } from "../components/clock/ClockSheet";

/**
 * App-wide clock state. The clock is a bottom sheet that any surface can open
 * (the Time nav tab, a Home CTA, etc.) via `openClock()` or by dispatching the
 * `infinity:open-clock` window event. The open shift is queried once here and
 * shared, so the nav timer and the sheet always agree.
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

export function ClockProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);

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
  const closeClock = useCallback(() => setIsOpen(false), []);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["openShift", profileId] });
  }, [queryClient, profileId]);

  useEffect(() => {
    const onOpen = () => setIsOpen(true);
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
          onClose={closeClock}
          onChanged={refresh}
        />
      )}
    </ClockContext.Provider>
  );
}

export function useClock(): ClockContextValue {
  const ctx = useContext(ClockContext);
  if (!ctx) throw new Error("useClock must be used within ClockProvider");
  return ctx;
}

/** Fire-and-forget helper for surfaces outside the provider tree. */
export function openClockGlobally() {
  window.dispatchEvent(new Event(OPEN_CLOCK_EVENT));
}
