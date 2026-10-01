import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://infinity-windows.github.io";
type Handler = (request: Request) => Promise<Response>;

// Run the actual endpoint and actual response helpers; stub external boundaries.
function harness(options: { token?: boolean; auth?: string; role?: string; crash?: boolean } = {}) {
  let handler!: Handler;
  let downloads = 0;
  const stored: unknown[] = [];
  const env = { get: (key: string) => key === "MONDAY_API_TOKEN" && options.token === false ? undefined : "fixture" };
  const helpers: Record<string, unknown> = {};
  const helperSource = readFileSync(new URL("../../../supabase/functions/_shared/openai.ts", import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(helperSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: helpers, Deno: { env }, Response });
  const source = readFileSync(new URL("../../../supabase/functions/monday-sync/index.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("handler.ts", source, ts.ScriptTarget.Latest, true);
  let body = source;
  for (const node of [...parsed.statements].reverse()) {
    if (ts.isImportDeclaration(node)) body = body.slice(0, node.pos) + body.slice(node.end);
  }
  const asset = { id: "asset", name: "SR - LP.pdf", file_extension: "pdf", file_size: 3, public_url: "https://example.invalid/file" };
  const client = {
    from: (table: string) => {
      const chain = {
        select: () => chain, eq: () => chain,
        maybeSingle: async () => ({ data: table === "profiles" ? { role: options.role ?? "foreman" }
          : table === "monday_jobs" ? { id: "monday-job", project_id: "project", monday_item_id: "item" } : null, error: null }),
        insert: async (row: unknown) => { stored.push(row); return { error: null }; },
      };
      return chain;
    },
    storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) },
  };
  const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  vm.runInNewContext(code, {
    Request, Response, Headers, Uint8Array, crypto, console,
    Deno: { env, serve: (fn: Handler) => { handler = fn; } }, ...helpers,
    createClient: () => client, withSentry: (_name: string, fn: Handler) => fn,
    verifyCaller: async () => {
      if (options.crash) throw new Error("fixture auth unavailable");
      return { status: options.auth ?? "ok", user: { id: "foreman", role: "authenticated" } };
    },
    FILES_COLUMN_ID: "files_1", MEASURE_COLUMN_ID: "file_mm4wnjn8",
    pullAllowList: () => ({ ok: true, files: [{ asset_id: "asset", name: asset.name }] }),
    looksLikeMoneyDocument: () => false,
    readBodyCapped: async () => new Uint8Array([1, 2, 3]),
    fetch: async (url: string, init?: RequestInit) => {
      if (url === "https://api.monday.com/v2") {
        const query = JSON.parse(String(init?.body)).query as string;
        return Response.json({ data: query.includes("assets(ids:") ? { assets: [asset] } : { items: [{ id: "item", board: { id: "8185408239" } }] } });
      }
      expect(url).toBe(asset.public_url);
      downloads++;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf" } });
    },
  });
  return {
    stored, downloads: () => downloads,
    run: (method = "POST") => handler(new Request("https://example.invalid/monday-sync", {
      method, headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      ...(method === "OPTIONS" ? {} : { body: JSON.stringify({ action: "pull_files", monday_job_id: "monday-job", project_id: "project", files: [{ asset_id: "asset", kind: "building" }] }) }),
    })),
  };
}
function expectBrowserReadable(response: Response) {
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  const allowed = response.headers.get("Access-Control-Allow-Headers") ?? "";
  for (const name of ["authorization", "apikey", "content-type", "x-client-info"]) expect(allowed).toContain(name);
}
describe("Monday Get browser transport", () => {
  it("allows preflight before Monday is configured, without fetching any file", async () => {
    const h = harness({ token: false });
    const response = await h.run("OPTIONS");
    expect(response.status).toBe(200);
    expectBrowserReadable(response);
    expect(await response.text()).toBe("ok");
    expect(h.downloads()).toBe(0);
  });
  it("pulls the selected PDF into the job and returns browser-readable success", async () => {
    const h = harness();
    const response = await h.run();
    expectBrowserReadable(response);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toMatchObject({ ok: true, results: [{ asset_id: "asset", ok: true, where: "plans" }] });
    expect(h.downloads()).toBe(1);
    expect(h.stored).toEqual([expect.objectContaining({ project_id: "project", source_asset_id: "asset", kind: "building", status: "uploaded" })]);
  });
  it.each([
    [{ token: false }, 500, "not configured"],
    [{ auth: "unauthorized" }, 401, "signed in"],
    [{ auth: "unconfigured" }, 503, "check who you are"],
    [{ role: "installer" }, 403, "foreman or above"],
    [{ crash: true }, 500, "Could not get the files"],
  ] as const)("keeps refusal %j readable without downloading", async (options, status, message) => {
    const h = harness(options);
    const response = await h.run();
    expect(response.status).toBe(status);
    expectBrowserReadable(response);
    expect((await response.json()).error).toContain(message);
    expect(h.downloads()).toBe(0);
    expect(h.stored).toEqual([]);
  });
});
