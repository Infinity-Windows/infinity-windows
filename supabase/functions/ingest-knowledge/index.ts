import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  embed,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";
import { verifyCaller } from "../_shared/auth.ts";
import {
  chunkMarkdown,
  deriveTitle,
  hashContent,
} from "../_shared/knowledge.ts";
import { roleCanManageVault } from "../_shared/vaultGate.ts";
import { verifyPin } from "../_shared/pin.ts";
import {
  notifyOwnersOfSpend,
  reserveAiSpend,
  settleAiSpend,
} from "../_shared/spendGuard.ts";

interface IncomingFile {
  path: string;
  title?: string;
  content: string;
}

type ServiceClient = ReturnType<typeof createClient>;

// OpenAI accepts a large array per embeddings call; keep batches modest so a
// single request stays well under payload/timeout limits on big notes.
const EMBED_BATCH = 64;

/** Caller's role from the profiles table (source of truth for role gating). */
async function profileRole(
  supabase: ServiceClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (error) return null;
  return (data?.role as string | undefined) ?? null;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const auth = await verifyCaller(req);
  if (auth.status === "unauthorized") {
    return jsonResponse({ error: "unauthorized" }, 401, cors);
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase env not configured");
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "ingest");

    // --- Gate every mutation: supervisor+ role AND the correct vault PIN. ---
    const userId = auth.status === "ok" ? auth.user.id : null;
    const role = userId ? await profileRole(supabase, userId) : null;
    if (!roleCanManageVault(role)) {
      return jsonResponse(
        { error: "Only supervisors and owners can manage the AI vault." },
        403,
        cors,
      );
    }

    const { data: cfg } = await supabase
      .from("vault_config")
      .select("pin_hash, pin_salt, pin_iterations")
      .eq("id", 1)
      .maybeSingle();
    const pinSet = Boolean(cfg?.pin_hash && cfg.pin_salt && cfg.pin_iterations);
    if (!pinSet) {
      return jsonResponse(
        {
          error:
            "No vault PIN is set yet. Ask an owner to set the vault PIN before adding notes.",
        },
        403,
        cors,
      );
    }
    const pin = String(body?.pin ?? "");
    const pinOk = await verifyPin(
      pin,
      cfg!.pin_salt as string,
      cfg!.pin_iterations as number,
      cfg!.pin_hash as string,
    );
    if (!pinOk) {
      return jsonResponse({ error: "Vault PIN is incorrect." }, 403, cors);
    }

    // --- Mutating vault actions (all PIN-gated above). ---
    if (action === "deactivate") {
      const docId = String(body?.docId ?? "").trim();
      if (!docId) return jsonResponse({ error: "docId is required" }, 400, cors);
      const { data: removed, error: rmErr } = await supabase
        .from("knowledge_docs")
        .update({ active: false })
        .eq("id", docId)
        .eq("active", true)
        .select("id");
      if (rmErr) throw rmErr;
      return jsonResponse(
        { ok: true, docsRemoved: removed?.length ?? 0 },
        200,
        cors,
      );
    }

    if (action === "clear") {
      const { data: removed, error: clErr } = await supabase
        .from("knowledge_docs")
        .update({ active: false })
        .eq("source", "vault")
        .eq("active", true)
        .select("id");
      if (clErr) throw clErr;
      return jsonResponse(
        { ok: true, docsRemoved: removed?.length ?? 0 },
        200,
        cors,
      );
    }

    // --- Default: ingest a page of notes (+ optional refresh removal). ---
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

        // Spend guard, write-time. Embeddings cost $0.02 per million tokens —
        // indexing a two-million-word Obsidian vault is four cents — so this is
        // metered purely so the owner screen has no blind spot, and it carries
        // no role floor or daily count of its own (this function is already
        // supervisor-plus AND vault-PIN gated, a stricter gate than any limit
        // here). The company ceiling still applies.
        const gate = await reserveAiSpend(supabase, {
          userId,
          functionName: "ingest-knowledge",
        });
        if (gate.alert) {
          await notifyOwnersOfSpend(gate.alert, gate.alertProfileIds, {
            supabaseUrl: SUPABASE_URL,
            serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
          });
        }
        if (!gate.allowed) {
          return jsonResponse(
            {
              ok: false,
              limited: true,
              limit_reason: gate.reason,
              note: "The company's monthly AI budget is used up, so indexing stopped here. Raise the ceiling on the AI spend screen and run the sync again — notes already indexed are kept.",
              docsAdded,
              docsUpdated,
              docsUnchanged,
              chunks: chunkCount,
            },
            200,
            cors,
          );
        }

        let embedTokens = 0;
        const vectors = await embed(batch.map((c) => c.content), (u) => {
          embedTokens += u.inputTokens ?? 0;
        });
        await settleAiSpend(
          supabase,
          gate.reservationId,
          { inputTokens: embedTokens, outputTokens: 0 },
          "text-embedding-3-small",
        );
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
