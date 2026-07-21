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

/**
 * A Supabase Edge Function non-2xx surfaces as a generic FunctionsHttpError
 * whose real message lives in the (unparsed) Response on `.context`. Pull our
 * clear `{ error }` body out so wrong-PIN / role errors reach the UI verbatim.
 */
async function functionError(error: unknown): Promise<Error> {
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const body = await ctx.json();
      if (body?.error) return new Error(String(body.error));
    } catch {
      // fall through to the generic message
    }
  }
  return error instanceof Error ? error : new Error(String(error));
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
 * Send a vault to the `ingest-knowledge` function, paged. Every call is
 * PIN-gated server-side, so the owner-set vault `pin` is threaded into each
 * request. `replaceMissing` (re-upload = refresh) deactivates notes no longer
 * present, finalised after the last page with the full path list. Pass an
 * explicit `knownPaths` (auto-sync) when the `notes` you send are only the
 * changed/added subset but removal should be scoped to the full scanned set.
 */
export async function ingestKnowledge(
  notes: VaultNote[],
  opts: {
    pin: string;
    replaceMissing?: boolean;
    knownPaths?: string[];
    onProgress?: (done: number, total: number) => void;
  },
): Promise<IngestSummary> {
  const { pin } = opts;
  const { data: userData } = await supabase.auth.getUser();
  const createdBy = userData.user?.id ?? null;

  const pages = pageNotes(notes);
  const total = notes.length;
  const summary = emptySummary();
  let done = 0;

  for (const page of pages) {
    const { data, error } = await supabase.functions.invoke("ingest-knowledge", {
      body: { files: page, createdBy, pin },
    });
    if (error) throw await functionError(error);
    if (data?.error) throw new Error(String(data.error));
    summary.docsAdded += Number(data?.docsAdded ?? 0);
    summary.docsUpdated += Number(data?.docsUpdated ?? 0);
    summary.docsUnchanged += Number(data?.docsUnchanged ?? 0);
    summary.chunks += Number(data?.chunks ?? 0);
    done += page.length;
    opts.onProgress?.(done, total);
  }

  if (opts.replaceMissing) {
    const knownPaths = opts.knownPaths ?? notes.map((n) => n.path);
    const { data, error } = await supabase.functions.invoke("ingest-knowledge", {
      body: {
        files: [],
        replaceMissing: true,
        knownPaths,
        createdBy,
        pin,
      },
    });
    if (error) throw await functionError(error);
    if (data?.error) throw new Error(String(data.error));
    summary.docsRemoved += Number(data?.docsRemoved ?? 0);
  }

  return summary;
}

export interface KnowledgeDoc {
  id: string;
  path: string;
  title: string;
  /** Server-computed content hash — lets auto-sync diff without re-uploading. */
  contentHash: string;
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
      .select("id, path, title, content_hash, updated_at")
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
      contentHash: String((d as { content_hash?: unknown }).content_hash ?? ""),
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

/**
 * Deactivate one note (hidden from retrieval; chunks kept until re-upload).
 * PIN-gated: routed through the `ingest-knowledge` function so it enforces the
 * owner-set vault PIN + supervisor+ role rather than writing directly.
 */
export async function deactivateKnowledgeDoc(id: string, pin: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke("ingest-knowledge", {
    body: { action: "deactivate", docId: id, pin },
  });
  if (error) throw await functionError(error);
  if (data?.error) throw new Error(String(data.error));
}

/** Clear the whole knowledge base from retrieval (deactivate every note). */
export async function clearKnowledge(pin: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke("ingest-knowledge", {
    body: { action: "clear", pin },
  });
  if (error) throw await functionError(error);
  if (data?.error) throw new Error(String(data.error));
}

export interface VaultPinStatus {
  /** False when the migration/RPC isn't applied yet (treat as "no PIN"). */
  available: boolean;
  pinSet: boolean;
}

/**
 * Whether a vault PIN exists — via the boolean-only `vault_pin_is_set` RPC so
 * the hash never reaches the client. Degrades to available:false (owner setup
 * state) when the migration hasn't been applied.
 */
export async function getVaultPinStatus(): Promise<VaultPinStatus> {
  if (!supabaseConfigured) return { available: false, pinSet: false };
  const { data, error } = await supabase.rpc("vault_pin_is_set");
  if (error) {
    if (isMissingRelation(error) || (error as { code?: string }).code === "PGRST202") {
      return { available: false, pinSet: false };
    }
    // Unknown error → don't crash the page; behave as not-yet-configured.
    return { available: false, pinSet: false };
  }
  return { available: true, pinSet: Boolean(data) };
}

/** Owner-only: set or change the shared vault PIN (via the `vault-config` fn). */
export async function setVaultPin(args: {
  newPin: string;
  currentPin?: string;
}): Promise<void> {
  const { data, error } = await supabase.functions.invoke("vault-config", {
    body: { action: "set", newPin: args.newPin, currentPin: args.currentPin ?? "" },
  });
  if (error) throw await functionError(error);
  if (data?.error) throw new Error(String(data.error));
}
