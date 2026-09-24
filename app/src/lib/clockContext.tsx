import { LunchReminder } from "../components/clock/LunchReminder";
import "../components/timeOff/timeOff.css";
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
import { type ClockInPick, type TimeShift } from "./timeclock";
import { subscribeClockSent, subscribeSynced } from "./offline/outbox";
import { ClockSheet } from "../components/clock/ClockSheet";
import { FarFromJobPrompt } from "../components/clock/FarFromJobPrompt";
import {
  confirmedOpenShift,
  type ClockActionKind,
  type QueuedClockAction,
  type RefusedClockAction,
} from "./clockQueueView";
import { useOpenShiftView } from "./useOpenShiftView";

/**
 * App-wide clock state. The clock is a bottom sheet that any surface can open
 * (the Time nav tab, a Home CTA, etc.) via `openClock()` or by dispatching the
 * `infinity:open-clock` window event. The open shift is read once here and
 * shared, so the nav timer and the sheet always agree.
 *
 * Since Release 0 (K0.1) `shift` is the server's shift WITH the phone's own
 * queued punches applied (useOpenShiftView): a clock-in tapped with no signal
 * is a shift here, from its tap time, until the server has it — so no screen
 * offers a second clock-in while the first is still on the phone. `pending`
 * says which punch is still on the phone and `refused` which ones the queue
 * gave up on, for the status line the clock screens draw.
 *
 * The event may carry a ClockInPick as its `detail` (2026-09-06): the landing
 * block hands its job / cost code / note / mode over when its own punch is
 * refused, and the sheet opens pre-filled instead of empty. A bare event —
 * every other opener — still means "open, and prime yourself as usual".
 */
interface ClockContextValue {
  profileId: string | null;
  shift: TimeShift | null;
  /**
   * True until the open-shift query has resolved on first load AND this
   * phone's own punch queue has been read — a relaunch must not show
   * "clock in" in the moment before its queued clock-in is known.
   */
  loading: boolean;
  pending: QueuedClockAction | null;
  refused: RefusedClockAction[];
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

  // Polls, to keep the nav timer honest if the tab was backgrounded through
  // a punch made elsewhere (a supervisor clocking the crew out).
  const view = useOpenShiftView(profileId, { poll: true });
  const shift = view.shift;

  // The moment a queued punch is confirmed, the row the server answered with
  // becomes the cached server shift. The queue entry is deleted right after,
  // and without this the merge would fall back to the LAST server read — the
  // empty one from before the punch — until the re-read below came back:
  // seconds of "off the clock" on a good link, and on a link that drops again
  // straight after the send, a clock-in button offered over a shift the server
  // already holds. The re-read still runs (subscribeSynced) and brings the
  // job and cost-code names the RPC's bare row does not carry.
  useEffect(
    () =>
      subscribeClockSent((entry, result) => {
        const next = confirmedOpenShift(entry.op as ClockActionKind, result);
        if (next === undefined) return;
        const owner = next?.profile_id ?? profileId;
        if (!owner) return;
        queryClient.setQueryData(["openShift", owner], next);
      }),
    [queryClient, profileId],
  );

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

  const loading = Boolean(profileId) && (view.query.isLoading || !view.ready);
  const value = useMemo<ClockContextValue>(
    () => ({
      profileId,
      shift,
      loading,
      pending: view.pending,
      refused: view.refused,
      isOpen,
      openClock,
      closeClock,
      refresh,
    }),
    [profileId, shift, loading, view.pending, view.refused, isOpen, openClock, closeClock, refresh],
  );

  return (
    <ClockContext.Provider value={value}>
      {children}
      <LunchReminder shift={shift} onOpen={openClock} />
      {isOpen && (
        <ClockSheet
          profileId={profileId}
          shift={shift}
          pending={view.pending}
          refused={view.refused}
          initialPick={initialPick}
          onClose={closeClock}
          onChanged={refresh}
        />
      )}
      {/* Wave K, K1/K3: rides every screen the same way the sheet does,
          because "you're 14 miles from the job" is worth asking wherever the
          person happens to be looking when they open the app. Renders nothing
          until it has something to ask. */}
      <FarFromJobPrompt shift={shift} onChanged={refresh} />
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
