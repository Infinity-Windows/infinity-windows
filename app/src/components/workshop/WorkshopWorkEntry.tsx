// The approved workshop starting surface. Native paid setup is integrated
// through a qualified callback; never relabel the old setup as a paid start.
import { skipToken, useIsRestoring, useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { useClock } from "../../lib/clockContext";
import { todayTalkKey, useLocalDay, useTodayTalk, useToolboxToday } from "../../lib/useToolboxGate";
import type { SafetyTalk } from "../../lib/ops";
import { WorkshopStartScreen } from "./WorkshopStartScreen";
import { ClockQueueStatus } from "../clock/ClockQueueStatus";

const WorkingScreen = lazy(() => import("../../pages/work/WorkScreen").then(m => ({ default: m.WorkScreen })));

export function WorkshopWorkEntry() {
  const clock = useClock();
  const restoring = useIsRestoring();
  const talk = useTodayTalk();
  // Observe the shared request's error state, without starting a second read.
  const talkRequest = useQuery<SafetyTalk | null>({ queryKey: todayTalkKey(useLocalDay()), queryFn: skipToken });
  const signed = useToolboxToday(clock.profileId);
  // Preserve an existing shift, pending punch or needs-finish state. The
  // main build replaces WorkScreen with the selected-project activity view.
  const recovery = (clock.pending || clock.refused.length > 0) &&
    <aside className="page" aria-label="Saved clock changes"><ClockQueueStatus pending={clock.pending} refused={clock.refused} /></aside>;
  if (clock.shift) return <>{recovery}<Suspense fallback={<p role="status">…</p>}><WorkingScreen /></Suspense></>;
  return <>{recovery}<WorkshopStartScreen
    talk={talk.data ?? null}
    talkLoading={!talk.isSuccess && !talkRequest.isError}
    talkError={!talk.isSuccess && talkRequest.isError}
    signed={signed.isSuccess ? Boolean(signed.data) : null}
    clockKnown={Boolean(clock.profileId) && !clock.loading && !restoring}
  /></>;
}
