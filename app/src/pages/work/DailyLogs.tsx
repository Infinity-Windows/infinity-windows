// The Daily Logs page (owner request 2026-10-01, Horizon parity): every job
// a person reaches, across every day, in one place — not nested inside one
// job's tabs. New-design-only; the classic per-job Logs tab (DailyLogsTab)
// is untouched (K-X2: old screens frozen, fixes only) and still works.
//
// Pagination is explicit, bounded, and ACCUMULATED (independent review,
// 2026-10-01): each "Load more" fetches exactly one more fixed-size page and
// appends it — the earlier pageCount*50-from-offset-0 shape widened its own
// request past PostgREST's row cap, which silently truncates (the one row of
// lookahead listMyDailyLogs fetches would then prove nothing — the cap cut
// the response before that extra row ever existed). A job filter is applied
// SERVER-SIDE (listMyDailyLogs's projectId), not just on whatever page
// happened to already be loaded, so selecting a job can never read as "no
// other history" the moment its next log falls on an unfetched page.
import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/workCatalog";
import { listProjects } from "../../lib/api";
import {
  getDailyLogById,
  listDailyLogs,
  listMyDailyLogs,
  DAILY_LOGS_PAGE_SIZE,
  type DailyLog,
} from "../../lib/dailyLogs";
import { formatLogDateLabel, localDateISO } from "../../lib/dailyLogDay";
import { DailyLogDialog } from "../../components/dailyLogs/DailyLogDialog";
import { DailyLogDetail } from "../../components/dailyLogs/DailyLogDetail";
import { DailyLogJobPicker } from "../../components/dailyLogs/DailyLogJobPicker";
import { DailyLogCard } from "../../components/dailyLogs/DailyLogCard";
import type { Project } from "../../lib/types";
import "../../components/dailyLogs/dailyLogs.css";
import "./work.css";

function jobLabelOf(log: DailyLog): string {
  return log.project ? `${log.project.job_code} · ${log.project.name}` : (log.job_name ?? "");
}

export function DailyLogs() {
  const t = useT();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [jobFilter, setJobFilter] = useState("");
  const [fromDate, setFromDate] = useState(() => localDateISO(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)));
  const [toDate, setToDate] = useState(() => localDateISO());
  const [pickingJob, setPickingJob] = useState(false);
  const [editingLog, setEditingLog] = useState<{ projectId: string; logDate: string; jobLabel: string } | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(searchParams.get("log"));

  const projects = useQuery({ queryKey: ["projects"], queryFn: () => listProjects() });
  const page = useInfiniteQuery({
    queryKey:["dailyLogsAcrossJobs",fromDate,toDate,jobFilter],
    initialPageParam:0,
    queryFn:({pageParam})=>listMyDailyLogs({fromDate,toDate,projectId:jobFilter||undefined,offset:pageParam,pageSize:DAILY_LOGS_PAGE_SIZE}),
    getNextPageParam:(last,pages)=>last.hasMore?pages.length*DAILY_LOGS_PAGE_SIZE:undefined,
  });
  const accumulated=useMemo(()=>[...new Map((page.data?.pages??[]).flatMap(p=>p.logs).map(log=>[log.id,log])).values()],[page.data]);
  const viewed = useQuery({
    queryKey: ["dailyLog", "byId", viewingId],
    queryFn: () => (viewingId ? getDailyLogById(viewingId) : Promise.resolve(null)),
    enabled: !!viewingId,
  });
  const viewedJobHistory = useQuery({
    queryKey: ["dailyLogs", viewed.data?.project_id],
    queryFn: () => (viewed.data?.project_id ? listDailyLogs(viewed.data.project_id) : Promise.resolve([])),
    enabled: !!viewed.data?.project_id,
  });

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (viewingId) next.set("log", viewingId); else next.delete("log");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingId]);

  const searchActive = search.trim().length > 0;
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accumulated;
    return accumulated.filter((l) =>
      jobLabelOf(l).toLowerCase().includes(q) ||
      (l.notes ?? "").toLowerCase().includes(q) ||
      (l.headline ?? "").toLowerCase().includes(q) ||
      (l.filer?.display_name ?? "").toLowerCase().includes(q),
    );
  }, [accumulated, search]);

  /** The single most-recent-dated log per job, among everything loaded so
   * far — independent of the free-text search filter, so typing a search
   * term never silently reassigns which card gets to say "Latest". Computed
   * from the SAME window already fetched, no extra request. */
  const latestLogIdByProject = useMemo(() => {
    const latest = new Map<string, DailyLog>();
    for (const log of accumulated) {
      if (!log.project_id) continue;
      const current = latest.get(log.project_id);
      if (!current || log.log_date > current.log_date || (log.log_date === current.log_date && log.id > current.id)) {
        latest.set(log.project_id, log);
      }
    }
    return new Set([...latest.values()].map((l) => l.id));
  }, [accumulated]);

  /** Every OTHER loaded log for the same project, older than the one being
   * rendered — the stage-delta window a card reads against, bounded to THIS
   * page's own accumulated fetch (no extra network round trip per card). */
  function earlierSameJobLogs(log: DailyLog) {
    return accumulated
      .filter((l) => l.project_id && l.project_id === log.project_id && l.log_date < log.log_date)
      .map((l) => ({ stageProgress: l.stageProgress, logDate: l.log_date }));
  }

  const groups = useMemo(() => {
    const byDate = new Map<string, DailyLog[]>();
    for (const log of filtered) {
      const arr = byDate.get(log.log_date) ?? [];
      arr.push(log);
      byDate.set(log.log_date, arr);
    }
    return [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);

  // One job selected: the latest report for IT, surfaced without opening a
  // card — "the user must see current progress/remaining in one tab"
  // (independent review, 2026-10-01). Reuses DailyLogCard itself so the
  // overview can never show a different shape of truth than the list below.
  const overviewLog = jobFilter
    ? accumulated.find((l) => latestLogIdByProject.has(l.id) && l.project_id === jobFilter) ?? null
    : null;

  if (viewingId) {
    return (
      <div className="page daily-logs-page">
        {viewed.isLoading && <p className="muted">{t("dailyLog.loading")}</p>}
        {viewed.isSuccess && !viewed.data && <p className="muted">{t("dailyLogsPage.notFound")}</p>}
        {viewed.data && (
          <DailyLogDetail
            log={viewed.data}
            priorLogs={(viewedJobHistory.data ?? []).filter((l) => l.log_date < viewed.data!.log_date)}
            onBack={() => setViewingId(null)}
            onEdit={() => {
              if (!viewed.data) return;
              setEditingLog({ projectId: viewed.data.project_id, logDate: viewed.data.log_date, jobLabel: jobLabelOf(viewed.data) });
            }}
          />
        )}
        {editingLog && (
          <DailyLogDialog
            projectId={editingLog.projectId}
            logDate={editingLog.logDate}
            jobLabel={editingLog.jobLabel}
            onClose={() => setEditingLog(null)}
            onSaved={() => { setEditingLog(null); viewed.refetch(); }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="page daily-logs-page">
      <div className="daily-log-list-header">
        <h2>{t("dailyLogsPage.title")}</h2>
        <button type="button" className="button-like active-pill" onClick={() => setPickingJob(true)}>
          {t("dailyLog.addToday")}
        </button>
      </div>
      <p className="muted">{t("dailyLogsPage.subtitle")}</p>

      <div className="daily-log-search">
        <Search size={16} aria-hidden="true" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("dailyLogsPage.search")} aria-label={t("dailyLogsPage.search")} />
      </div>
      <div className="daily-log-date-filters">
        <label>
          <span>{t("dailyLogsPage.from")}</span>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </label>
        <label>
          <span>{t("dailyLogsPage.to")}</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </label>
        <label>
          <span>{t("dailyLogsPage.allJobs")}</span>
          <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)}>
            <option value="">{t("dailyLogsPage.allJobs")}</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.job_code} · {p.name}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted daily-log-range-note">{t("dailyLogsPage.rangeNote", { from: formatLogDateLabel(fromDate), to: formatLogDateLabel(toDate) })}</p>

      {overviewLog && (
        <section className="daily-log-overview">
          <h3>{t("dailyLogsPage.overview.title")}</h3>
          <ul className="daily-log-card-list">
            <DailyLogCard
              log={overviewLog}
              jobLabel={jobLabelOf(overviewLog)}
              earlierSameJobLogs={earlierSameJobLogs(overviewLog)}
              isLatest
              onOpen={() => setViewingId(overviewLog.id)}
              onEdit={() => setEditingLog({ projectId: jobFilter, logDate: overviewLog.log_date, jobLabel: jobLabelOf(overviewLog) })}
            />
          </ul>
        </section>
      )}
      {jobFilter && !overviewLog && !page.isLoading && (
        <p className="muted">{t("dailyLogsPage.overview.noneInWindow")}</p>
      )}

      {page.isLoading && !accumulated.length && <p className="muted">{t("dailyLog.loading")}</p>}
      {!page.isLoading && accumulated.length === 0 && <p className="muted">{t("dailyLog.empty")}</p>}
      {!page.isLoading && accumulated.length > 0 && groups.length === 0 && (
        <p className="muted">
          {searchActive && page.hasNextPage
            ? t("dailyLogsPage.searchNoMatchYet", { count: accumulated.length })
            : t("dailyLog.empty")}
        </p>
      )}

      {groups.map(([date, logs]) => (
        <section key={date} className="daily-log-day-group">
          <h3>{formatLogDateLabel(date)} · {logs.length}</h3>
          <ul className="daily-log-card-list">
            {logs.map((log) => {
              const projectId = log.project_id;
              return (
                <DailyLogCard
                  key={log.id}
                  log={log}
                  jobLabel={jobLabelOf(log)}
                  earlierSameJobLogs={earlierSameJobLogs(log)}
                  isLatest={latestLogIdByProject.has(log.id)}
                  onOpen={() => setViewingId(log.id)}
                  onEdit={projectId ? () => setEditingLog({ projectId, logDate: log.log_date, jobLabel: jobLabelOf(log) }) : null}
                />
              );
            })}
          </ul>
        </section>
      ))}

      {page.hasNextPage && (
        <button type="button" className="button-like" disabled={page.isFetchingNextPage} onClick={()=>void page.fetchNextPage()}>
          {page.isFetching ? t("dailyLog.loading") : t("dailyLogsPage.loadMore")}
        </button>
      )}

      {pickingJob && projects.data && (
        <DailyLogJobPicker
          projects={projects.data}
          onClose={() => setPickingJob(false)}
          onPick={(p: Project) => {
            setPickingJob(false);
            setEditingLog({ projectId: p.id, logDate: localDateISO(), jobLabel: `${p.job_code} · ${p.name}` });
          }}
        />
      )}
      {editingLog && !viewingId && (
        <DailyLogDialog
          projectId={editingLog.projectId}
          logDate={editingLog.logDate}
          jobLabel={editingLog.jobLabel}
          onClose={() => setEditingLog(null)}
          onSaved={() => setEditingLog(null)}
        />
      )}
    </div>
  );
}
