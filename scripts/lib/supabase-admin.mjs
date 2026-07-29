// The Supabase client the root scripts (vault-sync, weekly-report) use. Kept
// apart from supabase-key.mjs so the logic there stays dependency-free and
// testable; this file is the only part that needs @supabase/supabase-js.

import { createClient } from "@supabase/supabase-js";
import { apiKeyOnlyFetch, isNewFormatKey } from "./supabase-key.mjs";

/**
 * An admin client that works with either key style: a new-format secret key
 * (`sb_secret_…`) or a legacy service-role JWT (`eyJ…`). See supabase-key.mjs
 * for why new-format keys need the Authorization header removed.
 */
export function createAdminClient(url, key) {
  const options = { auth: { persistSession: false } };
  if (isNewFormatKey(key)) {
    options.global = { fetch: apiKeyOnlyFetch(fetch) };
  }
  return createClient(url, key, options);
}
