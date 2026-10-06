import { describe, expect, it, vi } from "vitest";
import {
  admitWorkshopConfig,
  decodeJwtClaims,
  fenceWorkshopNetwork,
  isWorkshopMode,
  workshopContentSecurityPolicy,
  workshopPageProblems,
  workshopRequestAllowed,
  WorkshopRequestRefused,
  type WorkshopConfig,
  type WorkshopEnv,
} from "./workshopIsolation";

// Every key here is synthetic — built below with a fake signature, or plainly
// made up. None of them is real.
const REF = "magcghmnbjiukidyalxd";
const OTHER = "zyxwvutsrqponmlkjihg";
const PROD = "czprjcskmzzagdztqonm";
const b64 = (o: object) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims: object) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", ...claims })}.fake-signature`;

const good: WorkshopEnv = {
  VITE_WORKSHOP_SUPABASE_REF: REF,
  VITE_SUPABASE_URL: `https://${REF}.supabase.co`,
  VITE_SUPABASE_ANON_KEY: jwt({ ref: REF, role: "anon" }),
};

function refused(env: WorkshopEnv): string {
  const a = admitWorkshopConfig(env);
  if (a.ok) throw new Error("expected a refusal");
  return a.problems.join("\n");
}

function admitted(env: WorkshopEnv = good): WorkshopConfig {
  const a = admitWorkshopConfig(env);
  if (!a.ok) throw new Error(a.problems.join("\n"));
  return a.config;
}

describe("workshop mode", () => {
  it("is switched on only by --mode workshop", () => {
    expect(isWorkshopMode("workshop")).toBe(true);
    for (const m of ["development", "production", "test", "", undefined, null]) expect(isWorkshopMode(m)).toBe(false);
  });
});

it("refuses another well-formed project even when its URL and key agree", () => {
  const other="abcdefghijklmnopqrst";
  expect(refused({VITE_WORKSHOP_SUPABASE_REF:other,VITE_SUPABASE_URL:`https://${other}.supabase.co`,VITE_SUPABASE_ANON_KEY:jwt({ref:other,role:"anon"})})).toMatch(/independently approved/);
});

describe("admitWorkshopConfig", () => {
  it("admits an exact non-production ref, URL and anon key on the workshop origin", () => {
    const c = admitted();
    expect(c).toMatchObject({ ref: REF, url: `https://${REF}.supabase.co`, keyKind: "legacy-anon-jwt", origin: "http://127.0.0.1:5278" });
    expect(c.backendOrigins).toEqual([`https://${REF}.supabase.co`, `wss://${REF}.supabase.co`, `https://${REF}.functions.supabase.co`]);
  });

  it("admits a publishable key, cross-checked by URL and ref alone", () => {
    expect(admitted({ ...good, VITE_SUPABASE_ANON_KEY: "sb_publishable_madeUpForTests_123" }).keyKind).toBe("publishable");
  });

  it("admits a local stack on its API port", () => {
    const c = admitted({
      VITE_WORKSHOP_SUPABASE_REF: "local",
      VITE_SUPABASE_URL: "http://127.0.0.1:54321",
      VITE_SUPABASE_ANON_KEY: jwt({ iss: "supabase-demo", role: "anon" }),
    });
    expect(c.backendOrigins).toEqual(["http://127.0.0.1:54321", "ws://127.0.0.1:54321"]);
  });

  it("refuses when anything is missing — nothing falls back", () => {
    expect(refused({})).toMatch(/VITE_WORKSHOP_SUPABASE_REF is not set[\s\S]*VITE_SUPABASE_URL is not set[\s\S]*VITE_SUPABASE_ANON_KEY is not set/);
    expect(refused({ ...good, VITE_WORKSHOP_SUPABASE_REF: "" })).toMatch(/REF is not set/);
    expect(refused({ ...good, VITE_SUPABASE_ANON_KEY: "  " })).toMatch(/ANON_KEY is not set/);
  });

  it("refuses production by ref, by URL, and by key", () => {
    expect(refused({ ...good, VITE_WORKSHOP_SUPABASE_REF: PROD, VITE_SUPABASE_URL: `https://${PROD}.supabase.co` })).toMatch(/production/);
    expect(refused({ ...good, VITE_SUPABASE_URL: `https://${PROD}.supabase.co` })).toMatch(/production project czprj/);
    expect(refused({ ...good, VITE_SUPABASE_ANON_KEY: jwt({ ref: PROD, role: "anon" }) })).toMatch(/production project czprj/);
    expect(refused({ ...good, VITE_WORKSHOP_SUPABASE_REF: "jvsyhtarnvmdilsgksdi" })).toMatch(/production/);
  });

  it("refuses a URL, ref and key that disagree", () => {
    expect(refused({ ...good, VITE_SUPABASE_URL: `https://${OTHER}.supabase.co` })).toMatch(/must be exactly https:\/\/magcghmnbjiukidyalxd/);
    expect(refused({ ...good, VITE_SUPABASE_ANON_KEY: jwt({ ref: OTHER, role: "anon" }) })).toMatch(/belongs to project zyxw/);
    expect(refused({ ...good, VITE_SUPABASE_ANON_KEY: jwt({ role: "anon" }) })).toMatch(/names no project/);
    expect(refused({ ...good, VITE_SUPABASE_URL: `https://${REF}.supabase.co/rest/v1` })).toMatch(/bare project URL/);
    expect(refused({ ...good, VITE_SUPABASE_URL: `http://${REF}.supabase.co` })).toMatch(/must be exactly/);
  });

  it("refuses service-role, secret, undecodable and unknown keys without echoing them", () => {
    expect(refused({ ...good, VITE_SUPABASE_ANON_KEY: jwt({ ref: REF, role: "service_role" }) })).toMatch(/service-role/);
    const secret = refused({ ...good, VITE_SUPABASE_ANON_KEY: "sb_secret_madeUpSecretValue" });
    expect(secret).toMatch(/secret key/);
    expect(secret).not.toContain("madeUpSecretValue");
    expect(refused({ ...good, VITE_SUPABASE_ANON_KEY: "eyJnot.a.jwt" })).toMatch(/does not decode/);
    expect(refused({ ...good, VITE_SUPABASE_ANON_KEY: "anon-key-placeholder" })).toMatch(/not a recognised/);
  });

  it("refuses a hosted key on the local stack", () => {
    expect(
      refused({ VITE_WORKSHOP_SUPABASE_REF: "local", VITE_SUPABASE_URL: "http://127.0.0.1:54321", VITE_SUPABASE_ANON_KEY: jwt({ ref: OTHER, role: "anon" }) }),
    ).toMatch(/hosted project/);
    expect(refused({ ...good, VITE_WORKSHOP_SUPABASE_REF: "local", VITE_SUPABASE_URL: "http://127.0.0.1:5278" })).toMatch(/local stack/);
  });

  it("refuses an origin shared with the live app or the normal dev server", () => {
    expect(refused({ ...good, VITE_WORKSHOP_ORIGIN: "https://app.forgewd.com" })).toMatch(/live app's/);
    expect(refused({ ...good, VITE_WORKSHOP_ORIGIN: "https://infinity-windows.github.io" })).toMatch(/live app's/);
    expect(refused({ ...good, VITE_WORKSHOP_ORIGIN: "http://localhost:5173" })).toMatch(/normal dev app's/);
    expect(refused({ ...good, VITE_WORKSHOP_ORIGIN: "http://192.168.1.5:5278" })).toMatch(/loopback/);
  });
});

describe("decodeJwtClaims", () => {
  it("reads claims without verifying, and gives up on garbage", () => {
    expect(decodeJwtClaims(jwt({ ref: REF, role: "anon" }))).toMatchObject({ ref: REF, role: "anon" });
    expect(decodeJwtClaims("a.b")).toBeNull();
    expect(decodeJwtClaims("a.%%%.c")).toBeNull();
  });
});

describe("the workshop's network fence", () => {
  const config = admitted();
  const page = config.origin;

  it("allows the page's own origin, hot reload, blobs and the staged backend", () => {
    for (const u of [
      "/version.json",
      `${page}/assets/index.js`,
      "ws://127.0.0.1:5278/",
      "blob:http://127.0.0.1:5278/1",
      `https://${REF}.supabase.co/rest/v1/jobs`,
      `wss://${REF}.supabase.co/realtime/v1/websocket`,
      `https://${REF}.functions.supabase.co/x`,
    ]) expect(workshopRequestAllowed(u, config, page), u).toBe(true);
  });

  it("refuses production Supabase, production sites, other projects and other hosts", () => {
    for (const u of [
      `https://${PROD}.supabase.co/rest/v1/jobs`,
      `wss://${PROD}.supabase.co/realtime/v1/websocket`,
      `https://${PROD}.functions.supabase.co/x`,
      "https://app.forgewd.com/version.json",
      "https://infinity-windows.github.io/infinity-windows/version.json",
      `https://${OTHER}.supabase.co/rest/v1/jobs`,
      "http://localhost:5173/",
      "https://api.monday.com/v2",
    ]) expect(workshopRequestAllowed(u, config, page), u).toBe(false);
  });

  it("refuses production through fetch, XHR, WebSocket, EventSource and sendBeacon", async () => {
    const realFetch = vi.fn(async () => new Response("ok"));
    const open = vi.fn();
    class FakeSocket {
      url: string;
      constructor(url: string) {
        this.url = url;
      }
    }
    const beacon = vi.fn((_url: string | URL, _data?: unknown) => true);
    const target = {
      fetch: realFetch as unknown as typeof fetch,
      location: { origin: page },
      XMLHttpRequest: { prototype: { open } },
      WebSocket: FakeSocket,
      EventSource: FakeSocket,
      navigator: { sendBeacon: beacon },
    };
    const fenced = fenceWorkshopNetwork(target, config);
    const prod = `https://${PROD}.supabase.co/rest/v1/jobs`;

    await expect(target.fetch(prod)).rejects.toBeInstanceOf(WorkshopRequestRefused);
    await expect(fenced(new Request(prod))).rejects.toThrow(/blocked a request to czprjcskmzzagdztqonm\.supabase\.co/);
    expect(realFetch).not.toHaveBeenCalled();
    expect(() => target.XMLHttpRequest.prototype.open("GET" as never, prod as never)).toThrow(WorkshopRequestRefused);
    expect(open).not.toHaveBeenCalled();
    expect(() => new (target.WebSocket as typeof FakeSocket)(`wss://${PROD}.supabase.co/realtime/v1`)).toThrow(WorkshopRequestRefused);
    expect(() => new (target.EventSource as typeof FakeSocket)("https://app.forgewd.com/events")).toThrow(WorkshopRequestRefused);
    expect(target.navigator.sendBeacon("https://app.forgewd.com/beacon")).toBe(false);
    expect(beacon).not.toHaveBeenCalled();

    // The staged backend and the page itself still get through.
    await target.fetch(`https://${REF}.supabase.co/rest/v1/jobs`);
    await target.fetch("/version.json");
    expect(realFetch).toHaveBeenCalledTimes(2);
    expect(new (target.WebSocket as typeof FakeSocket)(`wss://${REF}.supabase.co/realtime/v1`)).toBeInstanceOf(FakeSocket);
  });

  it("restricts the browser's connect-src to the page and the staged backend", () => {
    const csp = workshopContentSecurityPolicy(config);
    expect(csp).toBe(
      `connect-src 'self' ws://127.0.0.1:5278 https://${REF}.supabase.co wss://${REF}.supabase.co https://${REF}.functions.supabase.co blob: data:`,
    );
    expect(csp).not.toContain(PROD);
  });

  it("refuses to run on any page origin but the workshop's", () => {
    expect(workshopPageProblems("http://127.0.0.1:5278", config)).toEqual([]);
    expect(workshopPageProblems("http://localhost:5173", config)).toHaveLength(1);
    expect(workshopPageProblems("https://app.forgewd.com", config)).toHaveLength(1);
  });
});
