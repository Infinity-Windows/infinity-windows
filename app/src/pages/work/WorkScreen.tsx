// Work — the new front door (crew redesign Release 1, K1.2, owner-approved
// 2026-09-23). One screen, one job: "clocked in? where? what's next?"
//
// Top to bottom, in the order the spec settled (Q2): the clock strip with
// its one big button (Start day, K1.3) → Today / Next up (the classic
// CrewStartBar, upgraded) → your unit (running, or Next up from plan
// openings and saved units, or a blank New unit only when nothing matches —
// K1.4) → heads-ups when there are any (K1.9) → four quick buttons → for
// leads, the Jobs row (K1.1) where Release 3's crew summary will sit. Items
// 1–3 fit a 375×667 screen above the bar without scrolling; the Playwright
// spec measures it.
//
// Every role lands here in the new design — installers, foremen, and the
// supervisors and owners who used to land on Heartbeat, which is one tap
// away as Overview and still in More (K1.1: "nothing is removed, only
// moved"). Every write goes through the same paths the classic screens use.
//
// Lazy, like every other screen that is not the classic shell: the entry
// chunk has a budget and this file's strings register themselves from its
// own chunk (lib/i18n/workCatalog.ts).

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClockStrip } from "../../components/work/ClockStrip";
import { HeadsUps } from "../../components/work/HeadsUps";
import { LeadRow } from "../../components/work/LeadRow";
import { QuickButtons } from "../../components/work/QuickButtons";
import { TodayCard } from "../../components/work/TodayCard";
import { YourUnit } from "../../components/work/YourUnit";
import { LiveSummonsStrip } from "../../components/install/LiveSummonsStrip";
import { useClock } from "../../lib/clockContext";
import { getCompanySettings } from "../../lib/companySettings";
import { useWork } from "../../lib/customWork/useWork";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import { getMyProfile, listMyOpeningsAllJobs, listOpenings } from "../../lib/install/api";
import { blockedUnits, listSessionsForOpenings } from "../../lib/install/sessions";
import { isForemanPlus } from "../../lib/install/types";
import { pendingPhotos, subscribe as subscribeOutbox } from "../../lib/offline/outbox";
import { getTodayTalk, listQcQueue } from "../../lib/ops";
import { paidTimeRuleActive } from "../../lib/paidTimeRule";
import { useSafeSurface } from "../../lib/pwa/useSafeSurface";
import { listMyPublished } from "../../lib/schedule/api";
import { addDaysISO } from "../../lib/schedule/dates";
import { isOnTheClock } from "../../lib/timeclock";
import { myTodayCompletion } from "../../lib/toolbox";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { headsUps } from "../../lib/work/headsUps";
import { chooseNextUp } from "../../lib/work/nextUp";
import { unitWorkLocked, type StartDayInput } from "../../lib/work/startDay";
import { pickTodayEntries } from "../../lib/work/today";
import "./work.css";

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The schedule window every Release 1 screen reads: today + 7 days (K1.6). */
export const SCHEDULE_WINDOW_DAYS = 7;

export function WorkScreen() {
  const t = useT();
  // The Work landing holds nothing unsaved of its own — every sheet on it
  // claims itself — so the automatic update may apply here (safeSurface.ts).
  useSafeSurface();
  const queryClient = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const clock = useClock();
  const shift = clock.shift;
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const profileId = me.data?.id ?? null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const today = todayLocalISO();
  const through = addDaysISO(today, SCHEDULE_WINDOW_DAYS);
  const schedule = useQuery({
    queryKey: ["workSchedule", profileId, today, through],
    queryFn: () => listMyPublished(profileId!, today, through),
    enabled: Boolean(profileId),
    refetchInterval: 60_000,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
  const pick = useMemo(
    () => pickTodayEntries(schedule.data ?? [], profileId ?? "", today, through),
    [schedule.data, profileId, today, through],
  );
  const todayJobId = pick.day === today ? (pick.entries.find((e) => e.project_id)?.project_id ?? null) : null;
  const jobId = shift?.project_id ?? todayJobId;
  const jobEntry = pick.entries.find((e) => e.project_id === jobId) ?? null;
  const jobLabel = shift?.projects
    ? `${shift.projects.job_code} · ${shift.projects.name}`
    : jobEntry?.project
      ? `${jobEntry.project.job_code} · ${jobEntry.project.name}`
      : null;

  // The morning gate: today's talk, whether it is signed, and the rule.
  const todayTalk = useQuery({ queryKey: ["todayTalk"], queryFn: getTodayTalk });
  const toolboxDone = useQuery({
    queryKey: ["toolboxToday", profileId],
    queryFn: () => myTodayCompletion(profileId!),
    enabled: Boolean(profileId),
  });
  const settings = useQuery({ queryKey: ["companySettings"], queryFn: getCompanySettings });
  const gate: StartDayInput = {
    talkExists: todayTalk.isSuccess ? todayTalk.data !== null : null,
    signedToday: toolboxDone.isSuccess ? Boolean(toolboxDone.data) : null,
    ruleActive: paidTimeRuleActive(settings.data, today),
  };
  const locked = unitWorkLocked(gate);

  // Units: my plan openings everywhere, the job's openings for "available",
  // session blocks so a blocked unit is never recommended, and custom work.
  const work = useWork();
  const myOpenings = useQuery({
    queryKey: ["myOpenings", profileId],
    queryFn: () => listMyOpeningsAllJobs(profileId!),
    enabled: Boolean(profileId),
  });
  const jobOpenings = useQuery({
    queryKey: ["openings", jobId],
    queryFn: () => listOpenings(jobId!),
    enabled: Boolean(jobId),
  });
  const openIds = useMemo(
    () => (myOpenings.data ?? []).filter((o) => o.status !== "installed").map((o) => o.id),
    [myOpenings.data],
  );
  const blockSessions = useQuery({
    queryKey: ["myOpeningBlocks", openIds.join(",")],
    queryFn: () => listSessionsForOpenings(openIds),
    enabled: openIds.length > 0,
  });
  const blockedIds = useMemo(
    () => new Set(blockedUnits(blockSessions.data ?? []).map((b) => b.openingId)),
    [blockSessions.data],
  );
  const nextUp = useMemo(
    () =>
      chooseNextUp({
        userId: profileId ?? "",
        now,
        jobId,
        myOpenings: myOpenings.data ?? [],
        jobOpenings: jobOpenings.data ?? [],
        blockedIds,
        units: work.units,
        sessions: work.sessions,
        active: work.active,
      }),
    // `now` ticks every second; the choice only moves on the minute-scale
    // facts (a stale start), so recompute on the units and sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profileId, jobId, myOpenings.data, jobOpenings.data, blockedIds, work.units, work.sessions, work.active],
  );

  // Heads-ups: the photo queue (re-read whenever the outbox changes) and, for
  // leads, the QC queue. Both degrade to nothing.
  const [photos, setPhotos] = useState<{ count: number; oldestAt: number | null }>({ count: 0, oldestAt: null });
  useEffect(() => {
    let live = true;
    const read = () => void pendingPhotos().then((p) => live && setPhotos(p)).catch(() => {});
    read();
    const off = subscribeOutbox(read);
    return () => {
      live = false;
      off();
    };
  }, []);
  const lead = isForemanPlus(effectiveRole);
  const qc = useQuery({
    queryKey: ["qcQueue", "work", 50],
    queryFn: () => listQcQueue(50),
    enabled: lead,
    staleTime: 60_000,
  });
  const notices = useMemo(
    () =>
      headsUps({
        now,
        assignments: schedule.data ?? [],
        unsentPhotoCount: photos.count,
        oldestUnsentPhotoAt: photos.oldestAt,
        onClock: isOnTheClock(shift),
        talkExists: gate.talkExists,
        signedToday: gate.signedToday,
        qcDueCount: lead ? (qc.data?.rows.length ?? 0) : 0,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [Math.floor(now / 60_000), schedule.data, photos, shift, gate.talkExists, gate.signedToday, lead, qc.data],
  );

  const onShiftChanged = () => {
    void queryClient.invalidateQueries({ queryKey: ["openShift"] });
    void queryClient.invalidateQueries({ queryKey: ["myShifts"] });
    void queryClient.invalidateQueries({ queryKey: ["recentJobs"] });
    clock.refresh();
  };

  if (!profileId) {
    return (
      <div className="page work-screen">
        <p className="ws-meta">{t("crewStart.loading")}</p>
      </div>
    );
  }

  const unitForProblem =
    nextUp.kind === "running" || nextUp.kind === "next"
      ? nextUp.source === "opening"
        ? { openingId: nextUp.opening.id, label: nextUp.opening.opening_code }
        : { openingId: nextUp.unit.opening_id, label: nextUp.unit.label }
      : null;

  return (
    <div className="page work-screen" data-testid="work-screen">
      <h1 className="ws-sr-only">{t("work.title")}</h1>
      <LiveSummonsStrip />
      <ClockStrip
        profileId={profileId}
        shift={shift}
        todayJobId={todayJobId}
        scheduleSettled={schedule.isSuccess || schedule.isError}
        talk={todayTalk.data ?? null}
        gate={gate}
        onShiftChanged={onShiftChanged}
      />
      <TodayCard
        meId={profileId}
        todayISO={today}
        pick={pick}
        query={{
          data: schedule.data,
          isError: schedule.isError,
          isPending: schedule.isPending,
          fetchStatus: schedule.fetchStatus,
          dataUpdatedAt: schedule.dataUpdatedAt,
        }}
        now={now}
      />
      <YourUnit nextUp={nextUp} locked={locked} jobId={jobId} shift={shift} work={work} now={now} />
      {/* Heads-ups sit under the three things the screen exists for, not
          between them: a notice above Today pushed your unit under the bar
          on a 667px phone. The one that matters most — the talk not signed —
          also has its own card right under the clock. */}
      <HeadsUps items={notices} />
      <QuickButtons
        role={effectiveRole}
        jobId={jobId}
        jobLabel={jobLabel}
        shift={shift}
        work={work}
        unit={unitForProblem}
        now={now}
      />
      {lead && <LeadRow role={effectiveRole} />}
    </div>
  );
}
