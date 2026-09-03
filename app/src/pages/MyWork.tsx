import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Plane, Truck } from "lucide-react";
import { EmptyState, QueryError, SkeletonList } from "../components/ui/States";
import { RoleMaps } from "../components/RoleMaps";
import { LiveSummonsStrip } from "../components/install/LiveSummonsStrip";
import { LogTodayChip } from "../components/dailyLogs/LogTodayChip";
import { DirectionsButton } from "../components/maps/DirectionsButton";
import {
  getMyProfile,
  listMarkSpecs,
  listMemosToConfirm,
  listMyOpeningsAllJobs,
  listPlansets,
  specsPlansetIds,
  undoInstall,
} from "../lib/install/api";
import { formatApiError } from "../lib/install/errors";
import { listMyFlashRuns } from "../lib/install/phases";
import {
  schedulePrefetchMarkDrawings,
} from "../lib/install/prefetchDrawings";
import {
  indexSpecsByMark,
  specForOpeningCode,
  type ProjectMarkSpec,
} from "../lib/install/specs";
import { SpecCard } from "../components/install/SpecCard";
import { useRealtimeMyOpenings } from "../lib/useRealtimeOpenings";
import { orderMyWork } from "../lib/dispatch";
import { orderNumberMap } from "../lib/install/mapDispatch";
import { openingReadiness } from "../lib/install/fit";
import { isInstallInProgress } from "../lib/install/installTimer";
import {
  applySessionBlocks,
  areaKey,
  toDispatchOpening,
} from "../lib/install/nextOpening";
import { blockedUnits, listSessionsForOpenings } from "../lib/install/sessions";
import {
  type ProjectOpening,
} from "../lib/install/types";
import { useClock } from "../lib/clockContext";
import { captureGeoSoft } from "../lib/geo";
import { clockIn, getOpenShift, listRecentJobs } from "../lib/timeclock";
import { listMyPublished } from "../lib/schedule/api";
import { formatStartTime } from "../lib/schedule/dates";
import { listVehicleLinksForAssignments } from "../lib/vehicles/api";
import { vehicleTitle } from "../lib/vehicles/display";
import { listTrips } from "../lib/travel/api";
import { useT } from "../lib/i18n";

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function MyWork() {
  const navigate = useNavigate();
  const t = useT();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const openings = useQuery({
    queryKey: ["myOpenings", me.data?.id],
    queryFn: () => listMyOpeningsAllJobs(me.data!.id),
    enabled: Boolean(me.data?.id),
  });
  const toConfirm = useQuery({
    queryKey: ["memosToConfirm", me.data?.id],
    queryFn: () => listMemosToConfirm(me.data!.id),
    enabled: Boolean(me.data?.id),
  });
  const todayISO = todayLocalISO();
  const openShift = useQuery({
    queryKey: ["openShift", me.data?.id],
    queryFn: () => getOpenShift(me.data!.id),
    enabled: Boolean(me.data?.id),
  });
  const todayPublished = useQuery({
    queryKey: ["mySchedule", me.data?.id, todayISO, todayISO],
    queryFn: () => listMyPublished(me.data!.id, todayISO, todayISO),
    enabled: Boolean(me.data?.id),
  });
  const myFlashRuns = useQuery({
    queryKey: ["myFlashRuns", me.data?.id],
    queryFn: () => listMyFlashRuns(me.data!.id),
    enabled: Boolean(me.data?.id),
  });
  // Same read-only helpers My Schedule uses, so the Today strip can show the
  // assigned truck and any travel for today's job.
  const todayAssignmentId = (todayPublished.data ?? [])[0]?.id ?? null;
  const todayVehicles = useQuery({
    queryKey: ["myScheduleVehicles", todayAssignmentId ? [todayAssignmentId] : []],
    queryFn: () => listVehicleLinksForAssignments([todayAssignmentId!]),
    enabled: Boolean(todayAssignmentId),
  });
  const trips = useQuery({
    queryKey: ["trips"],
    queryFn: listTrips,
    enabled: Boolean(todayAssignmentId),
  });
  useRealtimeMyOpenings(me.data?.id);
  const clock = useClock();

  // Live session-blocks (grilled Q4): a window whose newest session ended in
  // a Block is never recommended — it wears its reason in the list instead.
  const myOpeningIds = useMemo(
    () => (openings.data ?? []).filter((o) => o.status !== "installed").map((o) => o.id),
    [openings.data],
  );
  const blockSessions = useQuery({
    queryKey: ["myOpeningBlocks", myOpeningIds.join(",")],
    queryFn: () => listSessionsForOpenings(myOpeningIds),
    enabled: myOpeningIds.length > 0,
  });
  const blocks = useMemo(
    () => new Map(blockedUnits(blockSessions.data ?? []).map((b) => [b.openingId, b.reason])),
    [blockSessions.data],
  );
  const recents = useQuery({
    queryKey: ["recentJobs", me.data?.id],
    queryFn: () => listRecentJobs(me.data!.id),
    enabled: Boolean(me.data?.id),
  });

  // Un-submit: take back an install you just submitted, reason required.
  // Same undo path as the foreman's "send it back" — the server only lets an
  // installer void their OWN latest event, under 24 hours old.
  const [unsubmit, setUnsubmit] = useState<ProjectOpening | null>(null);
  const [unsubmitReason, setUnsubmitReason] = useState("");
  const [unsubmitError, setUnsubmitError] = useState<string | null>(null);
  const doUnsubmit = useMutation({
    mutationFn: (o: ProjectOpening) => undoInstall(o.id, unsubmitReason.trim()),
    onSuccess: () => {
      setUnsubmit(null);
      setUnsubmitReason("");
      setUnsubmitError(null);
      void openings.refetch();
    },
    onError: (e) => setUnsubmitError(formatApiError(e)),
  });

  const rows = openings.data ?? [];
  const active = rows.filter((o) => o.status !== "installed");
  const done = rows.filter((o) => o.status === "installed");

  // Rich per-mark specs for every job I have work on. One query per project;
  // best-effort, so a missing table just leaves specs hidden.
  const projectIds = useMemo(
    () => [...new Set((openings.data ?? []).map((o) => o.project_id))],
    [openings.data],
  );
  const specQueries = useQueries({
    queries: projectIds.map((pid) => ({
      queryKey: ["markSpecs", pid],
      queryFn: () => listMarkSpecs(pid),
      enabled: Boolean(pid),
    })),
  });
  // A `.map()` literal in a dep array is a new array every render, so React
  // never sees it as "unchanged" and this memo (and the prefetch effect that
  // keys off it below) reran on every render instead of only when a spec
  // query's data actually changed. Join the queries' own update timestamps
  // into one string instead — same trick `plansetIds` uses further down —
  // so the dep is a primitive that's only new when the data really is.
  const specDataUpdatedAt = specQueries.map((q) => q.dataUpdatedAt).join(",");
  const specIndexByProject = useMemo(() => {
    const m = new Map<string, Map<string, ProjectMarkSpec>>();
    projectIds.forEach((pid, i) => {
      m.set(pid, indexSpecsByMark(specQueries[i]?.data ?? []));
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIds, specDataUpdatedAt]);
  const specFor = (o: ProjectOpening): ProjectMarkSpec | null => {
    const idx = specIndexByProject.get(o.project_id);
    return idx ? specForOpeningCode(idx, o.opening_code) : null;
  };

  // Warm the elevation drawings for MY marks in the background. Tapping a window
  // on site otherwise waits on a ~2MB planset download to show one small
  // picture; doing it while the list sits idle makes the tap instant, and the
  // crops persist so it survives a reload or a dead zone. Same query key
  // MarkDrawing uses, so this costs no extra request.
  const plansetQueries = useQueries({
    queries: projectIds.map((pid) => ({
      queryKey: ["plansets", pid],
      queryFn: () => listPlansets(pid),
      enabled: Boolean(pid),
    })),
  });
  const myMarkSpecs = useMemo(() => {
    const byProject = new Map<string, ProjectMarkSpec[]>();
    for (const o of openings.data ?? []) {
      if (o.status === "installed") continue;
      const idx = specIndexByProject.get(o.project_id);
      const spec = idx ? specForOpeningCode(idx, o.opening_code) : null;
      if (!spec?.image_bbox) continue;
      const list = byProject.get(o.project_id) ?? [];
      if (!list.some((s) => s.mark_code === spec.mark_code)) list.push(spec);
      byProject.set(o.project_id, list);
    }
    return byProject;
  }, [openings.data, specIndexByProject]);

  // Every specs planset on the job, not just the newest: a job can hold the
  // supplier's cut sheet and an addendum at once, and the prefetch resolves
  // each mark's own file (Mad Moose, 2026-09-01).
  const plansetIds = projectIds
    .map((pid, i) => {
      const list = plansetQueries[i]?.data;
      return `${pid}:${(list ? specsPlansetIds(list) : []).join("|")}`;
    })
    .join(",");
  useEffect(() => {
    const cancels: (() => void)[] = [];
    projectIds.forEach((pid, i) => {
      const list = plansetQueries[i]?.data;
      const specs = myMarkSpecs.get(pid);
      if (!list || !specs || specs.length === 0) return;
      cancels.push(schedulePrefetchMarkDrawings(list, specs));
    });
    return () => cancels.forEach((c) => c());
    // Re-runs when my marks change or a job's specs planset resolves; the
    // planset query objects themselves change identity every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plansetIds, myMarkSpecs]);

  // Toast when a new window is assigned to me while I'm looking at the list.
  const [newlyAssigned, setNewlyAssigned] = useState(0);
  const prevActiveRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevActiveRef.current;
    if (prev !== null && active.length > prev) {
      setNewlyAssigned(active.length - prev);
    }
    prevActiveRef.current = active.length;
  }, [active.length]);

  const byId = new Map(active.map((o) => [o.id, o]));
  const ordered = orderMyWork(
    applySessionBlocks(active.map(toDispatchOpening), new Set(blocks.keys())),
  )
    .map((d) => byId.get(d.id)!)
    .filter(Boolean);
  // The core loop resumes what you started: an in-progress window jumps to the
  // top as "Continue", and "Next" becomes the following window so Done -> Next
  // stays one tap.
  const activeInstall = ordered.find((o) => isInstallInProgress(o));
  // Today's published assignment anchors the day: that job's openings sort first
  // (stable within orderMyWork) so My Work opens on where you're expected today.
  const todayAssignment = (todayPublished.data ?? [])[0] ?? null;
  const todayJobId = todayAssignment?.project_id ?? null;
  const todayVehicleLink = (todayVehicles.data ?? []).find((l) => l.vehicle);
  const todayTruck = todayVehicleLink?.vehicle
    ? vehicleTitle(todayVehicleLink.vehicle)
    : null;
  const todayTrip = todayJobId
    ? (trips.data ?? []).find((t) => t.project_id === todayJobId) ?? null
    : null;
  const baseQueue = activeInstall
    ? ordered.filter((o) => o.id !== activeInstall.id)
    : ordered;
  const queue = todayJobId
    ? [
        ...baseQueue.filter((o) => o.project_id === todayJobId),
        ...baseQueue.filter((o) => o.project_id !== todayJobId),
      ]
    : baseQueue;
  // The recommendation never points at a session-blocked window (grilled
  // Q4); blocked rows stay in the lists below wearing their reason.
  const next = queue.find((o) => !blocks.has(o.id));
  // Explicit first→last numbering over the do-order list, so every card/row can
  // show "you are here" (#1 is the Next card; #2, #3 … follow). Derived from the
  // shared orderMyWork result — orderMyWork itself is left untouched.
  const orderNumbers = orderNumberMap(queue.map((o) => o.id));
  const totalOrder = queue.length;
  // Blocked FIRST, same as the recommendation and the row tags do:
  // openingReadiness only knows physical fit, so without this the header can
  // read "2 ready now" while a row below it says "blocked — missing hardware".
  const readyCount = active.filter(
    (o) => !blocks.has(o.id) && openingReadiness(o).status === "ready",
  ).length;

  // Group the rest by job so a multi-job installer sees where work lives.
  //
  // Filter by the recommendation's IDENTITY, not its position. `next` searches
  // past blocked windows, so queue[0] is not always `next` — and slicing index
  // 0 then dropped that blocked window from the page entirely (not the Next
  // card, not the job list, not its reason) while showing `next` twice and
  // undercounting the job header. The comment above says blocked rows "stay in
  // the lists below wearing their reason"; this is what makes that true.
  const rest = next ? queue.filter((o) => o.id !== next.id) : queue;
  const jobs = new Map<string, { code: string; name: string; items: ProjectOpening[] }>();
  for (const o of rest) {
    const key = o.project_id;
    const g = jobs.get(key) ?? {
      code: o.projects?.job_code ?? "Job",
      name: o.projects?.name ?? "",
      items: [],
    };
    g.items.push(o);
    jobs.set(key, g);
  }

  const go = (o: ProjectOpening) =>
    navigate(`/projects/${o.project_id}/opening/${o.id}`);

  const readinessTag = (o: ProjectOpening) => {
    if (blocks.has(o.id)) {
      return (
        <span className="error">
          blocked{blocks.get(o.id) ? ` — ${blocks.get(o.id)}` : ""}
        </span>
      );
    }
    const r = openingReadiness(o);
    const inProgress = isInstallInProgress(o);
    const cls = inProgress
      ? "warn-text"
      : r.status === "ready"
        ? "ok"
        : r.status === "blocked"
          ? "error"
          : "warn-text";
    return <span className={cls}>{inProgress ? "in progress" : r.status}</span>;
  };

  const captureHint = (o: ProjectOpening) => {
    if (blocks.has(o.id))
      return `Waiting on: ${blocks.get(o.id) ?? "a blocker"} — pick it back up once it's cleared`;
    const r = openingReadiness(o);
    if (r.status === "ready") return t("mywork.tapToInstall");
    if (r.status === "blocked") return r.reasons.join(" ");
    return r.reasons[0] ?? "Finish checks before installing";
  };

  // ---- The morning hero (grilled Q1/Q3): off the clock, ONE tap clocks
  // you in and lands you on your window — its gates (toolbox, before
  // photo, flashing) still stand on the sheet. Clock-in itself is the
  // ungated part, so a refused start can never un-ring that bell.
  const flashRun = (myFlashRuns.data ?? [])[0] ?? null;
  const heroTarget = activeInstall ?? (flashRun ? null : next ?? null);
  const heroClockIn = useMutation({
    mutationFn: async () => {
      const projectId =
        heroTarget?.project_id ?? flashRun?.project_id ?? todayJobId ??
        recents.data?.[0]?.projectId ?? null;
      if (!projectId) throw new Error("no-project");
      const costCodeId =
        recents.data?.find((r) => r.projectId === projectId)?.costCodeId ??
        recents.data?.[0]?.costCodeId ?? null;
      const geo = await captureGeoSoft();
      await clockIn(projectId, costCodeId, geo, null);
    },
    onSuccess: () => {
      void openShift.refetch();
      if (heroTarget) go(heroTarget);
      else if (flashRun) navigate(`/projects/${flashRun.project_id}/flash-run`);
    },
    // Whatever went wrong (offline, no job to pin the punch to), the clock
    // sheet is the full-featured path — outbox, pickers, toolbox sign-off.
    onError: () => clock.openClock(),
  });

  if (me.isLoading || (Boolean(me.data?.id) && openings.isLoading)) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="home-greeting">{t("mywork.greeting")}</p>
            <h1>{t("mywork.title")}</h1>
          </div>
        </header>
        <SkeletonList rows={5} />
      </div>
    );
  }

  if (openings.isError) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="home-greeting">{t("mywork.greeting")}</p>
            <h1>{t("mywork.title")}</h1>
          </div>
        </header>
        <QueryError
          error={openings.error}
          onRetry={() => void openings.refetch()}
          label="Couldn't load your work"
        />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">{t("mywork.greeting")}</p>
          <h1>{t("mywork.title")}</h1>
        </div>
      </header>
      <LiveSummonsStrip />
      <LogTodayChip />
      <p className="muted">
        {me.data?.display_name ? `${me.data.display_name} — ` : ""}
        {t("mywork.hint")}
      </p>

      {/* THE MORNING HERO (grilled Q1): off the clock, the first thing on
          screen is one button that clocks you in and puts you on your
          window. The Today strip's facts fold in underneath. */}
      {!openShift.data && !openShift.isLoading && (
        <div className="today-strip home-card" style={{ borderColor: "var(--accent-line)" }}>
          <span className="next-label">{t("mywork.goodMorning")}</span>
          {(todayAssignment || heroTarget || flashRun) && (
            <p style={{ margin: "4px 0 2px", fontSize: 14.5 }}>
              <strong>
                {todayAssignment?.project?.name ??
                  heroTarget?.projects?.name ??
                  heroTarget?.projects?.job_code ??
                  flashRun?.projects?.name ??
                  "Your day"}
              </strong>
              {todayAssignment?.start_time && (
                <span className="muted"> · {formatStartTime(todayAssignment.start_time)}</span>
              )}
              {todayTruck && (
                <span className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 8 }}>
                  <Truck size={13} aria-hidden /> {todayTruck}
                </span>
              )}
            </p>
          )}
          <button
            className="primary big"
            style={{ width: "100%", marginTop: 8 }}
            disabled={heroClockIn.isPending}
            onClick={() => heroClockIn.mutate()}
          >
            {heroClockIn.isPending
              ? t("mywork.clockingIn")
              : activeInstall
                ? t("mywork.clockInFinish", { code: activeInstall.opening_code })
                : flashRun
                  ? t("mywork.clockInFlash", {
                      job: flashRun.projects?.job_code ?? t("mywork.yourJob"),
                    })
                  : next
                    ? t("mywork.clockInStart", { code: next.opening_code })
                    : t("mywork.clockIn")}
          </button>
          <div
            style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: 8 }}
          >
            {todayAssignment?.project?.address && (
              <DirectionsButton
                address={todayAssignment.project.address}
                title="Directions to today's job"
              />
            )}
            <button className="link" style={{ fontSize: 12.5 }} onClick={() => clock.openClock()}>
              {t("mywork.justClockIn")}
            </button>
          </div>
        </div>
      )}

      {Boolean(openShift.data) && todayAssignment && (
        <div className="today-strip home-card">
          <div className="home-card-top">
            <span className="next-label">{t("mywork.today")}</span>
            {todayAssignment.start_time && (
              <span className="muted" style={{ fontSize: 12 }}>
                {formatStartTime(todayAssignment.start_time)}
              </span>
            )}
          </div>
          <Link
            to={`/projects/${todayAssignment.project_id}`}
            style={{ display: "block", color: "inherit", textDecoration: "none" }}
          >
            <strong style={{ fontSize: 15 }}>
              {todayAssignment.project?.name ??
                todayAssignment.project?.job_code ??
                "Your job today"}
            </strong>
            {todayAssignment.project?.address && (
              <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                {todayAssignment.project.address}
              </p>
            )}
          </Link>
          {(todayTruck || todayTrip) && (
            <div
              className="muted"
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                marginTop: 6,
                fontSize: 12.5,
              }}
            >
              {todayTruck && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <Truck size={13} aria-hidden /> {todayTruck}
                </span>
              )}
              {todayTrip && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <Plane size={13} aria-hidden /> Travel: {todayTrip.destination || todayTrip.name}
                </span>
              )}
            </div>
          )}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 10,
              marginTop: 8,
            }}
          >
            <DirectionsButton
              address={todayAssignment.project?.address}
              title="Directions to today's job"
            />
          </div>
        </div>
      )}

      {newlyAssigned > 0 && (
        <div className="assign-toast" onClick={() => setNewlyAssigned(0)}>
          {newlyAssigned} new unit{newlyAssigned > 1 ? "s" : ""} assigned to you — tap to dismiss
        </div>
      )}

      {activeInstall && (
        <button
          className="next-card resume-card"
          onClick={() => go(activeInstall)}
        >
          <span className="next-label">{t("mywork.continueInstall")}</span>
          <span className="next-code">{activeInstall.opening_code}</span>
          <span className="next-meta">
            {activeInstall.window_types?.type_code ?? "type?"} ·{" "}
            {activeInstall.projects?.job_code ?? ""} · {areaKey(activeInstall)}
          </span>
          <span className="next-capture">
            {t("mywork.startedThisOne")}
          </span>
        </button>
      )}

      {!activeInstall && !next && active.length === 0 && (
        <EmptyState
          icon={<CheckCircle2 size={22} />}
          title={t("mywork.nothingAssigned.title")}
          message={t("mywork.nothingAssigned.msg")}
          action={
            <Link to="/projects" className="button-like">
              {t("mywork.browseJobs")}
            </Link>
          }
        />
      )}

      {/* PROPOSAL D (owner-approved): "next" only skips PAST blocked windows,
          it never disappears them — so !next here does not mean nothing is
          assigned. Before this, an installer with e.g. 3 windows all waiting
          on hardware saw the exact same "nothing assigned, browse jobs" card
          as someone with zero windows, while the stat grid below still said
          "3 assigned" and each reason was listed further down the page. That
          contradiction sent people off to another job instead of making the
          one call that clears the block. If we're here with active windows,
          every one of them is blocked (that's the only way `next` comes up
          empty) — so say that plainly and point at the fix, not "browse jobs". */}
      {!activeInstall && !next && active.length > 0 && (
        <EmptyState
          icon={<AlertTriangle size={22} />}
          title={
            active.length === 1
              ? "Your unit is waiting on something"
              : `All ${active.length} of your units are waiting on something`
          }
          message={
            active.length === 1
              ? "It can't start until the blocker clears — call your lead about it."
              : "None of these can start until the blockers clear — call your lead about the ones below."
          }
          action={
            <div style={{ display: "flex", flexDirection: "column", gap: 6, textAlign: "left" }}>
              {active.map((o) => (
                <div key={o.id} className="muted" style={{ fontSize: 12.5 }}>
                  <strong>{o.opening_code}</strong> — {blocks.get(o.id) ?? "a blocker"}
                </div>
              ))}
              <Link
                to={`/projects/${active[0].project_id}/opening/${active[0].id}`}
                className="button-like"
                style={{ marginTop: 4 }}
              >
                Open {active[0].opening_code} to flag it to your lead
              </Link>
            </div>
          }
        />
      )}

      {next && (
        <button className="next-card" onClick={() => go(next)}>
          <span className="next-label">
            Next · 1 of {totalOrder}
          </span>
          <span className="next-code">{next.opening_code}</span>
          <span className="next-meta">
            {next.window_types?.type_code ?? "type?"} ·{" "}
            {next.projects?.job_code ?? ""} · {areaKey(next)}
          </span>
          <span className="next-ready">{readinessTag(next)}</span>
          <span className="next-capture">{captureHint(next)}</span>
          {(() => {
            const s = specFor(next);
            return s ? (
              <SpecCard spec={s} projectId={next.project_id} compact />
            ) : null;
          })()}
        </button>
      )}

      {/* Stats + secondary tasks live BELOW the do-this-now cards (grilled
          Q1): the first screenful is clock in → your window, nothing else. */}
      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-num">{active.length}</span>
          <span>{t("mywork.stat.assigned")}</span>
        </div>
        <div className="stat-card accent">
          <span className="stat-num">{readyCount}</span>
          <span>{t("mywork.stat.readyNow")}</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{done.length}</span>
          <span>{t("mywork.stat.doneToday")}</span>
        </div>
      </div>

      {(toConfirm.data?.length ?? 0) > 0 && (
        <Link to="/review" className="action-btn">
          Review {toConfirm.data!.length} AI-filled memo(s) →
        </Link>
      )}

      {/* Flash runs I'm dispatched on (owner, 2026-08-14: the run is its
          own task) — one card per job, straight into the run screen. */}
      {(myFlashRuns.data ?? []).map((r) => (
        <Link
          key={r.id}
          to={`/projects/${r.project_id}/flash-run`}
          className="action-btn"
        >
          ⚡ Flash run — {r.projects?.job_code ?? "job"}
          {r.projects?.name ? ` · ${r.projects.name}` : ""}
        </Link>
      ))}

      {[...jobs.values()].map((job) => (
        <div key={job.code}>
          <h2>
            {job.code} <span className="muted">· {job.items.length} to go</span>
          </h2>
          <ul className="unit-list work-list">
            {job.items.map((o) => (
              <li
                key={o.id}
                className="find-row"
                onClick={() => go(o)}
                style={{ cursor: "pointer" }}
              >
                <span
                  className="order-badge"
                  aria-label={`Order number ${orderNumbers.get(o.id)} of ${totalOrder}`}
                >
                  #{orderNumbers.get(o.id)}
                </span>
                <div>
                  <strong>{o.opening_code}</strong>{" "}
                  <span className="muted">{o.window_types?.type_code}</span>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {areaKey(o)} · {captureHint(o)}
                  </div>
                  {(() => {
                    const s = specFor(o);
                    return s ? (
                      <SpecCard spec={s} projectId={o.project_id} compact />
                    ) : null;
                  })()}
                </div>
                <span style={{ marginLeft: "auto" }}>{readinessTag(o)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {done.length > 0 && (
        <>
          <h2>{t("mywork.doneTodayCount", { count: done.length })}</h2>
          <ul className="unit-list work-list">
            {done.map((o) => (
              <li key={o.id} className="find-row">
                <strong>{o.opening_code}</strong>{" "}
                <span className="muted">{o.window_types?.type_code}</span>{" "}
                <span className="ok" style={{ marginLeft: "auto" }}>{t("mywork.installed")}</span>
                <button
                  type="button"
                  className="button-like"
                  onClick={() => {
                    setUnsubmitReason("");
                    setUnsubmitError(null);
                    setUnsubmit(o);
                  }}
                >
                  {t("mywork.unsubmit")}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <RoleMaps />

      {unsubmit && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => setUnsubmit(null)}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: 0, fontWeight: 700 }}>
              Un-submit {unsubmit.opening_code}?
            </p>
            <p className="muted" style={{ margin: "6px 0 0" }}>
              The window goes back on your list and nothing is lost — photos,
              memo and time all stay on the record. Say why so the next person
              (maybe you) knows what still needs doing.
            </p>
            <label className="field-label">Why are you un-submitting?</label>
            <textarea
              rows={3}
              value={unsubmitReason}
              onChange={(e) => setUnsubmitReason(e.target.value)}
              placeholder="Forgot the shims on the left side…"
            />
            {unsubmitError && <p className="warn-text">{unsubmitError}</p>}
            <div className="row-gap" style={{ marginTop: 10 }}>
              <button
                className="button-like active-pill"
                disabled={!unsubmitReason.trim() || doUnsubmit.isPending}
                onClick={() => doUnsubmit.mutate(unsubmit)}
              >
                {doUnsubmit.isPending ? "Un-submitting…" : "Un-submit"}
              </button>
              <button className="button-like" onClick={() => setUnsubmit(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
