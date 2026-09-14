import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { JOB_STAGES, getJobStages, getLaborTargets, laborVariance, optionalPositive, saveJobStage, saveLaborTargets, type LaborTarget, type JobStage } from "../../lib/jobExecution";
import { listLaborStatsShifts } from "../../lib/laborStatsApi";
import { summarizeLabor } from "../../lib/laborStats";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { isForemanPlus, isSupervisorPlus } from "../../lib/install/types";
import { formatApiError } from "../../lib/errors";
import "./jobExecution.css";

const hours = (n: number | null | undefined) => n == null ? "Not set" : `${n.toFixed(1)}h`;

function LaborEditor({ projectId, target, close }: { projectId: string; target?: LaborTarget; close: () => void }) {
  const cache = useQueryClient();
  const [projected, setProjected] = useState(target?.projected_hours?.toString() ?? "");
  const [goal, setGoal] = useState(target?.goal_hours?.toString() ?? "");
  const [sqf, setSqf] = useState(target?.square_feet?.toString() ?? "");
  const [reason, setReason] = useState("");
  const [baseRevision] = useState(target?.revision ?? 0);
  const save = useMutation({ mutationFn: () => saveLaborTargets(projectId, {
    projected_hours: optionalPositive(projected), goal_hours: optionalPositive(goal), square_feet: optionalPositive(sqf),
  }, baseRevision, reason), onSuccess: async () => {
    await cache.invalidateQueries({ queryKey: ["jobLaborTargets"] }); close();
  } });
  return <form onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
    <div className="execution-fields">
      <label>Projected man-hours<input type="number" min="0.01" max="9999999" step="0.01" value={projected} onChange={(e) => setProjected(e.target.value)} /></label>
      <label>Foreman goal hours<input type="number" min="0.01" max="9999999" step="0.01" value={goal} onChange={(e) => setGoal(e.target.value)} /></label>
      <label>SQF (optional)<input type="number" min="0.01" max="999999999" step="0.01" value={sqf} onChange={(e) => setSqf(e.target.value)} /></label>
    </div>
    <label>Reason for setting or changing the target<textarea required minLength={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
    {save.isError && <p role="alert">{formatApiError(save.error)}</p>}
    <button disabled={save.isPending} type="submit">{save.isPending ? "Saving…" : "Save labor targets"}</button>{" "}
    <button disabled={save.isPending} type="button" onClick={close}>Cancel</button>
  </form>;
}

export function JobExecutionPanel({ projectId, completed }: { projectId: string; completed: boolean }) {
  const { effectiveRole, isLoading } = useEffectiveRole();
  const allowed = !isLoading && isForemanPlus(effectiveRole);
  const cache = useQueryClient();
  const targets = useQuery({ queryKey: ["jobLaborTargets"], queryFn: getLaborTargets, enabled: allowed });
  const shifts = useQuery({ queryKey: ["laborStatsShifts"], queryFn: listLaborStatsShifts, enabled: allowed });
  const stages = useQuery({ queryKey: ["jobExecutionStages", projectId], queryFn: () => getJobStages(projectId), enabled: allowed });
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<JobStage | undefined>(undefined);
  const [note, setNote] = useState("");
  const target = targets.data?.find((row) => row.project_id === projectId);
  const report = useMemo(() => summarizeLabor((shifts.data ?? []).filter((row) => row.project_id === projectId)), [shifts.data, projectId]);
  const saveStage = useMutation({ mutationFn: () => saveJobStage(projectId, selected!, !selectedStage?.completed, note, selectedStage?.revision ?? 0),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: ["jobExecutionStages", projectId] }); setSelected(null); setNote(""); } });
  if (!allowed) return null;
  const done = JOB_STAGES.filter(([key]) => stages.data?.some((row) => row.stage_key === key && row.completed)).length;
  const current = JOB_STAGES.find(([key]) => !stages.data?.some((row) => row.stage_key === key && row.completed))?.[0];
  const variance = laborVariance(report.totalHours, target?.projected_hours);
  return <>
    <section className="detail-card job-execution" aria-label="Job stages">
      <h2>Job stages</h2>
      {stages.isPending && <p role="status">Loading stages…</p>}
      {stages.isError && <p role="alert">{formatApiError(stages.error)} <button type="button" onClick={() => void stages.refetch()}>Retry stages</button></p>}
      {stages.isSuccess && <>
        <p>{done} of {JOB_STAGES.length} stages complete</p>
        <ol className="execution-stages">{JOB_STAGES.map(([key, label]) => {
          const row = stages.data.find((s) => s.stage_key === key);
          return <li key={key} className={row?.completed ? "done" : current === key ? "current" : ""}>
            <button type="button" aria-pressed={selected === key} onClick={() => { setSelected(key); setSelectedStage(row); setNote(""); saveStage.reset(); }}>
              <span className="stage-dot" aria-hidden="true">{row?.completed ? "✓" : "○"}</span>
              {label}<span className="muted">{row?.completed ? "Complete" : "Not complete"}</span>
            </button>
          </li>;
        })}</ol>
        {selected && <form className="stage-editor" onSubmit={(e) => { e.preventDefault(); saveStage.mutate(); }}>
          <h3>{JOB_STAGES.find(([key]) => key === selected)?.[1]}</h3>
          {selectedStage?.note && <p>Last update: {selectedStage.note}</p>}
          <label>{selectedStage?.completed ? "Reason for reopening" : "Completion note / evidence reference"}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} required minLength={3} maxLength={2000} /></label>
          {saveStage.isError && <p role="alert">{formatApiError(saveStage.error)}</p>}
          <button type="submit" disabled={saveStage.isPending}>{selectedStage?.completed ? "Reopen stage" : "Mark stage complete"}</button>{" "}
          <button type="button" disabled={saveStage.isPending} onClick={() => setSelected(null)}>Cancel</button>
        </form>}
      </>}
    </section>
    <section className="detail-card job-execution" aria-label="Job labor target">
      <h2>Job labor target</h2>
      <p className="muted">All job labor counts, including travel, warehouse work, and corrections. Recorded hours include submitted and approved time, less breaks.</p>
      {(targets.isPending || shifts.isPending) && <p role="status">Loading job hours…</p>}
      {(targets.isError || shifts.isError) && <p role="alert">{formatApiError(targets.error ?? shifts.error)} <button type="button" onClick={() => { void targets.refetch(); void shifts.refetch(); }}>Retry job hours</button></p>}
      {targets.isSuccess && shifts.isSuccess && <>
        <dl className="execution-fields"><div><dt>Projected</dt><dd>{hours(target?.projected_hours)}</dd></div>
          <div><dt>Foreman goal</dt><dd>{hours(target?.goal_hours)}</dd></div>
          <div><dt>Recorded</dt><dd>{hours(report.totalHours)}</dd></div></dl>
        {target?.goal_hours != null && <>
          <progress aria-label="Labor hours used toward goal" max={target.goal_hours} value={Math.min(report.totalHours, target.goal_hours)} />
          <p>{hours(Math.abs(target.goal_hours - report.totalHours))} {report.totalHours <= target.goal_hours ? "remaining to goal" : "over goal"}</p>
        </>}
        {completed && variance !== null && <p>{Math.abs(variance).toFixed(1)}% {variance <= 0 ? "under" : "over"} projected hours (recorded time).</p>}
        <p className="muted">{report.workers.reduce((n, p) => n + p.openShifts, 0)} open shifts · {report.workers.reduce((n, p) => n + p.needsReview, 0)} shifts needing review. Bonus points are not awarded automatically.</p>
        {isSupervisorPlus(effectiveRole) && (editing ? <LaborEditor key={projectId} projectId={projectId} target={target} close={() => setEditing(false)} /> : <button type="button" onClick={() => setEditing(true)}>Set / edit labor targets</button>)}
      </>}
    </section>
  </>;
}
