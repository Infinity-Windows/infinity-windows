// "Are we both looking at the same app?" — answered as one comparable string.
//
// THE PROBLEM. Two people work on this app from two machines. Twice now they
// have spent hours disagreeing about what the app does, because they were not
// looking at the same thing: once a stale service worker served a months-old
// bundle, and once each person's `.env` pointed at a different Supabase project
// so every write landed somewhere the other could never see. In both cases the
// screen looked completely normal. Nothing in the app said which code it was
// running or which database it was talking to, so "it works for me" and "it's
// broken for me" were both true and neither could be checked.
//
// THE FIX. Two facts decide whether two people see the same app: the COMMIT
// their bundle was built from, and the DATABASE it is reading. Everything here
// reduces those to one short string. If both people read the same string aloud,
// they are looking at the same app; if not, the string says which half differs.
//
// Deliberately not a version number. A version has to be maintained and can be
// wrong; a commit sha is derived from the code itself and cannot be.
//
// Pure and browser-free: every branch (released build, local build, dirty tree,
// wrong database, offline) is a plain function of strings, so all of it is
// unit-testable without a browser, a service worker, or a network.

import { checkProject, EXPECTED_PROJECT_REF } from "./supabaseProject";

/** Where a bundle came from. */
export type BuildKind =
  /** Built by CI from a commit — what the published site serves. */
  | "released"
  /** Built on someone's machine by `npm run dev` or `npm run build`. */
  | "local"
  /** Build id missing or unrecognisable. */
  | "unknown";

export interface ParsedBuildId {
  kind: BuildKind;
  /**
   * Short commit sha this bundle was built from, or null when the build id
   * doesn't carry one (an older local build stamped with a timestamp).
   */
  commit: string | null;
  /** Built from a working tree with uncommitted edits. */
  dirty: boolean;
  raw: string;
}

/** How the running bundle relates to the one published on the live site. */
export type Freshness =
  /** Running exactly what the live site serves. */
  | { status: "current" }
  /** A released build, but not the published one — a refresh will fix it. */
  | { status: "stale"; published: string }
  /** A local build. Comparing it to the published one means nothing. */
  | { status: "local" }
  /** Offline, or the check failed. Not knowing is not a problem. */
  | { status: "unknown" };

export interface IdentityFacts {
  /** Build id compiled into the running bundle (`BUILD_ID`). */
  runningBuildId: string;
  /** Supabase URL the app is configured with. */
  supabaseUrl: string | null | undefined;
  /** Build id the live site reports, or null when we could not ask. */
  publishedBuildId: string | null;
  /** Which project counts as the shared one. Injectable for tests. */
  expectedRef?: string;
}

export interface IdentitySummary {
  build: ParsedBuildId;
  database: {
    /** Project ref in use, or null when there isn't a recognisable one. */
    ref: string | null;
    /** True when it is the shared project everyone else is on. */
    shared: boolean;
    expected: string;
  };
  freshness: Freshness;
  /**
   * The one line to compare with the other person. Same string means same code
   * and same data — a local build and the published build of the same commit
   * deliberately produce the SAME fingerprint, because they are the same app.
   */
  fingerprint: string;
  verdict: {
    tone: "ok" | "warn" | "info";
    label: string;
    hint: string;
  };
}

const SHA = /^[0-9a-f]{7,40}$/i;

/**
 * Pull the commit (and whether the tree was dirty) out of a build id.
 *
 * Three shapes exist in the wild: a bare commit sha from CI, `dev-g<sha>` or
 * `dev-g<sha>-dirty` from a local build, and `dev-<timestamp>` from local
 * builds made before the commit was recorded. Anything else reads as unknown
 * rather than throwing — a build id is diagnostic information and must never
 * break a page.
 *
 * The `g` prefix (as in `git describe`) is what separates a local commit from a
 * local timestamp, and it is not decoration: a millisecond timestamp is thirteen
 * decimal digits, and decimal digits are also valid hex, so `dev-1753822000000`
 * would otherwise be read as the commit `1753822`. Displaying a timestamp as a
 * commit would be worse than showing nothing, because two people could compare
 * fingerprints that look like code identities and are not.
 */
export function parseBuildId(raw: string | null | undefined): ParsedBuildId {
  const value = (raw ?? "").trim();
  if (!value) return { kind: "unknown", commit: null, dirty: false, raw: "" };

  if (value.startsWith("dev-")) {
    let rest = value.slice(4);
    let dirty = false;
    if (rest.endsWith("-dirty")) {
      dirty = true;
      rest = rest.slice(0, -"-dirty".length);
    }
    const sha = rest.startsWith("g") ? rest.slice(1) : null;
    return {
      kind: "local",
      commit: sha && SHA.test(sha) ? sha.slice(0, 7).toLowerCase() : null,
      dirty,
      raw: value,
    };
  }

  if (SHA.test(value)) {
    return {
      kind: "released",
      commit: value.slice(0, 7).toLowerCase(),
      dirty: false,
      raw: value,
    };
  }

  return { kind: "unknown", commit: null, dirty: false, raw: value };
}

/**
 * Is the running bundle the published one?
 *
 * Only meaningful for a released build. A local build is never "behind" — it is
 * simply not the published artefact — and an unknown published id means we are
 * offline, which on a job site is the normal case and not worth a warning.
 */
export function compareToPublished(
  build: ParsedBuildId,
  publishedBuildId: string | null,
): Freshness {
  if (build.kind === "local") return { status: "local" };
  if (!publishedBuildId || build.kind === "unknown") return { status: "unknown" };
  if (publishedBuildId === build.raw) return { status: "current" };
  const published = parseBuildId(publishedBuildId);
  return { status: "stale", published: published.commit ?? publishedBuildId };
}

/**
 * The comparable string. Code identity first, then database, because those are
 * the only two things that decide whether two people see the same app.
 *
 * `+edits` is load-bearing: two people can sit on the same commit and still see
 * different behaviour because one of them has uncommitted work. That is a
 * genuine difference and the fingerprint has to show it.
 */
export function fingerprint(
  build: ParsedBuildId,
  databaseRef: string | null,
): string {
  const code = build.commit
    ? `${build.commit}${build.dirty ? "+edits" : ""}`
    : build.raw || "unknown";
  return `${code} · ${databaseRef ?? "no database"}`;
}

/**
 * Everything the Settings panel needs, and the one line worth comparing.
 *
 * The verdict is ordered by how badly each problem misleads people. A wrong
 * database outranks a stale build: an old bundle makes someone see yesterday's
 * features, which is annoying but self-correcting, whereas the wrong database
 * makes their work land where nobody else will ever see it — the failure that
 * cost this project weeks.
 */
export function buildIdentity(facts: IdentityFacts): IdentitySummary {
  const expected = facts.expectedRef ?? EXPECTED_PROJECT_REF;
  const build = parseBuildId(facts.runningBuildId);
  const check = checkProject(facts.supabaseUrl, expected);
  const ref = check.status === "ok" || check.status === "mismatch" ? check.ref : null;
  const shared = check.status === "ok";
  const freshness = compareToPublished(build, facts.publishedBuildId);

  return {
    build,
    database: { ref, shared, expected },
    freshness,
    fingerprint: fingerprint(build, ref),
    verdict: verdictFor(build, check.status, shared, freshness, expected),
  };
}

function verdictFor(
  build: ParsedBuildId,
  status: ReturnType<typeof checkProject>["status"],
  shared: boolean,
  freshness: Freshness,
  expected: string,
): IdentitySummary["verdict"] {
  if (status === "mismatch") {
    return {
      tone: "warn",
      label: "Different database",
      hint: `This app is reading a different database from everyone else, so your work will not show up for them. Copy app/.env.example to app/.env and restart. Expected ${expected}.`,
    };
  }
  if (status === "unset") {
    return {
      tone: "warn",
      label: "No database configured",
      hint: "Copy app/.env.example to app/.env and restart the dev server.",
    };
  }
  if (freshness.status === "stale") {
    return {
      tone: "warn",
      label: "Not the published build",
      hint: `The live site is serving ${freshness.published}. Refresh to catch up.`,
    };
  }
  if (build.dirty) {
    return {
      tone: "info",
      label: "Local build with uncommitted changes",
      hint: "You have edits that nobody else has. Expect this app to behave differently from theirs until you push them.",
    };
  }
  if (build.kind === "local") {
    return {
      tone: "info",
      label: build.commit ? `Local build of ${build.commit}` : "Local build",
      hint: shared
        ? "Running your own build against the shared database. Anyone on the same commit sees the same app."
        : "Running your own build.",
    };
  }
  if (freshness.status === "current") {
    return {
      tone: "ok",
      label: "Up to date",
      hint: "You are running the published app against the shared database.",
    };
  }
  return {
    tone: "info",
    label: "Can't check for updates",
    hint: "Offline, so we can't tell whether a newer build has been published. The app still works.",
  };
}
