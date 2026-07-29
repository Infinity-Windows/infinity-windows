#!/usr/bin/env node
// Tests for scripts/lib/supabase-key.mjs. Dependency-free and offline: the
// fetch wrapper is checked against a stub, so nothing here needs a key, a
// network, or an install step.

import assert from "node:assert/strict";
import {
  apiKeyOnlyFetch,
  explainError,
  isNewFormatKey,
  keyFormatLabel,
  projectRef,
  publishableKeyRefusal,
  readCredential,
} from "./lib/supabase-key.mjs";

const SECRET = "sb_secret_example";
const PUBLISHABLE = "sb_publishable_example";
const LEGACY = "eyJhbGciOiJIUzI1NiJ9.example.signature";

// --- key classification ------------------------------------------------------

assert.equal(isNewFormatKey(SECRET), true);
assert.equal(isNewFormatKey(PUBLISHABLE), true);
assert.equal(isNewFormatKey(LEGACY), false);

assert.match(keyFormatLabel(SECRET), /secret key/);
assert.match(keyFormatLabel(PUBLISHABLE), /publishable key/);
assert.match(keyFormatLabel(LEGACY), /legacy JWT/);
assert.match(keyFormatLabel("garbage"), /unrecognised/);

// A label must never expose the key it describes.
for (const key of [SECRET, PUBLISHABLE, LEGACY]) {
  assert.equal(keyFormatLabel(key).includes("example"), false);
}

// --- credentials are read without stray whitespace ---------------------------

assert.deepEqual(readCredential(SECRET), { value: SECRET, trimmed: false });
// A trailing newline is what a paste into the GitHub secrets box leaves behind.
assert.deepEqual(readCredential(`${SECRET}\n`), { value: SECRET, trimmed: true });
assert.deepEqual(readCredential(`  ${SECRET}  `), { value: SECRET, trimmed: true });
assert.deepEqual(readCredential(undefined), { value: "", trimmed: false });
// A trimmed key must still classify correctly.
assert.equal(isNewFormatKey(readCredential(`${SECRET}\n`).value), true);

// --- project ref parsing -----------------------------------------------------

assert.equal(projectRef("https://czprjcskmzzagdztqonm.supabase.co"), "czprjcskmzzagdztqonm");
assert.equal(projectRef("  https://czprjcskmzzagdztqonm.supabase.co/  "), "czprjcskmzzagdztqonm");
assert.equal(projectRef("https://jvsyhtarnvmdilsgksdi.supabase.co"), "jvsyhtarnvmdilsgksdi");
assert.equal(projectRef("not a url"), null);

// --- publishable key is refused ----------------------------------------------

assert.equal(publishableKeyRefusal(SECRET), null);
assert.equal(publishableKeyRefusal(LEGACY), null);
const refusal = publishableKeyRefusal(PUBLISHABLE);
assert.match(refusal, /sb_secret_/);
assert.equal(refusal.includes("example"), false);

// --- the fetch wrapper strips Authorization and keeps apikey -----------------

let seen = null;
const stub = (input, init) => {
  seen = { input, headers: init.headers };
  return Promise.resolve("ok");
};

const wrapped = apiKeyOnlyFetch(stub);
const result = await wrapped("https://example.supabase.co/rest/v1/window_types", {
  headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}`, Accept: "application/json" },
});

assert.equal(result, "ok");
assert.equal(seen.headers.has("authorization"), false, "Authorization must be removed");
assert.equal(seen.headers.get("apikey"), SECRET, "apikey must survive");
assert.equal(seen.headers.get("accept"), "application/json", "other headers must survive");

// Called with no init at all, it must not throw.
seen = null;
await wrapped("https://example.supabase.co/rest/v1/window_types");
assert.equal(seen.headers.has("authorization"), false);

// --- error messages are actionable and leak nothing --------------------------

const explained = explainError("Invalid API key", {
  url: "https://czprjcskmzzagdztqonm.supabase.co",
  key: SECRET,
});
assert.match(explained, /czprjcskmzzagdztqonm/, "names the project actually contacted");
assert.match(explained, /secret key/, "names the key format used");
assert.match(explained, /different Supabase project/, "suggests the likely cause");
assert.equal(explained.includes("example"), false, "must not echo the key");

// A non-credential error should not be blamed on the key.
const other = explainError('relation "window_types" does not exist', {
  url: "https://czprjcskmzzagdztqonm.supabase.co",
  key: LEGACY,
});
assert.match(other, /does not exist/);
assert.equal(other.includes("different Supabase project"), false);

console.log("scripts/lib/supabase-key.mjs: all assertions passed");
