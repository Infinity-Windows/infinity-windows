// Runtime-agnostic RAG helpers shared by the Edge Functions (Deno), the web
// client (Vite), and the vitest suite. This file intentionally has NO imports
// and touches NO Deno / DOM / Node globals, so it type-checks and runs
// identically in every environment and stays the single source of truth for
// chunking, hashing, retrieval shaping and prompt assembly.

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMS = 1536;

export interface KnowledgeChunk {
  index: number;
  content: string;
  tokenCount: number;
}

export interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

export interface RetrievedChunk {
  title: string;
  path: string;
  content: string;
  similarity: number;
}

export interface KnowledgeSource {
  title: string;
  path: string;
}

/**
 * Rough token estimate. Real tokenizers are model-specific and unavailable in
 * every runtime; ~4 characters per token is the standard heuristic and is
 * good enough to keep chunks safely under a hard token ceiling.
 */
export function estimateTokens(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  return Math.ceil(t.length / 4);
}

/**
 * Stable, dependency-free content hash (FNV-1a, 32-bit) used purely for
 * change-detection: if a re-uploaded note hashes to the same value we skip
 * re-embedding it. Not a cryptographic hash — collisions are astronomically
 * unlikely for text but this is never used for security.
 */
export function hashContent(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** First markdown H1 wins; otherwise the file name without its extension. */
export function deriveTitle(path: string, content: string): string {
  const h1 = content.match(/^\s{0,3}#\s+(.+?)\s*$/m);
  if (h1) return h1[1].trim();
  const base = (path.split("/").pop() ?? path).trim();
  const stripped = base.replace(/\.(md|markdown|mdx|txt)$/i, "").trim();
  return stripped || base || "Untitled note";
}

/**
 * Split markdown into token-bounded, overlapping chunks with a stable order.
 * Whitespace is normalised to single spaces (embeddings are semantic, not
 * layout-sensitive) but no words are dropped. Each chunk's estimated token
 * count is kept at or below `maxTokens`, and consecutive chunks share roughly
 * `overlapTokens` of trailing context so answers don't get cut at a boundary.
 */
export function chunkMarkdown(
  text: string,
  opts: ChunkOptions = {},
): KnowledgeChunk[] {
  const maxTokens = Math.max(1, Math.floor(opts.maxTokens ?? 800));
  const overlapTokens = Math.max(
    0,
    Math.min(Math.floor(opts.overlapTokens ?? 100), maxTokens - 1),
  );

  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return [];

  const wordTokens = (w: string): number => Math.max(1, estimateTokens(w + " "));

  const chunks: KnowledgeChunk[] = [];
  let start = 0;
  let index = 0;

  while (start < words.length) {
    let end = start;
    let tokens = 0;
    while (end < words.length) {
      const t = wordTokens(words[end]);
      // Always take at least one word, even if a single word overflows.
      if (tokens + t > maxTokens && end > start) break;
      tokens += t;
      end++;
    }

    const content = words.slice(start, end).join(" ");
    chunks.push({ index, content, tokenCount: estimateTokens(content) });
    index++;

    if (end >= words.length) break;

    // Step back so the next chunk repeats ~overlapTokens of trailing context.
    let back = 0;
    let k = end - 1;
    while (k > start && back < overlapTokens) {
      back += wordTokens(words[k]);
      k--;
    }
    start = Math.max(k + 1, start + 1);
  }

  return chunks;
}

/**
 * Normalise raw `match_knowledge_chunks` rows (which may use snake_case or
 * doc_ prefixes depending on the RPC shape) into a clean, similarity-sorted
 * list, dropping empty content and results below `minSimilarity`.
 */
export function shapeMatches(
  rows: unknown,
  opts: { minSimilarity?: number } = {},
): RetrievedChunk[] {
  const min = opts.minSimilarity ?? 0;
  const list = Array.isArray(rows) ? rows : [];
  return list
    .map((raw): RetrievedChunk => {
      const r = (raw ?? {}) as Record<string, unknown>;
      return {
        title: String(r.title ?? r.doc_title ?? "").trim(),
        path: String(r.path ?? r.doc_path ?? "").trim(),
        content: String(r.content ?? "").trim(),
        similarity: Number(r.similarity ?? 0),
      };
    })
    .filter(
      (r) =>
        r.content.length > 0 &&
        Number.isFinite(r.similarity) &&
        r.similarity >= min,
    )
    .sort((a, b) => b.similarity - a.similarity);
}

/**
 * Collapse retrieved chunks to a stable, de-duplicated list of source notes
 * (keyed by path, falling back to title), preserving first-seen order so the
 * citation list mirrors retrieval relevance.
 */
export function dedupeSources(
  chunks: Array<{ title?: string; path?: string }>,
): KnowledgeSource[] {
  const seen = new Set<string>();
  const out: KnowledgeSource[] = [];
  for (const c of chunks) {
    const title = (c.title ?? "").trim();
    const path = (c.path ?? "").trim();
    const label = title || path || "Untitled note";
    const key = (path || title).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ title: label, path });
  }
  return out;
}

/** One-line, human citation from a list of sources ("Sources: A, B"). */
export function formatSourcesLine(sources: KnowledgeSource[]): string {
  const titles = dedupeSources(sources).map((s) => s.title);
  if (titles.length === 0) return "";
  return `Sources: ${titles.join(", ")}`;
}

/** Compact live-app-data context passed alongside the vault notes.
 *
 * IMPORTANT: every block here is already ROLE-FILTERED upstream (in the `ask`
 * function's `loadLiveContext`, which runs on the RLS-bypassing service-role
 * key). A block being present means the asking user's role is allowed to see it;
 * `buildContextBlock` never re-checks the role, it just renders what it's given.
 */
export interface LiveContext {
  /** The asking user's role (installer/foreman/supervisor/owner), for labelling. */
  role?: string;
  /** Role-filtered app guide (pre-rendered "what each tab is + how to use it"). */
  appGuide?: string;
  projects?: Array<{ name?: string; job_code?: string; status?: string }>;
  schedule?: Array<{
    project?: string;
    start_date?: string;
    end_date?: string;
    start_time?: string | null;
  }>;
  windowTypes?: Array<{ type_code?: string; name?: string; n_installs?: number }>;
  /** The asking user's own assigned openings (windows/doors) + warehouse location.
   * All roles. Answers "what am I assigned and where are the units?" */
  assignments?: Array<{
    /** blue = window, green = door (from window_types.category / opening code). */
    kind?: "window" | "door";
    code?: string;
    label?: string | null;
    status?: string;
    job?: string;
    /** The physical unit's license-plate id, when a unit is assigned. */
    unit?: string | null;
    /** Where the unit physically is: warehouse slot address, or on-truck/installed. */
    location?: string | null;
  }>;
  /** Currently-open issues company-wide (most recent first, capped upstream). */
  issues?: Array<{
    job?: string;
    kind?: string;
    urgency?: string;
    note?: string | null;
    ageDays?: number;
  }>;
  /** Compact stock snapshot: overall buckets + top on-hand types + outstanding supplies. */
  inventory?: {
    onHand?: number;
    staged?: number;
    damaged?: number;
    inbound?: number;
    topOnHand?: Array<{ type_code?: string; name?: string; count?: number }>;
    /** Where stock lives: top warehouse slots by on-hand count. */
    byLocation?: Array<{ address?: string; zone?: string; count?: number }>;
    /** Units staged for a job, grouped by job (staging bays). */
    stagedForJobs?: Array<{ job?: string; count?: number }>;
    supplies?: Array<{ name?: string; qty?: number; status?: string }>;
  };
  /** Crew/job schedule (who's scheduled where). Foreman+ only. */
  crewSchedule?: Array<{
    job?: string;
    start_date?: string;
    end_date?: string;
    start_time?: string | null;
    crew?: string[];
  }>;
  /** Job costing / margins. Management-only (supervisor+) — never populated for
   * installer/foreman. When present it's safe to discuss for the asking user. */
  financials?: {
    jobs?: Array<{
      job?: string;
      bid?: number;
      costs?: number;
      marginPct?: number;
      targetMarginPct?: number;
    }>;
    totalBid?: number;
    totalCosts?: number;
  };
  /** Recent per-job chat, scoped to jobs the asking user is on (most recent first). */
  chat?: Array<{
    job?: string;
    sender?: string;
    body?: string;
    when?: string;
  }>;
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Deterministic "$1,234" money formatting (locale-independent for stable output). */
function money(n: number): string {
  const rounded = Math.round(n);
  const sign = rounded < 0 ? "-" : "";
  const digits = Math.abs(rounded)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${digits}`;
}

/**
 * Assemble the grounding context block: company notes first (each labelled by
 * its note title so the model can cite it), then a compact snapshot of live
 * app data. Chunk bodies are capped so a few long notes can't blow the prompt.
 */
export function buildContextBlock(
  chunks: RetrievedChunk[],
  live: LiveContext = {},
): string {
  const sections: string[] = [];

  if (chunks.length > 0) {
    const notes = chunks
      .map(
        (c, i) =>
          `[Note ${i + 1}: ${c.title || c.path || "Untitled note"}]\n${truncate(c.content, 1200)}`,
      )
      .join("\n\n");
    sections.push(`## Company notes (from the Obsidian vault)\n${notes}`);
  }

  // Role-aware app guide: only the tabs this user's role can reach (already
  // filtered upstream). Lets the AI walk the user through the app accurately.
  const guide = (live.appGuide ?? "").trim();
  if (guide) {
    const roleLabel = live.role ? ` for a ${live.role}` : "";
    sections.push(
      `## App guide — tabs you can use${roleLabel} (describe these when asked how to use the app)\n${guide}`,
    );
  }

  const live_lines: string[] = [];
  const projects = live.projects ?? [];
  if (projects.length > 0) {
    live_lines.push(
      `Active projects: ${projects
        .slice(0, 25)
        .map((p) => [p.job_code, p.name].filter(Boolean).join(" ").trim() || "job")
        .join("; ")}`,
    );
  }
  const schedule = live.schedule ?? [];
  if (schedule.length > 0) {
    live_lines.push(
      `Your upcoming schedule: ${schedule
        .slice(0, 15)
        .map((s) => {
          const when = [s.start_date, s.end_date].filter(Boolean).join("→");
          const time = s.start_time ? ` ${s.start_time}` : "";
          return `${s.project ?? "job"} (${when}${time})`;
        })
        .join("; ")}`,
    );
  }
  const assignments = live.assignments ?? [];
  if (assignments.length > 0) {
    live_lines.push(
      `Your assigned windows/doors (and where the unit is): ${assignments
        .slice(0, 30)
        .map((a) => {
          const kind = a.kind === "door" ? "door" : "window";
          const code = a.code ?? "opening";
          const where = a.label ? ` (${truncate(String(a.label), 40)})` : "";
          const job = a.job ? ` on ${a.job}` : "";
          const status = a.status ? ` [${a.status}]` : "";
          const unit = a.unit ? ` unit ${a.unit}` : "";
          const loc = a.location ? ` @ ${a.location}` : "";
          return `${code}${where} ${kind}${job}${status}${unit}${loc}`.trim();
        })
        .join("; ")}`,
    );
  }

  const types = live.windowTypes ?? [];
  if (types.length > 0) {
    live_lines.push(
      `Window catalog (most-installed): ${types
        .slice(0, 20)
        .map((t) => [t.type_code, t.name].filter(Boolean).join(" ").trim())
        .filter(Boolean)
        .join("; ")}`,
    );
  }

  const crewSchedule = live.crewSchedule ?? [];
  if (crewSchedule.length > 0) {
    live_lines.push(
      `Crew schedule (who's scheduled where): ${crewSchedule
        .slice(0, 20)
        .map((s) => {
          const when = [s.start_date, s.end_date].filter(Boolean).join("→");
          const time = s.start_time ? ` ${s.start_time}` : "";
          const crew =
            s.crew && s.crew.length > 0 ? ` — ${s.crew.slice(0, 8).join(", ")}` : "";
          return `${s.job ?? "job"} (${when}${time})${crew}`;
        })
        .join("; ")}`,
    );
  }

  const issues = live.issues ?? [];
  if (issues.length > 0) {
    live_lines.push(
      `Open issues: ${issues
        .slice(0, 20)
        .map((i) => {
          const mark =
            i.urgency === "emergency" ? "!!! " : i.urgency === "urgent" ? "! " : "";
          const kind = (i.kind ?? "issue").replace(/_/g, " ");
          const note = i.note ? ` — ${truncate(String(i.note), 120)}` : "";
          const age =
            typeof i.ageDays === "number"
              ? ` (${i.ageDays === 0 ? "today" : `${i.ageDays}d old`})`
              : "";
          return `${mark}${kind} on ${i.job ?? "job"}${note}${age}`;
        })
        .join("; ")}`,
    );
  }

  const inv = live.inventory;
  if (inv) {
    const buckets = [
      typeof inv.onHand === "number" ? `${inv.onHand} on hand` : "",
      typeof inv.staged === "number" ? `${inv.staged} staged` : "",
      typeof inv.damaged === "number" ? `${inv.damaged} damaged` : "",
      typeof inv.inbound === "number" ? `${inv.inbound} inbound` : "",
    ].filter(Boolean);
    const parts: string[] = [];
    if (buckets.length > 0) parts.push(buckets.join(", "));
    const top = inv.topOnHand ?? [];
    if (top.length > 0) {
      parts.push(
        `top on hand by type: ${top
          .slice(0, 15)
          .map(
            (t) =>
              `${[t.type_code, t.name].filter(Boolean).join(" ").trim() || "type"}×${t.count ?? 0}`,
          )
          .join("; ")}`,
      );
    }
    const byLocation = inv.byLocation ?? [];
    if (byLocation.length > 0) {
      parts.push(
        `stock by warehouse slot: ${byLocation
          .slice(0, 15)
          .map((l) => `${l.address ?? "slot"}×${l.count ?? 0}`)
          .join("; ")}`,
      );
    }
    const stagedForJobs = inv.stagedForJobs ?? [];
    if (stagedForJobs.length > 0) {
      parts.push(
        `staged for jobs: ${stagedForJobs
          .slice(0, 10)
          .map((s) => `${s.job ?? "job"}×${s.count ?? 0}`)
          .join("; ")}`,
      );
    }
    const supplies = inv.supplies ?? [];
    if (supplies.length > 0) {
      parts.push(
        `supplies outstanding: ${supplies
          .slice(0, 10)
          .map(
            (s) =>
              `${s.name ?? "supply"}${typeof s.qty === "number" ? ` ×${s.qty}` : ""}${s.status ? ` (${s.status})` : ""}`,
          )
          .join("; ")}`,
      );
    }
    if (parts.length > 0) live_lines.push(`Inventory: ${parts.join(". ")}`);
  }

  // Financials are management-only: this block is only ever populated upstream
  // for supervisor+ (never installer/foreman). Present ⇒ safe to discuss.
  const fin = live.financials;
  if (fin) {
    const parts: string[] = [];
    if (typeof fin.totalBid === "number" || typeof fin.totalCosts === "number") {
      const totals = [
        typeof fin.totalBid === "number" ? `${money(fin.totalBid)} bid` : "",
        typeof fin.totalCosts === "number" ? `${money(fin.totalCosts)} costs to date` : "",
      ].filter(Boolean);
      if (totals.length > 0) parts.push(`active jobs: ${totals.join(", ")}`);
    }
    const jobs = fin.jobs ?? [];
    if (jobs.length > 0) {
      parts.push(
        `by job: ${jobs
          .slice(0, 12)
          .map((j) => {
            const bid = typeof j.bid === "number" ? `${money(j.bid)} bid` : "";
            const costs = typeof j.costs === "number" ? `${money(j.costs)} costs` : "";
            const margin =
              typeof j.marginPct === "number" ? `${Math.round(j.marginPct)}% margin` : "";
            const target =
              typeof j.targetMarginPct === "number"
                ? `target ${Math.round(j.targetMarginPct)}%`
                : "";
            const bits = [bid, costs, margin, target].filter(Boolean).join(", ");
            return `${j.job ?? "job"}${bits ? ` (${bits})` : ""}`;
          })
          .join("; ")}`,
      );
    }
    if (parts.length > 0) {
      live_lines.push(`Financials (management-only): ${parts.join(". ")}`);
    }
  }

  const chat = live.chat ?? [];
  if (chat.length > 0) {
    live_lines.push(
      `Recent job chat (most recent first): ${chat
        .slice(0, 15)
        .map(
          (m) =>
            `[${m.job ?? "job"}] ${m.sender ?? "someone"}: ${truncate(String(m.body ?? ""), 120)}`,
        )
        .join(" | ")}`,
    );
  }

  if (live_lines.length > 0) {
    sections.push(`## Live app data\n${live_lines.join("\n")}`);
  }

  return sections.join("\n\n").trim();
}

export const ASK_SYSTEM_PROMPT =
  "You are Infinity AI, the assistant for a windows-installation company. " +
  "Answer using ONLY the provided company notes and app data. The app data may " +
  "include an app guide (what each tab is and how to use it), active projects, " +
  "schedules, the user's assigned windows/doors and where those units are, " +
  "inventory/stock and warehouse locations, crew schedules, open issues, and " +
  "recent job chat — use it to answer real-time operational and how-to questions. " +
  "CRITICAL ACCESS RULE: the context you are given has ALREADY been filtered to " +
  "exactly what this user's role is allowed to see. Treat it as the complete set " +
  "of what they may know. Do NOT speculate about, infer, or reveal data that was " +
  "not provided — especially financials (costs, bids, pay, margins, pricing), " +
  "restricted tabs, or other crews' data. If something isn't in the context, it " +
  "is either not available or not something this user is permitted to see: say " +
  "you don't have that (and, when it's a permissions matter, that it may be " +
  "restricted to management) rather than guessing. Never invent numbers, " +
  "locations, names, or details you weren't given. When asked how to use the " +
  "app, describe only the tabs listed in the app guide. If the answer isn't in " +
  "the context, suggest where to look (a person, a page in the app, or which " +
  "note to add). Be concise and practical — you're talking to installers and " +
  "office crew in the field. When you use a company note, cite its title.";

/** The user turn: the question plus the grounding context. */
export function buildAskUserMessage(question: string, contextBlock: string): string {
  const q = question.trim();
  const ctx = contextBlock.trim();
  if (!ctx) {
    return (
      `Question:\n${q}\n\n` +
      "Context: (no company notes or app data are available yet — answer only " +
      "if it's general company-agnostic guidance, otherwise say the knowledge " +
      "base hasn't been set up.)"
    );
  }
  return `Question:\n${q}\n\nContext you may use:\n${ctx}`;
}

/**
 * The client's use-the-LLM-vs-local-brain decision. The smarter cloud answer
 * needs network + a configured Supabase; otherwise the chat falls back to the
 * bundled offline brain so it never goes dark.
 */
export function shouldUseLLM(opts: {
  online: boolean;
  supabaseConfigured: boolean;
}): boolean {
  return Boolean(opts.online && opts.supabaseConfigured);
}
