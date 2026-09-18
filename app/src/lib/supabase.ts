import { createClient } from "@supabase/supabase-js";
import { timedFetch } from "./offline/weakSignal";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(url && key);

export const supabase = createClient(
  url ?? "http://localhost:54321",
  key ?? "anon-key-placeholder",
  {
    // Database, auth and signed-link calls get a deadline; a miss marks
    // "weak signal" and the screens fall back to their saved copy with a line
    // saying so. Photo uploads get a longer deadline; storage downloads and
    // edge functions are left alone — see
    // lib/offline/weakSignal.ts for why.
    global: { fetch: (input, init) => timedFetch(input, init) },
  },
);
