// Forge Workshop: a copy of the app that must never touch production.
//
// The workshop is this same code, on an isolated branch, pointed at a separate
// Supabase project with synthetic accounts and data. The danger it guards
// against is quiet: the app's IndexedDB names are fixed, the production URL
// and anon key sit in app/.env, and a dev server that falls back to either one
// would show workshop screens over real installers' records — or write into
// them. So workshop mode fails CLOSED. Nothing about which backend it talks to
// is defaulted, guessed or inherited; every setting is stated, cross-checked,
// and refused if it so much as names production.
//
// One implementation, three callers: vite.config.ts (refuses to start the dev
// server), lib/supabase.ts (refuses to build a client, and fences the
// browser's network), and scripts/workshop/start.mjs (refuses to launch).
// It has no imports and only erasable TypeScript, so Node 22 can load it
// directly — keep it that way, or the launcher loses its single source.

/** Every project that holds, or has held, real Forge data. Never a workshop. */
export const PRODUCTION_PROJECT_REFS: readonly string[] = [
  "czprjcskmzzagdztqonm",
  // The second project that once split the team's writes (see supabaseProject).
  "jvsyhtarnvmdilsgksdi",
];

/** Where the real app is served. A workshop must never share one of these origins. */
export const PRODUCTION_APP_ORIGINS: readonly string[] = [
  "https://app.forgewd.com",
  "https://infinity-windows.github.io",
];

/** The workshop's own port — not 5173, so its IndexedDB never meets the normal dev app's. */
export const WORKSHOP_PORT = 5278;
export const WORKSHOP_ORIGIN = `http://127.0.0.1:${WORKSHOP_PORT}`;
/** The exact project created for this workshop, independent of the env file. */
export const APPROVED_WORKSHOP_REF = "magcghmnbjiukidyalxd";

/** The normal dev server. Same reason: one origin, one set of databases. */
const NORMAL_DEV_PORT = 5173;

/** The value of `VITE_WORKSHOP_SUPABASE_REF` that means "local Supabase stack". */
export const LOCAL_REF = "local";

/** The settings workshop mode reads — all `VITE_` so the browser sees the same ones. */
export type WorkshopEnv = {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  VITE_WORKSHOP_SUPABASE_REF?: string;
  VITE_WORKSHOP_ORIGIN?: string;
};

export type WorkshopConfig = {
  ref: string;
  url: string;
  key: string;
  keyKind: "legacy-anon-jwt" | "publishable";
  origin: string;
  /** The backend's hosts the browser may reach (REST/auth/storage/realtime, functions). */
  backendOrigins: string[];
};

export type WorkshopAdmission = { ok: true; config: WorkshopConfig } | { ok: false; problems: string[] };

/** Is this build/dev server the workshop? One switch: Vite's `--mode workshop`. */
export function isWorkshopMode(mode: string | undefined | null): boolean {
  return mode === "workshop";
}

const HOSTED_REF = /^[a-z]{20}$/;

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

function decodeBase64Url(part: string): string | null {
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** The claims of a legacy (eyJ…) Supabase key, or null when it does not decode. Never verifies. */
export function decodeJwtClaims(key: string): Record<string, unknown> | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  const json = decodeBase64Url(parts[1]);
  if (json == null) return null;
  try {
    const claims: unknown = JSON.parse(json);
    return claims && typeof claims === "object" && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Why a browser key is unfit for the workshop, or null when it is fit.
 * Messages describe the key's KIND and claims only — never any of the key.
 */
function keyProblems(key: string, ref: string): { kind: WorkshopConfig["keyKind"] | null; problems: string[] } {
  if (key.startsWith("sb_secret_")) {
    return { kind: null, problems: ["The key is a secret key (sb_secret_…). A browser must only ever hold a publishable or anon key."] };
  }
  if (key.startsWith("sb_publishable_")) {
    // Publishable keys carry no project ref we can read, so the URL and the
    // stated ref are the cross-check; the backend refuses a key from elsewhere.
    return /^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(key)
      ? { kind: "publishable", problems: [] }
      : { kind: null, problems: ["The publishable key is malformed."] };
  }
  if (!key.startsWith("eyJ")) {
    return { kind: null, problems: ["The key is not a recognised Supabase browser key (expected sb_publishable_… or a legacy anon eyJ… key)."] };
  }
  const claims = decodeJwtClaims(key);
  // An undecodable legacy key cannot be shown to be an anon key for this
  // project, so it is not admitted — fail closed rather than hope.
  if (!claims) return { kind: null, problems: ["The legacy key does not decode, so it cannot be checked. Copy it again in full."] };
  const problems: string[] = [];
  if (claims.role === "service_role") {
    problems.push("The key is a service-role key. It bypasses row security and must never reach a browser.");
  } else if (claims.role !== "anon") {
    problems.push(`The legacy key's role is "${String(claims.role)}", not "anon".`);
  }
  const keyRef = typeof claims.ref === "string" ? claims.ref.toLowerCase() : null;
  if (keyRef && PRODUCTION_PROJECT_REFS.includes(keyRef)) {
    problems.push(`The key belongs to production project ${keyRef}.`);
  }
  if (ref === LOCAL_REF) {
    // The local stack's demo keys carry no ref; one that does was copied from
    // a hosted project.
    if (keyRef) problems.push(`The key belongs to hosted project ${keyRef}, not the local stack.`);
  } else if (keyRef !== ref) {
    problems.push(keyRef ? `The key belongs to project ${keyRef}, not ${ref}.` : `The key names no project, so it cannot be shown to belong to ${ref}.`);
  }
  return { kind: problems.length ? null : "legacy-anon-jwt", problems };
}

/**
 * The origin the workshop app is served from, checked. It must be loopback on
 * the workshop port: anything else either shares IndexedDB with the normal dev
 * app or is a real site.
 */
function originProblems(raw: string): string[] {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return [`The workshop origin "${raw}" is not a URL.`];
  }
  if (u.origin !== raw.replace(/\/$/, "")) return [`The workshop origin must be a bare origin, like ${WORKSHOP_ORIGIN}.`];
  const problems: string[] = [];
  if (PRODUCTION_APP_ORIGINS.includes(u.origin) || /(^|\.)forgewd\.com$/i.test(u.hostname)) {
    problems.push(`The workshop origin ${u.origin} is the live app's. Its saved data and sign-ins would mix with production.`);
  }
  if (!isLoopbackHost(u.hostname) || u.protocol !== "http:") {
    problems.push(`The workshop origin must be a loopback address (http://127.0.0.1:${WORKSHOP_PORT}).`);
  }
  if (u.port === String(NORMAL_DEV_PORT)) {
    problems.push(`Port ${NORMAL_DEV_PORT} is the normal dev app's. The workshop runs on ${WORKSHOP_PORT} so the two never share saved data.`);
  } else if (u.port !== String(WORKSHOP_PORT)) {
    problems.push(`The workshop origin must use port ${WORKSHOP_PORT}.`);
  }
  return problems;
}

/**
 * Decide whether these settings may run as the workshop. Every problem is
 * listed, not just the first, so one read of the message fixes the file.
 * Pure: no network, no globals.
 */
export function admitWorkshopConfig(env: WorkshopEnv): WorkshopAdmission {
  const problems: string[] = [];
  const url = env.VITE_SUPABASE_URL?.trim() ?? "";
  const key = env.VITE_SUPABASE_ANON_KEY?.trim() ?? "";
  const ref = env.VITE_WORKSHOP_SUPABASE_REF?.trim().toLowerCase() ?? "";
  const origin = (env.VITE_WORKSHOP_ORIGIN?.trim() || WORKSHOP_ORIGIN).replace(/\/$/, "");

  if (!ref) problems.push("VITE_WORKSHOP_SUPABASE_REF is not set. Name the workshop project's ref (or \"local\") explicitly.");
  if (!url) problems.push("VITE_SUPABASE_URL is not set.");
  if (!key) problems.push("VITE_SUPABASE_ANON_KEY is not set.");

  if (ref && PRODUCTION_PROJECT_REFS.includes(ref)) {
    problems.push(`${ref} is a production project. The workshop never connects to it.`);
  } else if (ref && ref !== LOCAL_REF && !HOSTED_REF.test(ref)) {
    problems.push(`"${ref}" is not a Supabase project ref (20 lowercase letters) or "local".`);
  } else if (ref && ref !== LOCAL_REF && ref !== APPROVED_WORKSHOP_REF) {
    problems.push("This is not the independently approved Forge workshop project.");
  }

  let namesProduction = PRODUCTION_PROJECT_REFS.includes(ref);
  for (const prod of PRODUCTION_PROJECT_REFS) {
    if (url.toLowerCase().includes(prod)) {
      problems.push(`VITE_SUPABASE_URL points at production project ${prod}.`);
      namesProduction = true;
    }
  }

  const backendOrigins: string[] = [];
  if (url && ref && !namesProduction) {
    let u: URL | null = null;
    try {
      u = new URL(url);
    } catch {
      problems.push("VITE_SUPABASE_URL is not a URL.");
    }
    if (u) {
      if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) {
        problems.push("VITE_SUPABASE_URL must be the bare project URL, with no path, query or credentials.");
      }
      if (ref === LOCAL_REF) {
        const port = Number(u.port);
        if (u.protocol !== "http:" || !isLoopbackHost(u.hostname) || !port || port === WORKSHOP_PORT || port === NORMAL_DEV_PORT) {
          problems.push("For the local stack, VITE_SUPABASE_URL must be http://127.0.0.1:<port> on the Supabase API port (usually 54321).");
        } else {
          backendOrigins.push(u.origin, `ws://${u.host}`);
        }
      } else if (u.origin !== `https://${ref}.supabase.co`) {
        problems.push(`VITE_SUPABASE_URL must be exactly https://${ref}.supabase.co for VITE_WORKSHOP_SUPABASE_REF=${ref}.`);
      } else {
        backendOrigins.push(u.origin, `wss://${u.host}`, `https://${ref}.functions.supabase.co`);
      }
    }
  }

  let keyKind: WorkshopConfig["keyKind"] | null = null;
  if (key && ref && !PRODUCTION_PROJECT_REFS.includes(ref)) {
    const k = keyProblems(key, ref);
    keyKind = k.kind;
    problems.push(...k.problems);
  }

  problems.push(...originProblems(origin));

  if (problems.length || !keyKind) {
    return { ok: false, problems: problems.length ? problems : ["The workshop settings were not admitted."] };
  }
  return { ok: true, config: { ref, url: url.replace(/\/$/, ""), key, keyKind, origin, backendOrigins } };
}

/** One readable block for a terminal or an error screen. */
export function describeRefusal(problems: readonly string[]): string {
  return [
    "Forge Workshop refused to start: its settings could reach production, or are incomplete.",
    ...problems.map((p) => `  - ${p}`),
    "Fix app/.env.workshop.local (see app/.env.workshop.example). Nothing was contacted.",
  ].join("\n");
}

/**
 * The Content-Security-Policy the workshop dev server sends. Only connect-src
 * is restricted — that is the one that covers fetch, XHR, WebSocket,
 * EventSource and sendBeacon — so the browser itself refuses any backend
 * except the staged one, whatever code asks. Pictures and embeds are left
 * alone; they cannot write.
 */
export function workshopContentSecurityPolicy(config: WorkshopConfig): string {
  const host = new URL(config.origin).host;
  // ws: for the dev server's own hot-reload socket.
  const connect = ["'self'", `ws://${host}`, ...config.backendOrigins, "blob:", "data:"];
  return `connect-src ${connect.join(" ")}`;
}

/**
 * Whether the browser may send a request to this URL while in the workshop:
 * its own origin (app, static assets, hot reload), the staged backend, and
 * local blob/data URLs. Any Supabase host but the staged one, any production
 * origin, and anything else off-box are refused.
 */
export function workshopRequestAllowed(target: string, config: WorkshopConfig, pageOrigin: string): boolean {
  let u: URL;
  try {
    u = new URL(target, pageOrigin);
  } catch {
    return false;
  }
  if (u.protocol === "blob:" || u.protocol === "data:") return true;
  const host = u.host.toLowerCase();
  if (PRODUCTION_PROJECT_REFS.some((ref) => host.includes(ref))) return false;
  if (PRODUCTION_APP_ORIGINS.includes(u.origin) || /(^|\.)forgewd\.com$/i.test(u.hostname)) return false;
  if (u.origin === pageOrigin) return true;
  if ((u.protocol === "ws:" || u.protocol === "wss:") && host === new URL(pageOrigin).host) return true;
  return config.backendOrigins.includes(u.origin) || config.backendOrigins.includes(`${u.protocol}//${u.host}`);
}

/** Thrown in place of a request the workshop refused. Says where, never with what. */
export class WorkshopRequestRefused extends Error {
  constructor(target: string) {
    let where = "an address outside the workshop";
    try {
      where = new URL(target).host;
    } catch {
      /* keep the generic wording */
    }
    super(`Forge Workshop blocked a request to ${where}. The workshop only talks to its own backend.`);
    this.name = "WorkshopRequestRefused";
  }
}

type FenceTarget = {
  fetch?: typeof fetch;
  location?: { origin: string };
  XMLHttpRequest?: { prototype: { open: (...args: never[]) => unknown } };
  WebSocket?: unknown;
  EventSource?: unknown;
  navigator?: { sendBeacon?: (url: string | URL, data?: unknown) => boolean };
};

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input) return String((input as { url: unknown }).url);
  return String(input);
}

/**
 * Fence the page's network to the workshop: fetch, XHR, WebSocket,
 * EventSource and sendBeacon all refuse what workshopRequestAllowed refuses.
 * The CSP header does the same from outside; this is the copy that still
 * holds if the page is ever served without it. Returns the fenced fetch so the
 * Supabase client can be handed it directly.
 */
export function fenceWorkshopNetwork(target: FenceTarget, config: WorkshopConfig): typeof fetch {
  const pageOrigin = target.location?.origin ?? config.origin;
  const allowed = (url: string) => workshopRequestAllowed(url, config, pageOrigin);
  const original = target.fetch?.bind(target);
  const fenced: typeof fetch = (input, init) => {
    const url = urlOf(input);
    if (!allowed(url)) return Promise.reject(new WorkshopRequestRefused(url));
    if (!original) return Promise.reject(new Error("fetch is unavailable"));
    return original(input, init);
  };
  if (target.fetch) target.fetch = fenced;

  const xhr = target.XMLHttpRequest?.prototype;
  if (xhr) {
    const open = xhr.open;
    xhr.open = function (this: unknown, ...args: never[]) {
      const url = urlOf(args[1]);
      if (!allowed(url)) throw new WorkshopRequestRefused(url);
      return (open as (...a: never[]) => unknown).apply(this, args);
    };
  }

  for (const name of ["WebSocket", "EventSource"] as const) {
    const Original = target[name] as (new (url: string | URL, ...rest: unknown[]) => object) | undefined;
    if (typeof Original !== "function") continue;
    const Fenced = function (url: string | URL, ...rest: unknown[]) {
      if (!allowed(urlOf(url))) throw new WorkshopRequestRefused(urlOf(url));
      return new Original(url, ...rest);
    } as unknown as new (url: string | URL, ...rest: unknown[]) => object;
    Object.setPrototypeOf(Fenced, Original);
    (Fenced as unknown as { prototype: unknown }).prototype = Original.prototype;
    (target as Record<string, unknown>)[name] = Fenced;
  }

  const nav = target.navigator;
  if (nav?.sendBeacon) {
    const beacon = nav.sendBeacon.bind(nav);
    nav.sendBeacon = (url, data) => (allowed(urlOf(url)) ? beacon(url, data) : false);
  }
  return fenced;
}

/**
 * Whether the page itself is somewhere the workshop may run. A workshop build
 * opened on any other origin would read and write that origin's saved data.
 */
export function workshopPageProblems(pageOrigin: string, config: WorkshopConfig): string[] {
  if (pageOrigin === config.origin) return [];
  return [`This page is open at ${pageOrigin}, but the workshop runs only at ${config.origin}.`];
}
