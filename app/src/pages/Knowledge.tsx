import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { BrainCircuit, FolderUp, Trash2 } from "lucide-react";
import {
  clearKnowledge,
  deactivateKnowledgeDoc,
  deriveTitle,
  ingestKnowledge,
  listKnowledgeDocs,
  type IngestSummary,
  type VaultNote,
} from "../lib/knowledge";
import { EmptyState, QueryError, SkeletonList } from "../components/ui/States";

const NOTE_RE = /\.(md|markdown|mdx|txt)$/i;

async function readNotes(fileList: FileList | null): Promise<VaultNote[]> {
  const files = Array.from(fileList ?? []).filter((f) => NOTE_RE.test(f.name));
  const notes: VaultNote[] = [];
  for (const f of files) {
    const content = await f.text();
    if (!content.trim()) continue;
    const path = f.webkitRelativePath || f.name;
    notes.push({ path, title: deriveTitle(path, content), content });
  }
  return notes;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function Knowledge() {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<IngestSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // webkitdirectory isn't in the React types; set it on the DOM node directly.
  const dirRef = (el: HTMLInputElement | null) => {
    if (el) {
      el.setAttribute("webkitdirectory", "");
      el.setAttribute("directory", "");
    }
  };

  const docs = useQuery({ queryKey: ["knowledgeDocs"], queryFn: listKnowledgeDocs });

  const upload = useMutation({
    mutationFn: async (notes: VaultNote[]) => {
      if (notes.length === 0) throw new Error("No markdown notes found in that selection.");
      setSummary(null);
      setProgress({ done: 0, total: notes.length });
      return ingestKnowledge(notes, {
        replaceMissing: true,
        onProgress: (done, total) => setProgress({ done, total }),
      });
    },
    onSuccess: (result) => {
      setSummary(result);
      setMessage(null);
      setProgress(null);
      void queryClient.invalidateQueries({ queryKey: ["knowledgeDocs"] });
    },
    onError: (e) => {
      setProgress(null);
      setMessage(e instanceof Error ? e.message : String(e));
    },
  });

  const removeDoc = useMutation({
    mutationFn: (id: string) => deactivateKnowledgeDoc(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["knowledgeDocs"] }),
  });

  const clearAll = useMutation({
    mutationFn: () => clearKnowledge(),
    onSuccess: () => {
      setSummary(null);
      void queryClient.invalidateQueries({ queryKey: ["knowledgeDocs"] });
    },
  });

  const busy = upload.isPending;

  const onPick = async (fileList: FileList | null) => {
    setMessage(null);
    const notes = await readNotes(fileList);
    upload.mutate(notes);
  };

  const state = docs.data;
  const ready = state && !state.setupNeeded ? state : null;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting ai-eyebrow">
            <BrainCircuit size={13} /> Infinity AI
          </p>
          <h1>AI Knowledge</h1>
        </div>
        <Link to="/" className="back-chip" aria-label="Home">
          ‹
        </Link>
      </header>

      <p className="muted">
        Upload your Obsidian vault (or a set of Markdown notes) to teach Infinity
        AI your company's playbooks, specs and standards. Everyone's Ask Infinity
        chat then answers from these notes plus live app data, with citations.
        Re-upload any time to refresh — nothing is stored in the app's code, only
        in your own database.
      </p>
      <p className="muted" style={{ fontSize: 12 }}>
        Note contents are sent to OpenAI to build embeddings and answers, and
        stored (text + vectors) in your Supabase. Only upload notes you're
        comfortable sharing that way.
      </p>

      <div className="action-list">
        <label className={`action-btn primary${busy ? " disabled" : ""}`} style={{ cursor: busy ? "default" : "pointer" }}>
          <FolderUp size={16} /> {busy ? "Uploading…" : "Choose vault folder"}
          <input
            ref={dirRef}
            type="file"
            multiple
            style={{ display: "none" }}
            disabled={busy}
            onChange={(e) => {
              void onPick(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        <label className={`action-btn${busy ? " disabled" : ""}`} style={{ cursor: busy ? "default" : "pointer" }}>
          Choose .md files
          <input
            type="file"
            multiple
            accept=".md,.markdown,.mdx,.txt,text/markdown"
            style={{ display: "none" }}
            disabled={busy}
            onChange={(e) => {
              void onPick(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {progress && (
        <p className="muted" aria-live="polite">
          Indexing {progress.done} / {progress.total} notes…
        </p>
      )}
      {summary && (
        <p className="ok" aria-live="polite">
          Indexed {summary.docsAdded + summary.docsUpdated} notes (
          {summary.docsAdded} new, {summary.docsUpdated} updated,{" "}
          {summary.docsUnchanged} unchanged
          {summary.docsRemoved > 0 ? `, ${summary.docsRemoved} removed` : ""}) ·{" "}
          {summary.chunks} chunks.
        </p>
      )}
      {message && <p className="error">{message}</p>}

      <div className="section-head" style={{ marginTop: 18 }}>
        <h2>Indexed notes</h2>
        {ready && ready.docs.length > 0 && (
          <button
            type="button"
            className="link-btn"
            disabled={clearAll.isPending}
            onClick={() => clearAll.mutate()}
          >
            <Trash2 size={13} /> Clear all
          </button>
        )}
      </div>

      {docs.isLoading && <SkeletonList rows={4} />}
      {docs.isError && (
        <QueryError error={docs.error} onRetry={() => docs.refetch()} label="Couldn't load the knowledge base" />
      )}
      {state?.setupNeeded && (
        <EmptyState
          icon={<BrainCircuit size={22} />}
          title="Knowledge base not set up yet"
          message="Once the database has the knowledge store, upload a vault above and your notes will appear here. Until then, Ask Infinity still works from the built-in brain."
        />
      )}
      {ready && ready.docs.length === 0 && (
        <EmptyState
          icon={<FolderUp size={22} />}
          title="No notes indexed yet"
          message="Upload your Obsidian vault to get started."
        />
      )}
      {ready && ready.docs.length > 0 && (
        <>
          <p className="muted" style={{ fontSize: 12 }}>
            {ready.docs.length} notes · {ready.totalChunks} chunks · last refreshed{" "}
            {formatWhen(ready.lastRefreshed)}
          </p>
          <ul className="unit-list">
            {ready.docs.map((d) => (
              <li key={d.id} className="doc-row">
                <div className="doc-main">
                  <strong>{d.title}</strong>
                  <span className="muted doc-path">{d.path}</span>
                </div>
                <span className="muted doc-count">{d.chunkCount} chunks</span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${d.title}`}
                  disabled={removeDoc.isPending}
                  onClick={() => removeDoc.mutate(d.id)}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
