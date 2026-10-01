import { VoiceTextarea } from "../components/voice/VoiceTextarea";
import { BackChip } from "../components/BackChip";
import { SavedCopyNotice } from "../components/offline/SavedCopyNotice";
import { useSavedCopy } from "../lib/offline/useSavedCopy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  GripVertical,
  LayoutGrid,
  Phone,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Sheet } from "../components/ui/Sheet";
import {
  createProject,
  getProjectDeleteCounts,
  listProjects,
  listScopeCounts,
  setProjectModes,
  setProjectsOrder,
} from "../lib/api";
import { deleteJob } from "../lib/jobDeletion";
import { formatApiError } from "../lib/errors";
import { useT, useLanguage } from "../lib/i18n";
import "../lib/i18n/jobsCatalog";
import { JobModeBadge } from "../components/JobModeBadge";
import type { JobMode } from "../lib/types";
import { EmptyState, QueryError, SkeletonList } from "../components/ui/States";
import { getRealProfile } from "../lib/install/api";
import { isForemanPlus, isSupervisorPlus } from "../lib/install/types";
import { useUnreadCounts } from "../lib/chat/useUnreadCounts";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { buildDeleteConfirmMessage } from "../lib/projectTrash";
import { IncomingMondayJobs } from "../components/projects/IncomingMondayJobs";
import { ScopeLine } from "../components/projects/ScopeLine";
import { isTrackingOnly } from "../lib/jobModes";
import { PipelineLine } from "../components/projects/PipelineLine";
import { ReadinessBadge } from "../components/projects/ReadinessBadge";
import { gcCheckinsLatestKey, latestGcCheckins } from "../lib/gc";
import { needsCall, sortProjectsForList } from "../lib/pipeline";
import { MessagesSquare } from "lucide-react";
import type { Project } from "../lib/types";
import { listMyPublished } from "../lib/schedule/api";
import { addDaysISO } from "../lib/schedule/dates";
import { listRecentlyWorkedProjectIds } from "../lib/jobsListApi";
import {
  RECOMMENDATION_HORIZON_DAYS,
  filterJobsByView,
  groupJobsForList,
  matchesSearch,
  nextScheduledJob,
  nowClockLocal,
  scheduledProjectIds,
  sortJobsAlpha,
  type JobsViewFilter,
} from "../lib/jobsList";

type ModeChoice = "data" | "tracking" | "both";
const modesForChoice = (choice: ModeChoice): JobMode[] =>
  choice === "both" ? ["data", "tracking"] : [choice];

/** Today as a YYYY-MM-DD day string in the device's own timezone — what the
 * "Needs a call" chip counts days from, and what the schedule recommendation
 * calls "today". */
function todayLocal(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function Projects() {
  const t = useT();
  const { lang } = useLanguage();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [jobCode, setJobCode] = useState("");
  const [name, setName] = useState("");
  // Which modes the new job allows (standard-tracking-jobs slice 2). Data is the
  // default — every job today is a data job — so the common create is unchanged.
  const [modeChoice, setModeChoice] = useState<ModeChoice>("data");
  const [address, setAddress] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [unitNumber, setUnitNumber] = useState("");
  const [siteState, setSiteState] = useState("");
  // Wave X: how many storeys the building has. Optional — a job often gets
  // opened before anyone has been to site, and blank is an honest answer.
  const [stories, setStories] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [notes, setNotes] = useState("");
  // Wave J (J1): the full New project form defaults READY, and only this form
  // does. Somebody is filling it in by hand, so they know. A job that arrives
  // instead — imported from Monday, built in one tap from the clock-in — is
  // born Not ready with nobody asked.
  const [readyState, setReadyState] = useState<"ready" | "not_ready">("ready");
  const [message, setMessage] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const savedCopy = useSavedCopy(projects, "jobs");
  const unread = useUnreadCounts();
  // The REAL signed-in person, not the previewed one (getMyProfile): "Next on
  // your schedule" and "Recently worked" are about who is actually looking at
  // the phone, and a supervisor previewing "installer" must not see a random
  // installer's schedule stitched onto their own list. Same query key
  // useEffectiveRole already reads internally, so this is not a second fetch.
  const me = useQuery({ queryKey: ["myRealProfile"], queryFn: getRealProfile });
  const { effectiveRole } = useEffectiveRole();
  const canAdd = isForemanPlus(effectiveRole);
  // Deleting a job is supervisor+ now (slice 5) — was owner-only. The server
  // enforces the same rank in trash_project; this gates the affordance.
  const canDelete = isSupervisorPlus(effectiveRole);
  // Wave X: one grouped row per job, counted in the database
  // (project_scope_counts). This used to pull EVERY opening row for every job
  // with no limit and count them here — the "deferred on purpose" note that sat
  // on it for a year said the real fix was a server-side aggregate. This is it.
  const counts = useQuery({ queryKey: ["scopeCounts"], queryFn: listScopeCounts });
  // Wave H (H1): the fourth reason a job needs a call — nobody has talked to
  // its builder in a fortnight. ONE query for the whole page rather than one
  // per card, for the same reason wave X stopped counting openings here: this
  // list is read on a phone in a driveway. `known` is what keeps a database
  // that is behind the migration from lighting a chip on every job.
  const checkins = useQuery({
    queryKey: gcCheckinsLatestKey,
    queryFn: latestGcCheckins,
  });

  // ---- Jobs search & schedule recommendation (less scrolling on /projects) --
  // A page left open through the end of a slot or midnight must advance.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const today = todayLocal(now);
  // Six weeks, inclusive of today — the same bound nextScheduledJob enforces
  // itself, kept here too so the query never ASKS the server for more than
  // the recommendation is willing to claim it knows.
  const scheduleTo = useMemo(() => addDaysISO(today, RECOMMENDATION_HORIZON_DAYS), [today]);
  const myId = me.data?.id;
  const schedule = useQuery({
    queryKey: ["mySchedule", myId, today, scheduleTo],
    queryFn: () => listMyPublished(myId!, today, scheduleTo),
    enabled: Boolean(myId),
    refetchInterval: 60_000,
  });
  const recentWork = useQuery({
    queryKey: ["recentlyWorkedJobs", myId],
    queryFn: () => listRecentlyWorkedProjectIds(myId!),
    enabled: Boolean(myId),
  });

  const [query, setQuery] = useState("");
  const [view, setView] = useState<JobsViewFilter>("all");
  const searching = query.trim().length > 0;

  // ---- J2: the order the office puts the jobs in --------------------------
  // The list on screen is the server's order until a foreman moves something,
  // and then it is `pending` until the save comes back. Holding an optimistic
  // copy rather than re-fetching is what makes "move up" feel like moving one
  // card instead of the whole list blinking; the refetch after the save is
  // what proves the server agreed.
  const [pending, setPending] = useState<Project[] | null>(null);
  const serverRows = useMemo(
    () => sortProjectsForList(projects.data ?? []),
    [projects.data],
  );
  // A refetch that brings a genuinely different list (a job created, deleted or
  // reordered elsewhere) drops the optimistic copy: what the server says is the
  // list, and a stale local order quietly hiding a new job would be worse than
  // a blink.
  useEffect(() => {
    setPending((current) => {
      if (!current) return null;
      const same =
        current.length === serverRows.length &&
        current.every((row) => serverRows.some((s) => s.id === row.id));
      return same ? current : null;
    });
  }, [serverRows]);
  const rows = pending ?? serverRows;
  const canOrder = isForemanPlus(effectiveRole);
  // Office order is foreman+'s explicit choice now (owner ask: the grip and
  // the reserved rail column used to show for every foreman on every load,
  // which is the thing this page exists to give back the room for). Search
  // and manual reorder never mix: entering this mode always works the FULL,
  // unsearched, unsorted-by-group `rows` array above, by its own indices, so
  // a save can never persist an order that was really just a filtered view.
  const [officeOrderMode, setOfficeOrderMode] = useState(false);
  const showOfficeOrder = officeOrderMode && canOrder;
  // Phone-only: History and Office order live behind this sheet instead of
  // their own always-visible toolbar row (owner ask, Horizon borrowing —
  // less chrome on a card list read on a phone). Desktop keeps them inline
  // (`.jobs-desktop-tools`, CSS-only at 860px) — same controls, same state,
  // two renders so neither width hides the other's affordance.
  const [filtersOpen, setFiltersOpen] = useState(false);

  const saveOrder = useMutation({
    mutationFn: (ids: string[]) => setProjectsOrder(ids),
    onSuccess: async () => {
      setMessage(t("pipeline.order.saved"));
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await queryClient.invalidateQueries({ queryKey: ["projectsAll"] });
    },
    onError: (e) => {
      // Put the server's order back: a list that keeps showing an order the
      // database refused is a list that lies on the next reload.
      setPending(null);
      setMessage(formatApiError(e));
    },
  });

  /** Move the job at `from` to `to`, then save the WHOLE list's new order. */
  const moveTo = (from: number, to: number) => {
    if (!showOfficeOrder || searching || saveOrder.isPending || from === to || to < 0 || to >= rows.length) return;
    const next = [...rows];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setPending(next);
    saveOrder.mutate(next.map((p) => p.id));
  };

  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const addProject = useMutation({
    mutationFn: async () => {
      const project = await createProject({
        jobCode,
        name,
        address,
        customerName,
        contactPhone,
        contactEmail,
        unitNumber,
        siteState,
        stories: stories.trim() === "" ? null : Number(stories),
        startDate,
        endDate,
        notes,
        readyState,
      });
      const modes = modesForChoice(modeChoice);
      // The column already defaults to data-only, so only spend the extra RPC
      // when the job allows something other than plain data.
      if (!(modes.length === 1 && modes[0] === "data")) {
        await setProjectModes(project.id, modes);
      }
      return project;
    },
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      setAdding(false);
      setJobCode("");
      setName("");
      setAddress("");
      setCustomerName("");
      setContactPhone("");
      setContactEmail("");
      setUnitNumber("");
      setSiteState("");
      setStories("");
      setStartDate("");
      setEndDate("");
      setNotes("");
      setReadyState("ready");
      // A tracking-only job has no plans to extract, so land it on its hub
      // rather than the planset upload; data (and both-mode) jobs keep the
      // straight-to-PDFs flow they had.
      const wasTrackingOnly = modeChoice === "tracking";
      setModeChoice("data");
      navigate(wasTrackingOnly ? `/projects/${project.id}` : `/projects/${project.id}/upload`);
    },
  });

  const countFor = (projectId: string) => {
    const row = counts.data?.[projectId];
    const total = row?.openings ?? 0;
    const installed = row?.installed ?? 0;
    const pct = total > 0 ? Math.round((installed / total) * 100) : 0;
    return { row, total, installed, pct };
  };

  const trash = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      deleteJob(id, reason),
    onSuccess: () => {
      setMessage(t("deljob.deleted"));
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["projectsAll"] });
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  // Async on purpose: the confirm dialog states the real cost in numbers
  // (owner ask), which means fetching cheap head-counts BEFORE the prompt can
  // show them. One prompt does both jobs — states the cost AND takes the
  // required reason (slice 5): every supervisor is told why, so a blank one is
  // refused here and again server-side.
  const handleDeleteClick = async (p: Project) => {
    setMessage(null);
    setDeletingId(p.id);
    try {
      const deleteCounts = await getProjectDeleteCounts(p.id);
      // The confirm text is built in the crew's language: the count words and
      // sentence come from the catalog (tracking-jobs slice 7, 2026-09-03).
      const reason = window.prompt(
        `${buildDeleteConfirmMessage(p.job_code, deleteCounts, {
          opening: t("deljob.word.opening"),
          package: t("deljob.word.package"),
          photo: t("deljob.word.photo"),
          template: t("deljob.confirmTemplate"),
        })}\n\n${t("deljob.why")}`,
      );
      if (reason && reason.trim()) trash.mutate({ id: p.id, reason: reason.trim() });
    } catch (e) {
      setMessage(formatApiError(e));
    } finally {
      setDeletingId(null);
    }
  };

  // ---- Scheduled / recently-worked ids, and the one highlighted job --------
  // Both default to an EMPTY set on error rather than throwing — a jobs list
  // that cannot check the schedule still has to show every job, alphabetized,
  // searchable. That is also what makes "Other jobs" the honest fallback
  // group: everything just lands there when either source is unavailable.
  const scheduledIds = useMemo(
    () => (schedule.isError ? new Set<string>() : scheduledProjectIds(schedule.data ?? [])),
    [schedule.data, schedule.isError],
  );
  const recentIds = useMemo(
    () => recentWork.data ?? new Set<string>(),
    [recentWork.data],
  );

  const accessibleIds = useMemo(() => new Set(rows.map((p) => p.id)), [rows]);
  // Only assignments pointing at a job this person can actually see AND that
  // is still an active job belong in the recommendation — a schedule row for
  // a trashed or inaccessible job is not a job to send anyone to.
  const nextJobAssignments = useMemo(
    () => (schedule.data ?? []).filter((a) => a.project_id && accessibleIds.has(a.project_id)),
    [schedule.data, accessibleIds],
  );
  const highlightEntry = useMemo(
    () =>
      schedule.isError
        ? null
        : nextScheduledJob(nextJobAssignments, today, nowClockLocal(now)),
    [nextJobAssignments, today, now, schedule.isError],
  );
  const highlightedProject = highlightEntry
    ? rows.find((p) => p.id === highlightEntry.assignment.project_id) ?? null
    : null;

  const scheduleLoading = !myId || schedule.isPending;
  const recentLoading = !myId || recentWork.isPending;
  const scheduledCount = schedule.isError ? null : rows.filter((p) => scheduledIds.has(p.id)).length;
  const recentCount = recentWork.isError ? null : rows.filter((p) => recentIds.has(p.id)).length;

  const searchResults = useMemo(
    () => sortJobsAlpha(rows.filter((p) => matchesSearch(p, query))),
    [rows, query],
  );
  const chipJobs = useMemo(
    () => sortJobsAlpha(filterJobsByView(rows, view, scheduledIds, recentIds)),
    [rows, view, scheduledIds, recentIds],
  );
  const grouped = useMemo(
    () => groupJobsForList(rows, scheduledIds, recentIds, highlightedProject?.id ?? null, false),
    [rows, scheduledIds, recentIds, highlightedProject],
  );

  const chip = (value: JobsViewFilter, label: string, count: number | null, loading = false) => (
    <button
      type="button"
      className={`jobs-chip${view === value ? " active" : ""}`}
      onClick={() => setView(value)}
      aria-pressed={view === value}
    >
      {label} {loading ? "(…)" : count === null ? `(${t("jobs.chip.loadError")})` : `(${count})`}
    </button>
  );

  /** One job card. `rail` is only ever non-null in office-order mode — see the
   * note on `showOfficeOrder` above for why the two never mix.
   *
   * Compact by default (Horizon borrowing, 2026-10-01): a body-font name, no
   * standalone footer, a thin inline progress row instead of a loud top-right
   * percent. Delete moves out of every card's footer — it only earns its row
   * once a foreman has explicitly opened Office order, which is also the only
   * state the reorder rail itself ever renders in. Keeps the exact tag and
   * className `a.project-card`, and `.job-card-body`/`.job-card-name` for
   * their text-alignment measurement, that other e2e specs already select
   * (foreman-marks.spec.ts, job-cards.spec.ts). */
  function renderCard(p: Project, rail: ReactNode, dragProps: Record<string, unknown>) {
    const c = countFor(p.id);
    const chatUnread = unread.data?.[p.id] ?? 0;
    const call = needsCall(p, today, checkins.data?.byProject[p.id] ?? null, checkins.data?.known ?? false);
    const pctColor = c.pct >= 80 ? "var(--ok)" : c.pct >= 40 ? "var(--accent)" : "var(--warn)";
    return (
      <Link key={p.id} to={`/projects/${p.id}`} className="project-card home-project" {...dragProps}>
        <div className={`home-project-head job-card-head${rail ? " job-card-head-rail" : ""}`}>
          {rail}
          <div className="job-card-body">
            <div className="job-card-title">
              <span className="job-card-name">{p.name || p.job_code}</span>
            </div>
            <div className="muted job-card-sub">
              {p.job_code}
              {p.address ? ` · ${p.address}` : ""}
            </div>
            <div className="jobs-card-status">
              <JobModeBadge allowed={p.allowed_modes} />
              <ReadinessBadge readyState={p.ready_state} />
              {call.call && (
                <span className="job-needs-call">
                  <Phone size={11} aria-hidden /> {t("pipeline.needsCall")}
                </span>
              )}
              {chatUnread > 0 && (
                <span className="chat-badge" title={`${chatUnread} unread message${chatUnread > 1 ? "s" : ""}`}>
                  <MessagesSquare size={11} aria-hidden />
                  {chatUnread}
                </span>
              )}
            </div>
            <ScopeLine
              counts={c.row}
              stories={p.stories}
              trackingOnly={isTrackingOnly(p.allowed_modes)}
              className="muted job-card-sub"
            />
            <PipelineLine job={p} />
            {c.total > 0 && (
              <div
                className="jobs-progress-row"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={c.pct}
                aria-label={t("jobs.card.progress", { installed: c.installed, total: c.total, pct: c.pct })}
              >
                <div className="jobs-progress-bar" aria-hidden>
                  <div className="jobs-progress-fill" style={{ width: `${c.pct}%`, background: pctColor }} />
                </div>
                <span className="jobs-progress-label" style={{ color: pctColor }} aria-hidden>
                  {c.installed}/{c.total} · {c.pct}%
                </span>
              </div>
            )}
          </div>
        </div>
        {canDelete && showOfficeOrder && (
          <div className="home-project-meta job-card-meta jobs-card-delete-row">
            <button
              type="button"
              className="link"
              style={{ color: "var(--danger)" }}
              disabled={deletingId === p.id}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void handleDeleteClick(p);
              }}
            >
              {deletingId === p.id ? t("deljob.checking") : t("deljob.delete")}
            </button>
          </div>
        )}
      </Link>
    );
  }

  function renderOfficeOrderRail(index: number) {
    return (
      <div
        className="job-order-rail"
        // Inside the Link, so every control here stops its own click reaching
        // the card's navigation — the same trick the Delete button plays.
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <span className="job-order-grip" title={t("pipeline.order.drag")} aria-hidden>
          <GripVertical size={16} />
        </span>
        <button
          type="button"
          className="job-order-btn"
          aria-label={t("pipeline.order.up")}
          disabled={index === 0 || saveOrder.isPending}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            moveTo(index, index - 1);
          }}
        >
          <ChevronUp size={18} aria-hidden />
        </button>
        <button
          type="button"
          className="job-order-btn"
          aria-label={t("pipeline.order.down")}
          disabled={index === rows.length - 1 || saveOrder.isPending}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            moveTo(index, index + 1);
          }}
        >
          <ChevronDown size={18} aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div className="page jobs-page">
      <header className="page-header jobs-page-header">
        <div>
          <h1>{t("jobs.title")}</h1>
          {!projects.isLoading && !projects.isError && (
            <p className="muted jobs-subtitle">{t("jobs.count.label", { n: rows.length })}</p>
          )}
        </div>
        <div className="jobs-header-actions">
          {canAdd && (
            <button type="button" className="jobs-new" onClick={() => setAdding((v) => !v)}>
              {adding ? t("jobs.cancel") : t("jobs.new")}
            </button>
          )}
          <BackChip fallback="/" label={t("jobs.home")} />
        </div>
      </header>
      <SavedCopyNotice reason={savedCopy} />

      {/* Desktop only (CSS, 860px) — the phone equivalent is the Filters
          button + sheet below, which owns the same two controls. */}
      {canAdd && (
        <div className="jobs-desktop-tools">
          <Link to="/jobs/history" className="link">{t("jobs.history")} →</Link>
          {canOrder && (
            <button
              type="button"
              className="link jobs-order-toggle"
              disabled={searching || saveOrder.isPending}
              onClick={() => setOfficeOrderMode((v) => !v)}
            >
              {showOfficeOrder ? t("jobs.officeOrder.done") : t("jobs.officeOrder.toggle")}
            </button>
          )}
        </div>
      )}

      {!showOfficeOrder && !projects.isLoading && !projects.isError && (
        <div className="jobs-search-bar">
          <Search size={16} className="jobs-search-icon" aria-hidden />
          <input
            type="search"
            className="jobs-search-input"
            autoComplete="off"
            enterKeyHint="search"
            placeholder={t("jobs.search.placeholder")}
            aria-label={t("jobs.search.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="jobs-search-clear"
              aria-label={t("jobs.search.clear")}
              onClick={() => setQuery("")}
            >
              <X size={16} aria-hidden />
            </button>
          )}
        </div>
      )}

      {!projects.isLoading && !projects.isError && (
        <div className="jobs-filter-row">
          {!showOfficeOrder && !searching && (
            <div className="jobs-chip-row">
              {chip("all", t("jobs.chip.all"), rows.length)}
              {chip("scheduled", t("jobs.chip.scheduled"), scheduledCount, scheduleLoading)}
              {chip("recent", t("jobs.chip.recent"), recentCount, recentLoading)}
            </div>
          )}
          {canAdd && (
            <button
              type="button"
              className="jobs-filters-btn"
              aria-expanded={filtersOpen}
              aria-haspopup="dialog"
              onClick={() => setFiltersOpen(true)}
            >
              <SlidersHorizontal size={16} aria-hidden /> {t("jobs.filters.open")}
            </button>
          )}
        </div>
      )}
      {searching && (
        <p className="muted jobs-search-note">{t("jobs.search.allJobsNote")}</p>
      )}
      {schedule.isError && (
        <p className="muted jobs-search-note">{t("jobs.scheduleError")}</p>
      )}
      {recentWork.isError && (
        <p className="muted jobs-search-note">{t("jobs.recentError")}</p>
      )}

      {/* Phone only (CSS hides the trigger at 860px) — History and Office
          order behind one accessible sheet rather than their own toolbar
          row. Closes itself the moment Office order is tapped (owner ask),
          and reopening it is also how a foreman gets back to "Done
          ordering" — the trigger stays up even mid-reorder. */}
      {canAdd && (
        <Sheet open={filtersOpen} onClose={() => setFiltersOpen(false)} label={t("jobs.filters.open")}>
          <div className="jobs-filters-head">
            <h2 className="jobs-filters-title">{t("jobs.filters.open")}</h2>
            <button type="button" className="jobs-filters-close" onClick={() => setFiltersOpen(false)}>
              {t("jobs.filters.close")}
            </button>
          </div>
          <div className="jobs-filters-list">
            <Link to="/jobs/history" className="link" onClick={() => setFiltersOpen(false)}>
              {t("jobs.history")} →
            </Link>
            {canOrder && (
              <button
                type="button"
                className="link jobs-order-toggle"
                disabled={searching || saveOrder.isPending}
                onClick={() => {
                  setOfficeOrderMode((v) => !v);
                  setFiltersOpen(false);
                }}
              >
                {showOfficeOrder ? t("jobs.officeOrder.done") : t("jobs.officeOrder.toggle")}
              </button>
            )}
          </div>
        </Sheet>
      )}

      {canAdd && adding && (
        <div className="project-create">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                addProject.mutate();
              }}
            >
              <div className="row-between">
                <h2>New project</h2>
                <button type="button" className="link" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
              <div className="project-create-grid">
                <label>
                  <span className="field-label">Job code</span>
                  <input
                    value={jobCode}
                    onChange={(e) => setJobCode(e.target.value)}
                    placeholder="PECAN14"
                    autoCapitalize="characters"
                    required
                  />
                </label>
                <label>
                  <span className="field-label">Project name</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Pecan Valley Town Homes — Building 14"
                    required
                  />
                </label>
                <label>
                  <span className="field-label">Customer / contact</span>
                  <input
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Pecan Valley HOA · Jane Doe"
                  />
                </label>
                <label>
                  <span className="field-label">Contact phone</span>
                  <input
                    type="tel"
                    value={contactPhone}
                    onChange={(e) => setContactPhone(e.target.value)}
                    placeholder="(435) 555-0173"
                  />
                </label>
                <label>
                  <span className="field-label">Contact email</span>
                  <input
                    type="email"
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                    placeholder="office@pecanvalley.com"
                  />
                </label>
                <label className="project-create-address">
                  <span className="field-label">Site address</span>
                  <input
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="173 Pecan Valley Dr, Hurricane, UT 84737"
                  />
                </label>
                <label>
                  <span className="field-label">Building / unit / lot</span>
                  <input
                    value={unitNumber}
                    onChange={(e) => setUnitNumber(e.target.value)}
                    placeholder="Building 14 · Lots 173–183"
                  />
                </label>
                <label>
                  <span className="field-label">State</span>
                  <input
                    value={siteState}
                    onChange={(e) => setSiteState(e.target.value)}
                    placeholder="UT"
                    maxLength={2}
                    autoCapitalize="characters"
                  />
                </label>
                <label>
                  <span className="field-label">{t("scope.stories.label")}</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={60}
                    value={stories}
                    onChange={(e) => setStories(e.target.value)}
                    placeholder="2"
                  />
                  <span className="wh-row-sub" style={{ display: "block", marginTop: 4 }}>
                    {t("scope.stories.hint")}
                  </span>
                </label>
                <label>
                  <span className="field-label">Scheduled start</span>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </label>
                <label>
                  <span className="field-label">Target completion</span>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </label>
                <label className="project-create-address">
                  <span className="field-label">Job notes</span>
                  <VoiceTextarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Access, gate codes, staging area, scope reminders…"
                    rows={3}
                  />
                </label>
                <label className="project-create-address">
                  <span className="field-label">{t("pipeline.create.label")}</span>
                  <select
                    value={readyState}
                    onChange={(e) => setReadyState(e.target.value as "ready" | "not_ready")}
                  >
                    <option value="ready">{t("pipeline.ready")}</option>
                    <option value="not_ready">{t("pipeline.notReady")}</option>
                  </select>
                  <span className="wh-row-sub" style={{ display: "block", marginTop: 4 }}>
                    {t("pipeline.create.hint")}
                  </span>
                </label>
                <label className="project-create-address">
                  <span className="field-label">{t("jobmode.create.label")}</span>
                  <select
                    value={modeChoice}
                    onChange={(e) => setModeChoice(e.target.value as ModeChoice)}
                  >
                    <option value="data">{t("jobmode.opt.data")}</option>
                    <option value="tracking">{t("jobmode.opt.tracking")}</option>
                    <option value="both">{t("jobmode.opt.both")}</option>
                  </select>
                  <span className="wh-row-sub" style={{ display: "block", marginTop: 4 }}>
                    {t("jobmode.create.hint")}
                  </span>
                </label>
              </div>
              {addProject.isError && <p className="error">{formatApiError(addProject.error)}</p>}
              <button
                type="submit"
                className="action-btn primary"
                disabled={addProject.isPending || !jobCode.trim() || !name.trim()}
              >
                {addProject.isPending ? "Creating…" : "Create project and add PDFs"}
              </button>
            </form>
        </div>
      )}
      {message && <p className="scanner-hint">{message}</p>}

      {projects.isLoading && <SkeletonList rows={4} />}
      {projects.isError && (
        <QueryError
          error={projects.error}
          onRetry={() => void projects.refetch()}
          label="Couldn't load jobs"
        />
      )}
      {/* If the counts query fails, countFor() quietly falls back to zeroes
          and every card would look like a job nobody has touched. Say so
          plainly instead of going silent, so a broken read is never mistaken
          for no work done. */}
      {!projects.isLoading && !projects.isError && counts.isError && (
        <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Progress unavailable — job list below is current, but "openings done" counts couldn't load.
        </p>
      )}

      {!projects.isLoading && !projects.isError && showOfficeOrder && (
        <div className="home-projects">
          <p className="muted jobs-search-note">{t("jobs.officeOrder.hint")}</p>
          {rows.map((p, index) => renderCard(p, renderOfficeOrderRail(index), {
            draggable: true,
            onDragStart: (e: React.DragEvent) => {
              setDragIndex(index);
              e.dataTransfer.effectAllowed = "move";
            },
            onDragOver: (e: React.DragEvent) => {
              if (dragIndex !== null) e.preventDefault();
            },
            onDrop: (e: React.DragEvent) => {
              if (dragIndex === null) return;
              e.preventDefault();
              moveTo(dragIndex, index);
              setDragIndex(null);
            },
            onDragEnd: () => setDragIndex(null),
          }))}
          {rows.length === 0 && (
            <EmptyState
              icon={<LayoutGrid size={22} />}
              title="No active jobs yet"
              message="Create your first job to start tracking installs, photos, and time."
            />
          )}
        </div>
      )}

      {!projects.isLoading && !projects.isError && !showOfficeOrder && searching && (
        <div className="home-projects">
          <p className="muted jobs-search-note">
            {searchResults.length === 1
              ? t("jobs.search.count.one")
              : t("jobs.search.count.many", { n: searchResults.length })}
          </p>
          {searchResults.map((p) => renderCard(p, null, {}))}
          {searchResults.length === 0 && (
            <EmptyState
              icon={<Search size={22} />}
              title={t("jobs.search.none")}
              message={t("jobs.search.noneHint")}
            />
          )}
        </div>
      )}

      {!projects.isLoading && !projects.isError && !showOfficeOrder && !searching && view === "scheduled" && (
        <div className="home-projects">
          {schedule.isError ? (
            <QueryError error={schedule.error} onRetry={() => void schedule.refetch()} label={t("jobs.scheduleError")} />
          ) : scheduleLoading ? (
            <SkeletonList rows={2} />
          ) : chipJobs.length === 0 ? (
            <EmptyState icon={<CalendarClock size={22} />} title={t("jobs.noneScheduled")} message={t("jobs.scheduleHorizon")} />
          ) : (
            chipJobs.map((p) => renderCard(p, null, {}))
          )}
        </div>
      )}

      {!projects.isLoading && !projects.isError && !showOfficeOrder && !searching && view === "recent" && (
        <div className="home-projects">
          {recentWork.isError ? (
            <QueryError error={recentWork.error} onRetry={() => void recentWork.refetch()} label={t("jobs.recentError")} />
          ) : recentLoading ? (
            <SkeletonList rows={2} />
          ) : chipJobs.length === 0 ? (
            <EmptyState icon={<LayoutGrid size={22} />} title={t("jobs.noneRecent")} message={t("jobs.recentWindow")} />
          ) : (
            chipJobs.map((p) => renderCard(p, null, {}))
          )}
        </div>
      )}

      {!projects.isLoading && !projects.isError && !showOfficeOrder && !searching && view === "all" && (
        <div className="home-projects">
          {grouped.highlighted && (
            <div className="jobs-highlight">
              <p className="jobs-highlight-label">
                <CalendarClock size={14} aria-hidden /> {t("jobs.next.heading")}
                {highlightEntry && (
                  <span className="jobs-highlight-time">
                    {" "}
                    ·{" "}
                    {highlightEntry.day === today ? t("jobs.next.today") : new Date(`${highlightEntry.day}T12:00:00`).toLocaleDateString(lang, { weekday: "short", month: "short", day: "numeric" })}
                    {highlightEntry.assignment.start_time ? ` · ${highlightEntry.assignment.start_time.slice(0, 5)}` : ` · ${t("jobs.timeUnknown")}`}
                  </span>
                )}
              </p>
              {renderCard(grouped.highlighted, null, {})}
            </div>
          )}
          {grouped.scheduled.length > 0 && (
            <>
              <h2 className="jobs-group-heading">{t("jobs.group.scheduled")}</h2>
              {grouped.scheduled.map((p) => renderCard(p, null, {}))}
            </>
          )}
          {grouped.recentlyWorked.length > 0 && (
            <>
              <h2 className="jobs-group-heading">{t("jobs.group.recent")}</h2>
              {grouped.recentlyWorked.map((p) => renderCard(p, null, {}))}
            </>
          )}
          {grouped.other.length > 0 && (
            <>
              {(grouped.scheduled.length > 0 || grouped.recentlyWorked.length > 0) && (
                <h2 className="jobs-group-heading">{t("jobs.group.other")}</h2>
              )}
              {grouped.other.map((p) => renderCard(p, null, {}))}
            </>
          )}
          {!grouped.highlighted &&
            grouped.scheduled.length === 0 &&
            grouped.recentlyWorked.length === 0 &&
            grouped.other.length === 0 &&
            projects.data?.length === 0 && (
              <EmptyState
                icon={<LayoutGrid size={22} />}
                title="No active jobs yet"
                message={
                  canAdd
                    ? "Create your first job to start tracking installs, photos, and time."
                    : "Jobs will show up here once your office adds them."
                }
              />
            )}
        </div>
      )}
      {canAdd && (
        <details className="jobs-office-tools">
          <summary>{t("jobs.imports")}</summary>
          <IncomingMondayJobs />
        </details>
      )}
    </div>
  );
}
