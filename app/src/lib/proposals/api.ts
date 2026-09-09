import { supabase } from "../supabase";
import { isMissingTable } from "../schemaErrors";
import type { Job, Bid, Rate, JobFile, Activity } from "./model";
export async function loadWorkflow(): Promise<{
  available: boolean;
  jobs: Job[];
  bids: Bid[];
  rates: Rate[];
}> {
  const results = await Promise.all([
    supabase
      .from("proposal_jobs")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(500),
    supabase
      .from("proposal_bids")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(2000),
    supabase
      .from("proposal_rates")
      .select("*")
      .order("effective_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);
  for (const r of results)
    if (r.error) {
      if (isMissingTable(r.error))
        return { available: false, jobs: [], bids: [], rates: [] };
      throw r.error;
    }
  return {
    available: true,
    jobs: (results[0].data ?? []) as Job[],
    bids: (results[1].data ?? []) as Bid[],
    rates: (results[2].data ?? []) as Rate[],
  };
}
export async function loadJob(
  jobId: string,
): Promise<{ files: JobFile[]; activity: Activity[] }> {
  const [files, activity] = await Promise.all([
    supabase
      .from("proposal_documents")
      .select("id,job_id,filename,storage_path,kind,bytes,ready,created_at")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false }),
    supabase
      .from("proposal_activity")
      .select("id,job_id,kind,detail,created_at")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  if (files.error) throw files.error;
  if (activity.error) throw activity.error;
  return { files: files.data ?? [], activity: activity.data ?? [] };
}
export async function writeWorkflow(
  action: string,
  data: Record<string, unknown>,
): Promise<{ job: Job; record: JobFile | Bid | null }> {
  const { data: result, error } = await supabase.rpc("proposal_write", {
    p_action: action,
    p_data: data,
  });
  if (error) throw error;
  return result;
}
export async function createJob(
  name: string,
  contractor: string,
  kind: string,
): Promise<Job> {
  const { data, error } = await supabase.rpc("proposal_write", {
    p_action: "create",
    p_data: { name, contractor, kind },
  });
  if (error) throw error;
  return data;
}
export async function uploadJobFile(
  job: Job,
  file: File,
  kind: string,
  existing?: JobFile,
) {
  const started = existing
    ? { job, record: existing }
    : await writeWorkflow("file", {
        job_id: job.id,
        version: job.version,
        id: crypto.randomUUID(),
        filename: file.name,
        kind,
        bytes: file.size,
      });
  const record = started.record as JobFile;
  // Never overwrite a revision's bytes. An interrupted upload may already exist.
  const { error } = await supabase.storage
    .from("proposal-files")
    .upload(record.storage_path, file, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
  if (
    error &&
    error.message !== "The resource already exists" &&
    error.message !== "Resource already exists"
  )
    throw error;
  return writeWorkflow("file_ready", {
    job_id: job.id,
    version: started.job.version,
    id: record.id,
  });
}
export async function openJobFile(file: JobFile) {
  const { data, error } = await supabase.storage
    .from("proposal-files")
    .createSignedUrl(file.storage_path, 120, { download: file.filename });
  if (error) throw error;
  return data.signedUrl;
}
