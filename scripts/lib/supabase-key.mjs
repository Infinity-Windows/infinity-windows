// Pure helpers for talking to Supabase from the root scripts. No dependencies,
// so this can be tested with plain `node` and no install step.
//
// Why any of this is needed: Supabase's new-format API keys (`sb_secret_…`) are
// not JWTs, and the API rejects them outright if they arrive in an
// `Authorization: Bearer` header — they belong only in the `apikey` header.
// supabase-js knows this, but as of 2.111.0 it only applies the rule to Edge
// Function calls; every database query still gets the Bearer fallback. So a
// perfectly valid `sb_secret_` key fails with a bare "Invalid API key" and
// nothing tells you why.

const SECRET_PREFIX = "sb_secret_";
const PUBLISHABLE_PREFIX = "sb_publishable_";

export function isNewFormatKey(key) {
  return key.startsWith(SECRET_PREFIX) || key.startsWith(PUBLISHABLE_PREFIX);
}

/** A human label for a key's *format*. Never includes any of the key itself. */
export function keyFormatLabel(key) {
  if (key.startsWith(SECRET_PREFIX)) return "new-format secret key (sb_secret_…)";
  if (key.startsWith(PUBLISHABLE_PREFIX)) {
    return "new-format publishable key (sb_publishable_…)";
  }
  if (key.startsWith("eyJ")) return "legacy JWT key (eyJ…)";
  return "unrecognised key format";
}

/** The project a URL points at, e.g. https://abc.supabase.co -> "abc". */
export function projectRef(url) {
  const match = /^https?:\/\/([a-z0-9]+)\.supabase\./i.exec(url.trim());
  return match ? match[1] : null;
}

/**
 * Refuse a publishable key up front. It looks close enough to a secret key to
 * paste by mistake, but it respects row-level security, so these scripts would
 * silently read nothing instead of failing.
 */
export function publishableKeyRefusal(key) {
  if (!key.startsWith(PUBLISHABLE_PREFIX)) return null;
  return [
    "This is a publishable key (sb_publishable_…), which cannot read the whole database.",
    "Use a secret key (sb_secret_…) from Project Settings > API Keys instead.",
  ].join(" ");
}

/**
 * Wrap a fetch so the Authorization header is dropped, leaving `apikey` as the
 * only credential. Used for new-format keys, which must not be sent as Bearer
 * tokens.
 */
export function apiKeyOnlyFetch(baseFetch) {
  return (input, init = {}) => {
    const headers = new Headers(init.headers);
    headers.delete("Authorization");
    return baseFetch(input, { ...init, headers });
  };
}

/**
 * Turn a terse Supabase error into something a human can act on: which project
 * was contacted and what style of key was used, but never the key itself.
 */
export function explainError(message, { url, key }) {
  const ref = projectRef(url) ?? "unknown";
  const lines = [
    `Supabase rejected the request: ${message}`,
    `  Project contacted: ${ref}`,
    `  Key format used:   ${keyFormatLabel(key)}`,
  ];
  if (/invalid api key|jwt|unauthor/i.test(message)) {
    lines.push(
      "  The key is not valid for this project. Most likely it belongs to a",
      "  different Supabase project, or it was copied incompletely. Create a",
      `  fresh secret key in project ${ref} under Settings > API Keys.`,
    );
  }
  return lines.join("\n");
}
