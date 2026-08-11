import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CheckCircle2, Plane, Truck } from "lucide-react";
import { EmptyState, QueryError, SkeletonList } from "../components/ui/States";
import { DirectionsButton } from "../components/maps/DirectionsButton";
import {
  findSpecsPlanset,
  getMyProfile,
  listMarkSpecs,
  listMemosToConfirm,
  listMyOpeningsAllJobs,
  listPlansets,
} from "../lib/install/api";
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
import { areaKey, toDispatchOpening } from "../lib/install/nextOpening";
import {
  isForemanPlus,
  type ProjectOpening,
} from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { getOpenShift } from "../lib/timeclock";
import { listMyPublished } from "../lib/schedule/api";
import { formatStartTime } from "../lib/schedule/dates";
import { listVehicleLinksForAssignments } from "../lib/vehicles/api";
import { vehicleTitle } from "../lib/vehicles/display";
import { listTrips } from "../lib/travel/api";

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function MyWork() {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole } = useEffectiveRole();
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
  const specIndexByProject = useMemo(() => {
    const m = new Map<string, Map<string, ProjectMarkSpec>>();
    projectIds.forEach((pid, i) => {
      m.set(pid, indexSpecsByMark(specQueries[i]?.data ?? []));
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIds, specQueries.map((q) => q.data)]);
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

  const plansetIds = projectIds
    .map((pid, i) => {
      const list = plansetQueries[i]?.data;
      return `${pid}:${(list && findSpecsPlanset(list)?.id) ?? ""}`;
    })
    .join(",");
  useEffect(() => {
    const cancels: (() => void)[] = [];
    projectIds.forEach((pid, i) => {
      const list = plansetQueries[i]?.data;
      const planset = list ? findSpecsPlanset(list) : null;
      const specs = myMarkSpecs.get(pid);
      if (!planset || !specs || specs.length === 0) return;
      cancels.push(schedulePrefetchMarkDrawings(planset, specs));
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
  const ordered = orderMyWork(active.map(toDispatchOpening))
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
  const next = queue[0];
  // Explicit first→last numbering over the do-order list, so every card/row can
  // show "you are here" (#1 is the Next card; #2, #3 … follow). Derived from the
  // shared orderMyWork result — orderMyWork itself is left untouched.
  const orderNumbers = orderNumberMap(queue.map((o) => o.id));
  const totalOrder = queue.length;
  const readyCount = active.filter((o) => openingReadiness(o).status === "ready").length;

  // Group the rest by job so a multi-job installer sees where work lives.
  const rest = queue.slice(1);
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
    const r = openingReadiness(o);
    if (r.status === "ready") return "Tap to install — photos, voice memo, grade";
    if (r.status === "blocked") return r.reasons.join(" ");
    return r.reasons[0] ?? "Finish checks before installing";
  };

  if (me.isLoading || (Boolean(me.data?.id) && openings.isLoading)) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="home-greeting">Your day</p>
            <h1>My work</h1>
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
            <p className="home-greeting">Your day</p>
            <h1>My work</h1>
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
          <p className="home-greeting">Your day</p>
          <h1>My work</h1>
        </div>
        {isForemanPlus(effectiveRole) && (
          <Link to="/training" className="button-like">
            Training
          </Link>
        )}
      </header>
      <p className="muted">
        {me.data?.display_name ? `${me.data.display_name} — ` : ""}do the top
        window next; capture as you go.
      </p>

      {todayAssignment && (
        <div className="today-strip home-card">
          <div className="home-card-top">
            <span className="next-label">Today</span>
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
            {!openShift.data && (
              <Link to="/clock" className="home-card-cta">
                Clock in for this job ›
              </Link>
            )}
          </div>
        </div>
      )}

      {newlyAssigned > 0 && (
        <div className="assign-toast" onClick={() => setNewlyAssigned(0)}>
          {newlyAssigned} new window{newlyAssigned > 1 ? "s" : ""} assigned to you — tap to dismiss
        </div>
      )}

      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-num">{active.length}</span>
          <span>assigned</span>
        </div>
        <div className="stat-card accent">
          <span className="stat-num">{readyCount}</span>
          <span>ready now</span>
        </div>
        <div className="stat-card">
          <span className="stat-num">{done.length}</span>
          <span>done today</span>
        </div>
      </div>

      {(toConfirm.data?.length ?? 0) > 0 && (
        <Link to="/review" className="action-btn">
          Review {toConfirm.data!.length} AI-filled memo(s) →
        </Link>
      )}

      {activeInstall && (
        <button
          className="next-card resume-card"
          onClick={() => go(activeInstall)}
        >
          <span className="next-label">Continue install</span>
          <span className="next-code">{activeInstall.opening_code}</span>
          <span className="next-meta">
            {activeInstall.window_types?.type_code ?? "type?"} ·{" "}
            {activeInstall.projects?.job_code ?? ""} · {areaKey(activeInstall)}
          </span>
          <span className="next-capture">
            You started this one — tap to finish and grade it.
          </span>
        </button>
      )}

      {!activeInstall && !next && (
        <EmptyState
          icon={<CheckCircle2 size={22} />}
          title="Nothing assigned right now"
          message="Check with your lead, or help stage the next windows."
          action={
            <Link to="/projects" className="button-like">
              Browse jobs
            </Link>
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
          <h2>Done today ({done.length})</h2>
          <ul className="unit-list work-list">
            {done.map((o) => (
              <li key={o.id} className="find-row">
                <strong>{o.opening_code}</strong>{" "}
                <span className="muted">{o.window_types?.type_code}</span>{" "}
                <span className="ok" style={{ marginLeft: "auto" }}>installed</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
