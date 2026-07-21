import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  embed,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";
import { requireCaller } from "../_shared/auth.ts";
import {
  chunkMarkdown,
  deriveTitle,
  hashContent,
} from "../_shared/knowledge.ts";

interface IncomingFile {
  path: string;
  title?: string;
  content: string;
}

// OpenAI accepts a large array per embeddings call; keep batches modest so a
// single request stays well under payload/timeout limits on big notes.
const EMBED_BATCH = 64;

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const unauthorized = await requireCaller(req, cors);
  if (unauthorized) return unauthorized;

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase env not configured");
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const body = await req.json().catch(() => ({}));
    const files: IncomingFile[] = Array.isArray(body.files) ? body.files : [];
    const replaceMissing = Boolean(body.replaceMissing);
    const knownPaths: string[] = Array.isArray(body.knownPaths)
      ? body.knownPaths.map((p: unknown) => String(p)).filter(Boolean)
      : [];
    const createdBy =
      typeof body.createdBy === "string" && body.createdBy ? body.createdBy : null;

    let docsAdded = 0;
    let docsUpdated = 0;
    let docsUnchanged = 0;
    let chunkCount = 0;

    for (const file of files) {
      const path = String(file?.path ?? "").trim();
      const content = String(file?.content ?? "");
      if (!path || !content.trim()) continue;

      const hash = hashContent(content);
      const title = (file.title ?? "").trim() || deriveTitle(path, content);

      const { data: existing, error: exErr } = await supabase
        .from("knowledge_docs")
        .select("id, content_hash, active")
        .eq("source", "vault")
        .eq("path", path)
        .maybeSingle();
      if (exErr) throw exErr;

      // Unchanged (and still active) → skip re-embedding entirely.
      if (existing && existing.content_hash === hash && existing.active) {
        docsUnchanged++;
        continue;
      }

      let docId = existing?.id as string | undefined;
      if (docId) {
        const { error: upErr } = await supabase
          .from("knowledge_docs")
          .update({ title, content_hash: hash, active: true })
          .eq("id", docId);
        if (upErr) throw upErr;
        // Replace this note's chunks wholesale.
        const { error: delErr } = await supabase
          .from("knowledge_chunks")
          .delete()
          .eq("doc_id", docId);
        if (delErr) throw delErr;
        docsUpdated++;
      } else {
        const { data: inserted, error: insErr } = await supabase
          .from("knowledge_docs")
          .insert({
            source: "vault",
            path,
            title,
            content_hash: hash,
            active: true,
            created_by: createdBy,
          })
          .select("id")
          .single();
        if (insErr) throw insErr;
        docId = inserted.id as string;
        docsAdded++;
      }

      const chunks = chunkMarkdown(content);
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        const vectors = await embed(batch.map((c) => c.content));
        const rows = batch.map((c, j) => ({
          doc_id: docId,
          chunk_index: c.index,
          content: c.content,
          token_count: c.tokenCount,
          embedding: vectors[j],
        }));
        const { error: chErr } = await supabase
          .from("knowledge_chunks")
          .insert(rows);
        if (chErr) throw chErr;
        chunkCount += rows.length;
      }
    }

    // Refresh semantics: after the final page, deactivate any vault note whose
    // path wasn't part of this upload (a note removed from the vault).
    let docsRemoved = 0;
    if (replaceMissing && knownPaths.length > 0) {
      const { data: removed, error: rmErr } = await supabase
        .from("knowledge_docs")
        .update({ active: false })
        .eq("source", "vault")
        .eq("active", true)
        .not("path", "in", `(${knownPaths.map((p) => `"${p.replace(/"/g, '""')}"`).join(",")})`)
        .select("id");
      if (rmErr) throw rmErr;
      docsRemoved = removed?.length ?? 0;
    }

    return jsonResponse(
      { ok: true, docsAdded, docsUpdated, docsUnchanged, docsRemoved, chunks: chunkCount },
      200,
      cors,
    );
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});
