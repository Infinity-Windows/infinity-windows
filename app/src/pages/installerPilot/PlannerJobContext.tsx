import { useQuery } from "@tanstack/react-query";
import { getJobStages, JOB_STAGES } from "../../lib/jobExecution";

export function PlannerJobContext({ projectId }: { projectId: string }) {
  const stages = useQuery({ queryKey: ["jobExecutionStages", projectId], queryFn: () => getJobStages(projectId) });
  const [currentStage, nextStage] = JOB_STAGES.filter(([key]) => !stages.data?.some(row => row.stage_key === key && row.completed));
  return <p className="jp-job-context" aria-label="Job planning status">
    {stages.isPending ? "Loading job stage…" : stages.isError ? "Job stage unavailable" :
      currentStage ? <>Stage: <strong>{currentStage[1]}</strong>
        {nextStage && <> <span className="jp-stage-arrow" aria-label="then">&#8594;</span> {nextStage[1]}</>}
      </> : "All job stages complete"}
  </p>;
}
