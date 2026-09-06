// The one thing that stands between a crash report and this crew's private life.
//
// This app holds installers' faces, the addresses of the houses they are
// standing in, GPS stamps accurate to a few metres, payroll truth and the notes
// they write about each other's work. An error monitor is, by construction, a
// pipe that takes whatever is lying around at the moment of a crash and posts it
// to somebody else's server. So nothing goes down that pipe until it has been
// through here.
//
// WHAT SURVIVES, and nothing else:
//   - the error's type, message and stack
//   - the release (build id) and environment
//   - the ROUTE PATTERN — /projects/:id/openings, never the real ids, never the
//     query string
//   - the tags this app sets itself: role, build, offline, and the crash code
//     the crew reads out
//
// WHAT NEVER SURVIVES:
//   - email addresses and phone numbers, wherever they appear, including inside
//     an error message
//   - latitude, longitude and accuracy
//   - anything under a key named note, notes, caption, address, display_name,
//     name, email, phone, pin, token, password or authorization — matched on
//     WORDS, so job_name and user_email go too
//   - request and response bodies, headers, cookies, and the whole `user` object
//   - stack-frame local variables, which can hold any of the above
//
// ONE IMPLEMENTATION, TWO RUNTIMES. This file lives under supabase/functions so
// the edge functions can import it directly, and the app imports it from here
// too (app/src/lib/monitoring/scrub.ts re-exports it) — the same path
// _shared/crewInvites.ts, _shared/estimate.ts and _shared/pin.ts already take.
// A copy on each side would be two scrubbers that agree on the day they are
// written, and this is not a rule that may drift. So: pure TypeScript, no Deno
// globals, no DOM, no imports — vitest tests it once and both sides get it.

/** What a redacted value is replaced with. Recognisable in a report on sight. */
export const REDACTED = "[removed]";

/**
 * Words that make a key sensitive. A key is split into words on `_`, `-`, `.`
 * and camelCase humps, so `display_name`, `jobAddress` and `crew_notes` are all
 * caught by one entry each.
 *
 * `name` is here deliberately, even though it costs us some harmless keys: a
 * crew member's name is the single most identifying thing this app holds, and
 * there is no reading of a crash report that needs it. The role tag says who
 * was affected in the only way that helps a fix.
 */
const SENSITIVE_WORDS = new Set([
  // The list the privacy rule names outright.
  "note",
  "notes",
  "caption",
  "address",
  "email",
  "phone",
  "pin",
  "token",
  "password",
  "authorization",
  "name",
  // Where a person was standing. `coords`/`position` cover the shapes the
  // browser's geolocation API hands back.
  "lat",
  "latitude",
  "lng",
  "lon",
  "longitude",
  "accuracy",
  "coords",
  "coordinates",
  "position",
  "geolocation",
  "gps",
  // Credentials by any other name.
  "auth",
  "apikey",
  "secret",
  "jwt",
  "session",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "signature",
  // Payloads. A body is the request we were making, and this app's requests
  // carry install rows, notes and photo metadata.
  "body",
  "payload",
  "headers",
  // Free text a person typed or a face they photographed.
  "message",
  "comment",
  "comments",
  "reason",
  "answer",
  "photo",
  "avatar",
  "signaturedataurl",
]);

/** Longest a scrubbed free-text string may be. */
const MAX_TEXT = 500;
/** Longest a breadcrumb message may be — there are up to a hundred of them. */
export const MAX_BREADCRUMB_TEXT = 200;
/** How deep into a nested object the walk goes before giving up. */
const MAX_DEPTH = 6;
/** How many entries of one object or array are kept. */
const MAX_ENTRIES = 50;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Ten digits with the usual separators, and a boundary at each end so a build
// id or a millisecond timestamp is not mistaken for somebody's number.
//
// The leading boundary is a CAPTURED GROUP rather than a lookbehind, and that
// is not a style choice: a regex literal with a lookbehind is a PARSE error on
// Safari before 16.4, which would white-screen the whole app on an older
// iPhone the moment this module is imported. Degrade, never crash.
const PHONE_RE =
  /(^|[^\w.])((?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})(?![\w.])/g;
// A latitude/longitude pair as it appears in a message or a URL fragment.
const COORD_PAIR_RE = /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/g;
// A JWT, and Supabase's own key shapes. Never useful in a report, always awful.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const SB_KEY_RE = /\bsb(?:p|_publishable|_secret)?_[A-Za-z0-9_-]{12,}/g;

// Anchored and NOT global: a /g regex carries lastIndex between calls, and a
// stateful test() inside a map() is a bug that only shows up on the second URL.
const UUID_SEGMENT_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Split a key into lowercase words: `display_name` and `jobName` both → name. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** True when a key's name alone is reason enough to drop its value. */
export function isSensitiveKey(key: string): boolean {
  const words = keyWords(key);
  if (words.some((w) => SENSITIVE_WORDS.has(w))) return true;
  // A single squashed word — `displayname`, `apikey`, `signaturedataurl`.
  return SENSITIVE_WORDS.has(words.join(""));
}

/**
 * Mask the things that identify a person inside free text, and cap the length.
 * The sentence itself is kept: "could not save the receipt" is the whole point
 * of the report, and only the email inside it is anybody's business.
 */
export function scrubText(text: string, max: number = MAX_TEXT): string {
  const masked = text
    .replace(JWT_RE, "[token]")
    .replace(SB_KEY_RE, "[token]")
    .replace(EMAIL_RE, "[email]")
    .replace(COORD_PAIR_RE, "[coords]")
    .replace(PHONE_RE, "$1[phone]");
  return masked.length > max ? `${masked.slice(0, max)}…` : masked;
}

/**
 * A path with its identifiers taken out: /projects/:id/openings/:id.
 *
 * Ids are dropped rather than kept because a job id plus a timestamp is a
 * house, and the fix never needs to know which one — the route is what says
 * where the code broke. A long opaque segment goes too: that is the shape the
 * GC link's own token takes, and it is a key to a customer-facing page.
 */
export function routePattern(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (UUID_SEGMENT_RE.test(seg)) return ":id";
      if (/^\d{4,}$/.test(seg)) return ":id";
      if (/^[A-Za-z0-9_-]{20,}$/.test(seg)) return ":id";
      return seg;
    })
    .join("/");
}

/**
 * A URL reduced to origin plus route pattern. The query string is dropped
 * whole — PostgREST puts the filter in it, so `?opening_id=eq.<uuid>` and
 * `?select=…,notes` both live there.
 */
export function scrubUrl(url: string): string {
  const cut = url.split("#")[0].split("?")[0];
  const m = /^([a-zA-Z][\w+.-]*:\/\/[^/]+)(\/.*)?$/.exec(cut);
  if (m) return `${m[1]}${routePattern(m[2] ?? "")}`;
  return routePattern(cut);
}

/**
 * Walk any value and return a version safe to send: sensitive keys replaced,
 * text masked and capped, depth and width bounded so a cyclic or enormous
 * object cannot turn a crash report into a data export.
 */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ENTRIES).map((v) => scrubValue(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= MAX_ENTRIES) break;
      out[k] = isSensitiveKey(k) ? REDACTED : scrubValue(v, depth + 1);
    }
    return out;
  }
  // Functions, symbols, bigints — nothing a report needs, and nothing that
  // survives JSON in a shape anybody would want.
  return REDACTED;
}

/** The parts of a monitoring event this module knows how to make safe. */
export interface ScrubbableBreadcrumb {
  type?: string;
  category?: string;
  level?: string;
  message?: string;
  timestamp?: number;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ScrubbableEvent {
  message?: string;
  transaction?: string;
  culprit?: string;
  release?: string;
  environment?: string;
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  user?: unknown;
  server_name?: string;
  request?: Record<string, unknown>;
  breadcrumbs?: ScrubbableBreadcrumb[];
  exception?: { values?: Record<string, unknown>[] };
  [key: string]: unknown;
}

/**
 * One breadcrumb, made safe. A fetch breadcrumb keeps its method, its status
 * and its route pattern — which is the whole reason breadcrumbs are worth
 * having — and loses its body, which is where the install row, the note and
 * the photo caption ride.
 */
export function scrubBreadcrumb(
  crumb: ScrubbableBreadcrumb,
): ScrubbableBreadcrumb {
  const out: ScrubbableBreadcrumb = {};
  if (crumb.type !== undefined) out.type = crumb.type;
  if (crumb.category !== undefined) out.category = crumb.category;
  if (crumb.level !== undefined) out.level = crumb.level;
  if (crumb.timestamp !== undefined) out.timestamp = crumb.timestamp;
  if (typeof crumb.message === "string") {
    out.message = scrubText(crumb.message, MAX_BREADCRUMB_TEXT);
  }

  const data = crumb.data;
  if (data && typeof data === "object") {
    const kept: Record<string, unknown> = {};
    // An allow-list, not a deny-list: a breadcrumb's data is whatever the SDK
    // or a library felt like attaching, so naming what may pass is the only
    // form of this that cannot be widened by somebody else's release.
    if (typeof data.method === "string") kept.method = data.method;
    if (typeof data.url === "string") kept.url = scrubUrl(data.url);
    // A navigation breadcrumb's from/to: the screens somebody moved between,
    // which is most of what a trail is worth. As route patterns, so the job
    // ids in them do not come along.
    if (typeof data.from === "string") kept.from = scrubUrl(data.from);
    if (typeof data.to === "string") kept.to = scrubUrl(data.to);
    if (typeof data.status_code === "number") kept.status_code = data.status_code;
    if (typeof data.status_code === "string") kept.status_code = data.status_code;
    if (Object.keys(kept).length > 0) out.data = kept;
  }
  return out;
}

/**
 * A whole event, made safe. This is what goes in beforeSend: if it throws or
 * misses something, private data leaves the phone, so it is deliberately
 * boring — delete first, keep only what is named.
 */
export function scrubEvent(event: ScrubbableEvent): ScrubbableEvent {
  const out: ScrubbableEvent = { ...event };

  // Who crashed is answered by the role tag. The user object is an email, a
  // name and an IP address, and none of the three helps anybody fix anything.
  delete out.user;
  delete out.server_name;

  if (typeof out.message === "string") out.message = scrubText(out.message);
  // The SDK names the event after wherever it happened, and "wherever" is a
  // real URL with real ids in it. Both become route patterns.
  if (typeof out.transaction === "string") out.transaction = scrubUrl(out.transaction);
  if (typeof out.culprit === "string") out.culprit = scrubUrl(out.culprit);

  if (out.request && typeof out.request === "object") {
    const req = out.request;
    const kept: Record<string, unknown> = {};
    if (typeof req.method === "string") kept.method = req.method;
    if (typeof req.url === "string") kept.url = scrubUrl(req.url);
    // data, headers, cookies, query_string, env: all gone, by omission.
    out.request = kept;
  }

  if (out.exception && Array.isArray(out.exception.values)) {
    out.exception = {
      values: out.exception.values.map((v) => {
        const value = { ...v };
        if (typeof value.value === "string") value.value = scrubText(value.value);
        const st = value.stacktrace as
          | { frames?: Record<string, unknown>[] }
          | undefined;
        if (st && Array.isArray(st.frames)) {
          // Frame LOCALS are the quiet leak: a frame inside the receipt save
          // holds the note, the photo and the address as ordinary variables.
          value.stacktrace = {
            ...st,
            frames: st.frames.map((f) => {
              const frame = { ...f };
              delete frame.vars;
              return frame;
            }),
          };
        }
        return value;
      }),
    };
  }

  if (Array.isArray(out.breadcrumbs)) {
    out.breadcrumbs = out.breadcrumbs.map(scrubBreadcrumb);
  }

  if (out.extra) out.extra = scrubValue(out.extra) as Record<string, unknown>;
  if (out.contexts) {
    out.contexts = scrubValue(out.contexts) as Record<string, unknown>;
  }
  if (out.tags) {
    // Tags are ours — role, build, offline, the crash code — so they are kept.
    // Still masked, because a tag added later by somebody in a hurry is exactly
    // how a rule like this stops being true.
    const tags: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.tags)) {
      tags[k] = typeof v === "string" ? scrubText(v, MAX_BREADCRUMB_TEXT) : v;
    }
    out.tags = tags;
  }

  return out;
}
