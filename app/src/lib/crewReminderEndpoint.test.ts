import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Run the actual edge handler, replacing only database and push boundaries.
// This checks that claimed work is delivered and acknowledged, not just queued.
function harness(options: { count?: number; failPush?: boolean; noKeys?: boolean } = {}) {
  let handler!: (r: Request) => Promise<Response>;
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const deliveries: { endpoint: string; payload: { title: string; url: string }; ttl: number }[] = [];
  let active = 0, peak = 0;
  const source = readFileSync(new URL("../../../supabase/functions/crew-reminder-sweep/index.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("handler.ts", source, ts.ScriptTarget.Latest, true);
  let body = source;
  for (const node of [...parsed.statements].reverse())
    if (ts.isImportDeclaration(node)) body = body.slice(0, node.pos) + body.slice(node.end);
  const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const rows = Array.from({ length: options.count ?? 1 }, (_, i) => ({
    id: `notice-${i}`, profile_id: `crew-${i}`, shift_id: i % 2 ? null : "shift",
    title: "Lunch reminder", body: "Your lunch has reached 30 minutes.", url: "/clock", dedupe_key: `lunch-${i}`,
  }));
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return { data: name === "claim_crew_reminders" ? rows : null, error: null };
    },
    from: (table: string) => {
      expect(table).toBe("push_subscriptions");
      return { select: () => ({ eq: async (_column: string, profile: string) => ({
        data: [{ endpoint: `https://example.invalid/${profile}`, p256dh: "fixture", auth: "fixture" }], error: null,
      }) }) };
    },
  };
  vm.runInNewContext(code, {
    Request, Response, crypto, Error,
    Deno: { serve: (fn: typeof handler) => { handler = fn; }, env: { get: () => options.noKeys ? undefined : "fixture" } },
    createClient: () => client, withSentry: (_name: string, fn: typeof handler) => fn,
    corsHeaders: () => ({}), reportCaughtError: async () => {}, UNEXPECTED_ERROR: "Unexpected error",
    jsonResponse: (value: unknown, status = 200) => new Response(JSON.stringify(value), { status }),
    webpush: {
      setVapidDetails: () => {},
      sendNotification: async (sub: { endpoint: string }, payload: string, settings: { TTL: number }) => {
        deliveries.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), ttl: settings.TTL });
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 1)); active--;
        if (options.failPush) throw new Error("Expired subscription");
      },
    },
  });
  return { run: (method = "POST", data?: unknown) => handler(new Request("https://example.invalid", { method, body: data ? JSON.stringify(data) : undefined })), rpcCalls, deliveries, peak: () => peak };
}
describe("crew reminder delivery", () => {
  it("delivers all claimed notices with bounded concurrency and acknowledges their lease", async () => {
    const h = harness({ count: 25 });
    const response = await h.run();
    expect(await response.json()).toEqual({ claimed: 25, sent: 25 });
    expect(h.deliveries).toHaveLength(25);
    expect(h.peak()).toBeLessThanOrEqual(10);
    expect(h.peak()).toBeGreaterThan(1);
    expect(h.deliveries[0].ttl).toBe(60);
    expect(h.deliveries[1].ttl).toBe(3600);
    const lease = h.rpcCalls[0].args.p_lease;
    expect(h.rpcCalls.slice(1)).toHaveLength(25);
    for (const call of h.rpcCalls.slice(1)) {
      expect(call.name).toBe("finish_crew_reminder");
      expect(call.args).toMatchObject({ p_lease: lease, p_sent: true });
    }
  });
  it("leaves failed phone deliveries eligible for retry", async () => {
    const h = harness({ failPush: true });
    expect(await (await h.run()).json()).toEqual({ claimed: 1, sent: 0 });
    expect(h.rpcCalls[1].args.p_sent).toBe(false);
  });
  it("uses only database recipients and copy, ignoring caller-supplied content", async () => {
    const h = harness();
    await h.run("POST", { profile_id: "somebody-else", title: "Injected", url: "https://untrusted.invalid" });
    expect(h.deliveries[0]).toMatchObject({ endpoint: "https://example.invalid/crew-0", payload: { title: "Lunch reminder", url: "/clock" } });
  });
  it("does not claim work without push configuration", async () => {
    const h = harness({ noKeys: true });
    expect((await h.run()).status).toBe(503);
    expect(h.rpcCalls).toHaveLength(0);
  });
  it("rejects a read request without touching queued notices", async () => {
    const h = harness();
    expect((await h.run("GET")).status).toBe(405);
    expect(h.rpcCalls).toHaveLength(0);
  });
});
