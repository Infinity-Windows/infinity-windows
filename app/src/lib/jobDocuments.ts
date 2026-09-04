// A job's paperwork that is not a planset (Monday files, F6).
//
// The app has always had exactly two slots for a job's PDFs — the building plan
// and the specs — and anything else the office held had to be forced into one
// of them or left on Monday where the crew cannot reach it. The quote, the
// signed order, the ironwork sheet: those are documents, not drawings, and
// nothing should try to extract a window schedule out of them.
//
// READ-ONLY FROM THE CLIENT, in this version. Every row is written by the pull
// inside monday-sync, on the service role, which is the only thing that can
// prove a file really is attached to the job's Monday item. The table carries no
// client INSERT grant at all, so an "attach a document" button is a deliberate
// next step and cannot arrive by accident.

import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";

export interface JobDocument {
  id: string;
  project_id: string;
  name: string;
  storage_path: string;
  size_bytes: number | null;
  content_type: string | null;
  source: "monday" | "upload";
  source_asset_id: string | null;
  created_by: string | null;
  created_at: string;
}

/**
 * This job's documents, newest first.
 *
 * Empty rather than an error when the table is not there yet: a phone running
 * ahead of the migration must still be able to open the job.
 */
export async function listJobDocuments(projectId: string): Promise<JobDocument[]> {
  const { data, error } = await supabase
    .from("project_documents")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingTable(error, "project_documents")) return [];
    throw error;
  }
  return (data ?? []) as JobDocument[];
}

/** The asset ids already on this job as documents — half the "new on Monday" diff. */
export async function jobDocumentAssetIds(projectId: string): Promise<string[]> {
  const docs = await listJobDocuments(projectId);
  return docs
    .map((d) => d.source_asset_id)
    .filter((id): id is string => typeof id === "string" && id !== "");
}

/**
 * A link that opens the file, good for ten minutes.
 *
 * The bucket is private and stays private: a job document can be a signed
 * order with a price on it, so there is no public URL to hand out and every
 * open mints its own short-lived link.
 */
export async function jobDocumentSignedUrl(doc: JobDocument): Promise<string> {
  const { data, error } = await supabase.storage
    .from("job-documents")
    .createSignedUrl(doc.storage_path, 600);
  if (error) throw error;
  return data.signedUrl;
}
