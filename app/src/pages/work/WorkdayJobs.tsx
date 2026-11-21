import { ArrowLeftRight, Search, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { useLanguage } from "../../lib/i18n";
import { supabase } from "../../lib/supabase";
import { openClockGlobally, useClock } from "../../lib/clockContext";
import { prepareWorkdayDestination } from "../../lib/installerWorkflow/workdayProject";
import { localWorkDate } from "../../lib/customWork/model";
import { listMyPublished } from "../../lib/schedule/api";
import { pickTodayEntries } from "../../lib/work/today";
import { formatApiError } from "../../lib/errors";
import { listRecentJobs } from "../../lib/timeclock";

const PAGE_SIZE = 20;
type Job = { id: string; job_code: string; name: string };

export function WorkdayJobs({ profileId, currentJob, previewDate, onChoose, jobName, plannedJobs = [] }: { profileId: string; currentJob?: string; previewDate?: string; onChoose?: (id: string, label: string) => void; jobName?: string; plannedJobs?: Job[] }) {
  const es = useLanguage().lang === "es";
  const clock = useClock();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(input.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [input]);

  const profile = useQuery({
    queryKey: ["workdayJobPartition", profileId],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("is_test").eq("id", profileId).single();
      if (error) throw error;
      return data.is_test === true;
    },
  });
  const recent = useQuery({
    queryKey: ["recentJobs", profileId],
    queryFn: () => listRecentJobs(profileId),
    enabled: open && !input.trim(),
  });
  const jobs = useInfiniteQuery({
    queryKey: ["workdayJobs", profileId, profile.data, search],
    enabled: open && profile.isSuccess,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      let query = supabase.from("projects").select("id,job_code,name")
        .is("deleted_at", null).eq("is_test", profile.data!)
        .order("created_at", { ascending: false }).order("id")
        .range(pageParam, pageParam + PAGE_SIZE - 1).abortSignal(signal);
      if (search) {
        const pattern = ("%" + search.replace(/[\\%_]/g, "\\$&") + "%")
          .replace(/[\\"]/g, "\\$&");
        query = query.or(`job_code.ilike."${pattern}",name.ilike."${pattern}"`);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data as Job[];
    },
    getNextPageParam: (last, pages) => last.length === PAGE_SIZE ? pages.length * PAGE_SIZE : undefined,
  });
  const today = localWorkDate();
  const schedule = useQuery({ queryKey: ["workSchedule", profileId, today, today],
    queryFn: () => listMyPublished(profileId, today, today), enabled: open && !onChoose && !previewDate });
  const standaloneJobs = pickTodayEntries(schedule.data ?? [], profileId, today, today).entries.flatMap(entry =>
    entry.project ? [entry.project] : []);
  const matchesSearch = (job: Job) => !search || (job.job_code + " " + job.name).toLowerCase().includes(search.toLowerCase());
  const cachedBrowse = !navigator.onLine && profile.data !== undefined
    ? client.getQueriesData<InfiniteData<Job[]>>({ queryKey: ["workdayJobs", profileId, profile.data] })
      .flatMap(([, saved]) => saved?.pages.flat() ?? []).filter(matchesSearch)
    : [];
  const browseJobs = jobs.data?.pages.flat() ?? cachedBrowse;
  const recents = !search && !input.trim() && profile.data === false
    ? recent.data?.filter(job => job.jobCode).map(job => ({ id: job.projectId, job_code: job.jobCode, name: job.name })) ?? []
    : [];
  const planned = [...plannedJobs, ...standaloneJobs].filter(job => job.id !== currentJob &&
    matchesSearch(job));
  const rows = [...new Map([...planned, ...recents, ...browseJobs].map(job => [job.id, job])).values()]
    .filter(job => job.id !== currentJob);
  const choose = async (job: Job) => {
    if (checking || clock.isOpen) return;
    setSwitchError("");
    if (onChoose) { onChoose(job.id, job.job_code); setOpen(false); return; }
    setChecking(true);
    try { await prepareWorkdayDestination(client, profileId, job.id); }
    catch (error) { setSwitchError(formatApiError(error)); return; }
    finally { setChecking(false); }
    setOpen(false);
    const enter = () => navigate("/installer-day?" + new URLSearchParams({ project: job.id, work: "1" }));
    openClockGlobally({ projectId: job.id, costCodeId: null, note: null, mode: null, stayOnPage: true,
      switchToProject: true, workdaySwitch: true, workdayStart: { label: job.job_code, onReady: enter } });
  };
  const settling = input.trim() !== search || profile.isPending || jobs.isPending;
  const failed = (profile.isError && profile.data === undefined || jobs.isError && !jobs.data) && !rows.length;

  return (
    <div className="ws-workday-jobs" data-job-switcher={Boolean(jobName)} onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}>
      {/* The job's name is the switcher: one control, with a chevron to say it
          opens (Matt, 2026-11-20: "I want to get rid of the button"). */}
      {jobName ? <button type="button" className="ws-current-job" aria-expanded={open}
        aria-label={`${es ? "Cambiar obra" : "Switch job"}: ${jobName}`} title={es ? "Cambiar obra" : "Switch job"}
        onClick={() => setOpen(value => !value)}>
        <strong>{jobName}</strong><ChevronDown size={18} aria-hidden="true" />
      </button> : <button type="button" className="ws-btn" aria-expanded={open}
        onClick={() => setOpen(value => !value)}>
        {currentJob ? <ArrowLeftRight size={16} aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
        {currentJob ? es ? "Cambiar obra" : "Switch job" : es ? "Buscar obra" : "Find Job"}
      </button>}
      {open && <section className="ws-workday-job-picker" aria-label={es ? "Obras disponibles" : "Available jobs"}>
        <input type="search" value={input} onChange={event => setInput(event.target.value)}
          placeholder={es ? "Buscar obra" : "Search jobs"} aria-label={es ? "Buscar obra" : "Search jobs"} />
        {switchError && <p role="alert">{switchError}</p>}
        {checking && <p role="status">{es ? "Comprobando la obra…" : "Checking job access…"}</p>}
        {failed ? <button className="ws-btn" onClick={() => void (profile.isError ? profile.refetch() : jobs.refetch())}>
          {es ? "No se pudieron cargar las obras. Reintentar" : "Couldn’t load jobs. Retry"}
        </button> : settling && !rows.length ? <p role="status">{es ? "Buscando obras…" : "Finding jobs…"}</p> : <>
          {rows.map(job => onChoose || (!previewDate && clock.shift?.status === "open" && clock.shift.project_id !== job.id) ? (
            <button type="button" key={job.id} className="ws-saved-unit"
              aria-current={job.id === currentJob ? "page" : undefined}
              disabled={checking} onClick={() => void choose(job)}>
              <strong>{job.job_code}</strong><span>{job.name}</span>
              {planned.some(item => item.id === job.id) && <small>{es ? "Plan de hoy" : "Planned today"}</small>}
            </button>
          ) : (
            <Link key={job.id} className="ws-saved-unit" aria-current={job.id === currentJob ? "page" : undefined}
              to={`/installer-day?${new URLSearchParams(previewDate
                ? { project: job.id, planAs: profileId, planDate: previewDate }
                : { project: job.id, work: "1" })}`} onClick={() => setOpen(false)}>
              <strong>{job.job_code}</strong><span>{job.name}</span>
              {planned.some(item => item.id === job.id) && <small>{es ? "Plan de hoy" : "Planned today"}</small>}
            </Link>
          ))}
          {!rows.length && <p>{es ? "No se encontraron obras." : "No jobs found."}</p>}
          {jobs.hasNextPage && <button type="button" className="ws-btn" disabled={jobs.isFetchingNextPage}
            onClick={() => void jobs.fetchNextPage()}>{es ? "Ver más obras" : "Show more jobs"}</button>}
        </>}
      </section>}
    </div>
  );
}
