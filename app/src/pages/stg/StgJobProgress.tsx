// Wave S, S4: the STG "Job progress" tab — one card per granted job. Reuses
// the app's existing .databar progress-bar CSS (see DataHub.tsx's own local
// Bar helper for the same pattern) rather than inventing new styling.
import { useQuery } from "@tanstack/react-query";
import { QueryError, SkeletonList, EmptyState } from "../../components/ui/States";
import { stgJobList, type StgJob } from "../../lib/stg";
import { formatLogDateLabel } from "../../lib/dailyLogDay";

function windowLabel(job: StgJob): string | null {
  if (!job.window_start && !job.window_end) return null;
  if (job.window_start && job.window_end && job.window_start !== job.window_end) {
    return `${formatLogDateLabel(job.window_start)} – ${formatLogDateLabel(job.window_end)}`;
  }
  return formatLogDateLabel(job.window_start ?? job.window_end!);
}

function JobCard({ job }: { job: StgJob }) {
  const win = windowLabel(job);
  return (
    <div className="find-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
      <div className="row-between">
        <p style={{ margin: 0, fontWeight: 650 }}>{job.name}</p>
        <span className="muted" style={{ fontSize: 12.5 }}>{job.job_code}</span>
      </div>
      <div className="databar-row" style={{ padding: 0 }}>
        <div className="databar" style={{ flex: 1 }}>
          <span style={{ width: `${Math.max(0, Math.min(100, job.progress_percent))}%` }} />
        </div>
        <span className="bar-num">{job.progress_percent}%</span>
      </div>
      {win && (
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          Install window: {win}
        </p>
      )}
    </div>
  );
}

export function StgJobProgress() {
  const jobs = useQuery({ queryKey: ["stgJobList"], queryFn: stgJobList });

  if (jobs.isLoading) return <SkeletonList rows={3} />;
  if (jobs.isError) return <QueryError error={jobs.error} onRetry={() => jobs.refetch()} />;

  // `?? []` rather than trusting isSuccess/a non-null assertion: a screen
  // that briefly has no data to show should render empty, never crash the
  // whole /stg shell (CLAUDE.md's own house rule — degrade, don't white-screen).
  const list = jobs.data ?? [];
  if (list.length === 0) {
    return (
      <EmptyState
        title="No jobs yet"
        message="Once a job is shared with you, it shows up here."
      />
    );
  }

  return (
    <div className="unit-list work-list" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {list.map((job) => (
        <JobCard key={job.id} job={job} />
      ))}
    </div>
  );
}
