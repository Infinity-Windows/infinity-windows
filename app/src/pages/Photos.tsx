import { BackChip } from "../components/BackChip";
import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { listProjects } from "../lib/api";
import { listMyWorkedJobs, type WorkedJob } from "../lib/photos";
import { PhotoFeed } from "../components/photos/PhotoFeed";
import { PhotoKindTabs } from "../components/photos/PhotoKindTabs";
import { useClock } from "../lib/clockContext";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { isForemanPlus } from "../lib/install/types";
import { useT } from "../lib/i18n";

export function Photos() {
  const [params, setParams] = useSearchParams();
  const t = useT();
  const projectId = params.get("project");
  const kind = params.get("kind") === "receipt" ? "receipt" : "photo";
  const initialCapture = params.get("capture") === "1";
  const { effectiveRole, isLoading: roleLoading } = useEffectiveRole();
  const isLead = isForemanPlus(effectiveRole);
  const { shift } = useClock();

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  // Below foreman the filter offers the jobs this person has worked, because
  // that is all the photo feed's own RLS will hand back (20260993000000).
  // Asked for only at that rank: a foreman's list is every job, and one more
  // round trip to say so would be waste. `isLoading` is waited on so a role
  // that has not resolved yet does not spend a query as the wrong person.
  const worked = useQuery({
    queryKey: ["myWorkedJobs"],
    queryFn: listMyWorkedJobs,
    enabled: !roleLoading && !isLead,
  });

  const jobCodeById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects.data ?? []) map.set(p.id, p.job_code);
    return map;
  }, [projects.data]);

  const selectedJobCode = projectId ? jobCodeById.get(projectId) ?? null : null;

  /**
   * The options in the job filter.
   *
   * A foreman keeps the full jobs list. An installer gets their worked jobs —
   * unless the server has no `list_my_worked_jobs` yet (`null`, a phone ahead
   * of the migration), in which case the page shows what it showed yesterday
   * rather than an empty picker.
   *
   * A job named in the URL is always kept in the list even when it is not one
   * of theirs: "See it in the gallery" hands this page the job a photo was
   * just filed to, and that job may be one this person has never clocked into.
   * Dropping it would blank the picker while the feed below still shows their
   * own photo of it.
   */
  const options = useMemo<WorkedJob[]>(() => {
    const all: WorkedJob[] = (projects.data ?? []).map((p) => ({
      id: p.id,
      jobCode: p.job_code,
      name: p.name,
    }));
    const base = isLead || worked.data == null ? all : worked.data;
    if (!projectId || base.some((j) => j.id === projectId)) return base;
    const named = all.find((j) => j.id === projectId);
    return named ? [named, ...base] : base;
  }, [isLead, worked.data, projects.data, projectId]);

  const setProject = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("project", id);
    else next.delete("project");
    next.delete("capture");
    setParams(next, { replace: true });
  };

  // An installer landing on the gallery with no job in the URL starts on the
  // job of their open shift — the one they are standing on. Primed once and
  // never again (the ref), so switching the filter back to "All my jobs" is
  // not undone by the next render. Only when that job is really one of theirs:
  // a shift on a job the worked list does not name would select an option the
  // picker cannot show.
  const primedRef = useRef(false);
  const openShiftJob = shift?.project_id ?? null;
  useEffect(() => {
    if (primedRef.current || isLead || roleLoading) return;
    if (projectId || !openShiftJob || !worked.isSuccess) return;
    primedRef.current = true;
    if ((worked.data ?? []).some((j) => j.id === openShiftJob)) {
      const next = new URLSearchParams(params);
      next.set("project", openShiftJob);
      setParams(next, { replace: true });
    }
  }, [
    isLead,
    roleLoading,
    projectId,
    openShiftJob,
    worked.isSuccess,
    worked.data,
    params,
    setParams,
  ]);

  // Keeps the job, drops the capture flag — the same shape setProject uses, and
  // for the same reason: ?capture=1 is a one-shot "open the sheet now" from a
  // deep link, and re-firing it every time somebody switches tabs would open
  // the camera over the list they were trying to read. Replace, not push, so
  // Back still leaves the Photos page rather than walking back through every
  // toggle.
  const setKind = (next: "photo" | "receipt") => {
    const params2 = new URLSearchParams(params);
    if (next === "receipt") params2.set("kind", "receipt");
    else params2.delete("kind");
    params2.delete("capture");
    setParams(params2, { replace: true });
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">
            {kind === "receipt" ? t("photos.kind.receipts") : t("photos.kind.photos")}
          </p>
          <h1>{selectedJobCode ? selectedJobCode : "Recent across all jobs"}</h1>
        </div>
        <BackChip fallback="/" label="Home" />
      </header>

      <PhotoFeed
        projectId={projectId}
        selectedJobCode={selectedJobCode}
        kind={kind}
        initialCapture={initialCapture}
        toolbarExtra={
          <>
            <PhotoKindTabs kind={kind} onChange={setKind} />
            <select
              className="photos-filter"
              value={projectId ?? ""}
              onChange={(e) => setProject(e.target.value)}
              aria-label="Filter by job"
            >
              <option value="">
                {isLead ? t("photos.filter.allJobs") : t("photos.filter.allMyJobs")}
              </option>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.jobCode} — {p.name}
                </option>
              ))}
            </select>
          </>
        }
      />
    </div>
  );
}
