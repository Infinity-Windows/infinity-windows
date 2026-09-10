import { supabase } from "../supabase";
import { isMissingFunction } from "../schemaErrors";
import type { Job, Bid, JobFile } from "./model";
export type SharedJob = Pick<
  Job,
  | "id"
  | "name"
  | "address"
  | "city"
  | "state"
  | "kind"
  | "stage"
  | "start_precision"
  | "target_start"
  | "target_end"
  | "confirmed_start"
  | "version"
> & {
  bids: Pick<
    Bid,
    | "id"
    | "number"
    | "revision"
    | "amount"
    | "scope"
    | "submitted_at"
    | "accepted_at"
    | "accepted_amount"
    | "accepted_scope"
  >[];
  files: Pick<JobFile, "id" | "filename" | "storage_path" | "kind" | "bytes">[];
};
export async function partnerWorkflow(): Promise<SharedJob[]> {
  const { data, error } = await supabase.rpc("stg_workflow");
  if (isMissingFunction(error)) return [];
  if (error) throw error;
  return data ?? [];
}
export async function partnerReply(
  job: SharedJob,
  note: string,
  confirm: boolean,
) {
  const { error } = await supabase.rpc("stg_workflow_reply", {
    p_job: job.id,
    p_version: job.version,
    p_note: note,
    p_confirm_date: confirm,
  });
  if (error) throw error;
}
export async function shareJob(
  job: Job,
  email: string,
  bids: string[],
  documents: string[],
  remove = false,
) {
  const { error } = await supabase.rpc("proposal_share", {
    p_job: job.id,
    p_version: job.version,
    p_email: email,
    p_bids: bids,
    p_documents: documents,
    p_remove: remove,
  });
  if (error) throw error;
}
export async function sharedFileUrl(file: SharedJob["files"][number]) {
  const { data, error } = await supabase.storage
    .from("proposal-files")
    .createSignedUrl(file.storage_path, 120, { download: file.filename });
  if (error) throw error;
  return data.signedUrl;
}
