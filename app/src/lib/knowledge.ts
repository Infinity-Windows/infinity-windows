// Client seam for the Infinity AI knowledge base (vault RAG). The pure logic
// (chunking, hashing, retrieval shaping, prompt assembly, the fallback
// decision) lives in the runtime-agnostic shared module so the browser, the
// Deno edge functions and the tests all share one implementation.
import { supabase, supabaseConfigured } from "./supabase";
import {
  deriveTitle,
  type KnowledgeSource,
} from "../../../supabase/functions/_shared/knowledge.ts";

export {
  chunkMarkdown,
  dedupeSources,
  deriveTitle,
  formatSourcesLine,
  hashContent,
  shapeMatches,
  shouldUseLLM,
  type KnowledgeSource,
} from "../../../supabase/functions/_shared/knowledge.ts";

export interface VaultNote {
  path: string;
  title: string;
  content: string;
}

export interface AskResult {
  answer: string;
  sources: KnowledgeSource[];
}

/** Ask the cloud `ask` function for a real, grounded answer. Throws on any
 * failure so the caller can fall back to the bundled offline brain. */
export async function askInfinity(
  question: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
): Promise<AskResult> {
  const { data, error } = await supabase.functions.invoke("ask", {
    body: { question, history },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return {
    answer: String(data?.answer ?? "").trim(),
    sources: Array.isArray(data?.sources) ? (data.sources as KnowledgeSource[]) : [],
  };
}

export interface IngestSummary {
  docsAdded: number;
  docsUpdated: number;
  docsUnchanged: number;
  docsRemoved: number;
  chunks: number;
}

const emptySummary = (): IngestSummary => ({
  docsAdded: 0,
  docsUpdated: 0,
  docsUnchanged: 0,
  docsRemoved: 0,
  chunks: 0,
});

// Page uploads so a big vault never blows a single function invocation's
// payload/time budget: at most this many notes, and this many characters, per
// call. The client keeps calling until the whole vault is sent.
const MAX_FILES_PER_PAGE = 12;
const MAX_CHARS_PER_PAGE = 300_000;

/** Split notes into upload pages bounded by file count and total size. */
export function pageNotes(
  notes: VaultNote[],
  maxFiles = MAX_FILES_PER_PAGE,
  maxChars = MAX_CHARS_PER_PAGE,
): VaultNote[][] {
  const pages: VaultNote[][] = [];
  let current: VaultNote[] = [];
  let chars = 0;
  for (const note of notes) {
    const size = note.content.length;
    const wouldOverflow =
      current.length > 0 && (current.length >= maxFiles || chars + size > maxChars);
    if (wouldOverflow) {
      pages.push(current);
      current = [];
      chars = 0;
    }
    current.push(note);
    chars += size;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

/**
 * Send a vault to the `ingest-knowledge` function, paged. `replaceMissing`
 * (re-upload = refresh) deactivates notes no longer present, finalised after
 * the last page with the full path list.
 */
export async function ingestKnowledge(
  notes: VaultNote[],
  opts: {
    replaceMissing?: boolean;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<IngestSummary> {
  const { data: userData } = await supabase.auth.getUser();
  const createdBy = userData.user?.id ?? null;

  const pages = pageNotes(notes);
  const total = notes.length;
  const summary = emptySummary();
  let done = 0;

  for (const page of pages) {
    const { data, error } = await supabase.functions.invoke("ingest-knowledge", {
      body: { files: page, createdBy },
    });
    if (error) throw error;
    if (data?.error) throw new Error(String(data.error));
    summary.docsAdded += Number(data?.docsAdded ?? 0);
    summary.docsUpdated += Number(data?.docsUpdated ?? 0);
    summary.docsUnchanged += Number(data?.docsUnchanged ?? 0);
    summary.chunks += Number(data?.chunks ?? 0);
    done += page.length;
    opts.onProgress?.(done, total);
  }

  if (opts.replaceMissing) {
    const { data, error } = await supabase.functions.invoke("ingest-knowledge", {
      body: {
        files: [],
        replaceMissing: true,
        knownPaths: notes.map((n) => n.path),
        createdBy,
      },
    });
    if (error) throw error;
    if (data?.error) throw new Error(String(data.error));
    summary.docsRemoved += Number(data?.docsRemoved ?? 0);
  }

  return summary;
}

export interface KnowledgeDoc {
  id: string;
  path: string;
  title: string;
  updatedAt: string;
  chunkCount: number;
}

export interface KnowledgeState {
  /** True when the RAG store (migration / pgvector) isn't applied yet. */
  setupNeeded: boolean;
  docs: KnowledgeDoc[];
  totalChunks: number;
  lastRefreshed: string | null;
}

const SETUP_NEEDED: KnowledgeState = {
  setupNeeded: true,
  docs: [],
  totalChunks: 0,
  lastRefreshed: null,
};

function isMissingRelation(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  const msg = (e?.message ?? "").toLowerCase();
  return (
    e?.code === "42P01" ||
    msg.includes("does not exist") ||
    msg.includes("could not find the table") ||
    msg.includes("schema cache")
  );
}

/** List active indexed notes with per-note chunk counts. Returns a
 * setup-needed state (not an error) when the migration isn't applied. */
export async function listKnowledgeDocs(): Promise<KnowledgeState> {
  if (!supabaseConfigured) return SETUP_NEEDED;
  try {
    const { data: docs, error: docErr } = await supabase
      .from("knowledge_docs")
      .select("id, path, title, updated_at")
      .eq("active", true)
      .order("updated_at", { ascending: false })
      .limit(500);
    if (docErr) throw docErr;

    const { data: chunkRows, error: chunkErr } = await supabase
      .from("knowledge_chunks")
      .select("doc_id")
      .limit(20000);
    if (chunkErr) throw chunkErr;

    const counts = new Map<string, number>();
    for (const row of chunkRows ?? []) {
      const id = String((row as { doc_id: string }).doc_id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const list: KnowledgeDoc[] = (docs ?? []).map((d) => ({
      id: String(d.id),
      path: String(d.path),
      title: String(d.title) || deriveTitle(String(d.path), ""),
      updatedAt: String(d.updated_at),
      chunkCount: counts.get(String(d.id)) ?? 0,
    }));

    return {
      setupNeeded: false,
      docs: list,
      totalChunks: chunkRows?.length ?? 0,
      lastRefreshed: list[0]?.updatedAt ?? null,
    };
  } catch (error) {
    if (isMissingRelation(error)) return SETUP_NEEDED;
    throw error;
  }
}

/** Deactivate one note (hidden from retrieval; chunks kept until re-upload). */
export async function deactivateKnowledgeDoc(id: string): Promise<void> {
  const { error } = await supabase
    .from("knowledge_docs")
    .update({ active: false })
    .eq("id", id);
  if (error) throw error;
}

/** Clear the whole knowledge base from retrieval (deactivate every note). */
export async function clearKnowledge(): Promise<void> {
  const { error } = await supabase
    .from("knowledge_docs")
    .update({ active: false })
    .eq("active", true);
  if (error) throw error;
}
