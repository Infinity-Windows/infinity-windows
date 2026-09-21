import { readDictationBody, DICTATION_MAX_BYTES } from "../../../../supabase/functions/_shared/dictation";
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function harness(options: { auth?: boolean; partner?: boolean; active?: boolean; revoked?: boolean; retired?: boolean; readable?: boolean; enrichmentFails?: boolean; transcriptionFails?: boolean; deferred?: boolean; role?: string; createdBy?: string } = {}) {
  let handler!: (req: Request) => Promise<Response>;
  const updates: { table: string; values: Record<string, unknown>; id?: string }[] = [];
  const tasks: Promise<unknown>[] = [];
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const attachment = { id: "saved-audio", kind: "voice_memo", storage_path: "install-media/crew/actual.mp4", install_event_id: "actual-event", transcribed_at: null, created_by: options.createdBy ?? "crew" };
  function from(table: string) {
    let values: Record<string, unknown> | undefined, id: string | undefined;
    const query = {
      select: () => query,
      update: (patch: Record<string, unknown>) => { values = patch; return query; },
      eq: (column: string, value: string) => { if (column === "id") id = value; return query; },
      limit: () => query,
      single: () => query,
      maybeSingle: () => query,
      then: (resolve: (result: unknown) => void) => {
        if (values) { updates.push({ table, values, id }); return Promise.resolve(resolve({ data: null, error: null })); }
        const data = table === "profiles" ? { id: "crew", role: options.role ?? "foreman", active: options.active ?? true, is_partner: options.partner, access_revoked_at: options.revoked ? "2026-09-21" : null, retired_at: options.retired ? "2026-09-21" : null }
          : table === "attachments" ? id ? options.readable === false ? null : attachment : []
          : { difficulty: "Installer's own words", quality_grade: 4 };
        return Promise.resolve(resolve({ data, error: null }));
      },
    };
    return query;
  }
  const download = vi.fn(async () => ({ data: new Blob(["synthetic audio"], { type: "audio/mp4" }), error: null }));
  const client = { from, storage: { from: () => ({ download }) } };
  const whisper = vi.fn(async () => { if (options.transcriptionFails) throw new Error("provider unavailable"); return "Installed four windows."; });
  const settle = vi.fn(), release = vi.fn(), report = vi.fn();
  const enrich = vi.fn(async () => {
    if (options.deferred) await gate;
    if (options.enrichmentFails) throw new Error("optional AI unavailable");
    return { difficulty: "AI suggestion", went_well: "All four fit.", suggested_grade: 5 };
  });
  let source = readFileSync(new URL("../../../../supabase/functions/transcribe-install-memo/index.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("handler.ts", source, ts.ScriptTarget.Latest, true);
  for (const node of [...parsed.statements].reverse()) if (ts.isImportDeclaration(node)) source = source.slice(0, node.pos) + source.slice(node.end);
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  vm.runInNewContext(code, {
    Response, Request, Blob, File, FormData, AbortSignal, console, readDictationBody, DICTATION_MAX_BYTES,
    Deno: { serve: (fn: typeof handler) => { handler = fn; } },
    EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => tasks.push(promise) },
    withSentry: (_: string, fn: typeof handler) => fn,
    verifyCaller: async () => options.auth === false ? { status: "unauthorized" } : { status: "ok", user: { id: "crew" } },
    createClient: () => client, callerSupabaseClient: () => client,
    corsHeaders: () => ({}), jsonResponse: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "fixture", ANTHROPIC_MODEL: "fixture",
    whisperTranscribe: whisper, requireAnthropic: () => {}, anthropicChatJson: enrich,
    reserveAiSpend: async () => ({ allowed: true, reservationId: "reservation" }),
    settleAiSpend: settle, releaseAiSpend: release, notifyOwnersOfSpend: async () => {},
    reportCaughtError: report, UNEXPECTED_ERROR: "Please try again.", bytesToBase64: () => "fixture",
  });
  return {
    run: (body: unknown = { attachment_id: "saved-audio" }) => handler(new Request("https://example.invalid", { method: "POST", body: body instanceof FormData ? body : JSON.stringify(body) })),
    updates, download, whisper, enrich, settle, release, report, finish,
    background: () => Promise.all(tasks),
  };
}

describe("install memo endpoint", () => {
  it("allows a signed-in installer to transcribe after leaving the site", async () => {
    const h = harness({ role: "installer", active: false });
    expect((await h.run()).status).toBe(200); await h.background();
    expect(h.whisper).toHaveBeenCalledTimes(1);
    expect(h.updates.some(x => x.values.transcript === "Installed four windows.")).toBe(true);
  });
  it("accepts an uploader's normalized WAV while leaving the original recording untouched", async () => {
    const h=harness({role:"installer"}), body=new FormData();body.append("attachment_id","saved-audio");body.append("transcription_audio",new Blob(["PCM audio"],{type:"audio/wav"}),"memo.wav");
    expect((await h.run(body)).status).toBe(200); await h.background();
    expect(h.download).not.toHaveBeenCalled();expect(h.whisper.mock.calls[0]).toHaveLength(3);
    expect(h.updates.every(x=>!("storage_path" in x.values))).toBe(true);
  });
  it("refuses another installer's replacement speech audio before spending", async () => {
    const h=harness({role:"installer",createdBy:"another-installer"}), body=new FormData();body.append("attachment_id","saved-audio");body.append("transcription_audio",new Blob(["PCM audio"],{type:"audio/wav"}),"memo.wav");
    expect((await h.run(body)).status).toBe(403);expect(h.whisper).not.toHaveBeenCalled();
  });

  it("saves and returns the words before optional enrichment finishes", async () => {
    const h = harness({ deferred: true }); const response = await h.run();
    expect(response.status).toBe(200); expect((await response.json()).transcript).toBe("Installed four windows.");
    expect(h.updates.map(x => x.values)).toEqual([{ transcript_raw: "Installed four windows." }, { transcript: "Installed four windows.", transcribed_at: expect.any(String) }]);
    expect(h.settle).not.toHaveBeenCalled(); h.finish(); await h.background();
    expect(h.updates.at(-1)?.values).toEqual({ went_well: "All four fit." });
    expect(h.settle).toHaveBeenCalledTimes(1);
  });
  it("keeps the transcript and settles transcription cost when optional analysis fails", async () => {
    const h = harness({ enrichmentFails: true }); expect((await h.run()).status).toBe(200); await h.background();
    expect(h.updates).toHaveLength(2); expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.settle).toHaveBeenCalledTimes(1); expect(h.release).not.toHaveBeenCalled();
  });
  it("does not mark a failed speech request as transcribed", async () => {
    const h = harness({ transcriptionFails: true }); expect((await h.run()).status).toBe(500);
    expect(h.updates).toHaveLength(0); expect(h.release).toHaveBeenCalledTimes(1);
  });
  it("uses the saved attachment instead of a caller's forged storage path and event", async () => {
    const h = harness(); await h.run({ record: { id: "saved-audio", storage_path: "private/stolen.mp4", install_event_id: "other-event", kind: "voice_memo" } }); await h.background();
    expect(h.download).toHaveBeenCalledWith("crew/actual.mp4");
    expect(h.updates.filter(x => x.table === "install_events").every(x => x.id === "actual-event")).toBe(true);
  });
  for (const [options, status] of [[{ auth: false }, 401], [{ partner: true }, 403], [{ revoked: true }, 403], [{ retired: true }, 403], [{ readable: false }, 200]] as const)
    it(`does not send audio for inaccessible callers/records: ${JSON.stringify(options)}`, async () => {
      const h = harness(options); expect((await h.run()).status).toBe(status); expect(h.whisper).not.toHaveBeenCalled(); expect(h.updates).toHaveLength(0);
    });
});
